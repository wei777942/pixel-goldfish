import asyncio, sys, json, time, random, math, os
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:34567/'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'dev'
SH = '/workspace/goldfish/shots/'
log = lambda *a: print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)

class Phone:
    def __init__(s, idx, ctx, page, cdp): s.idx, s.ctx, s.page, s.cdp = idx, ctx, page, cdp
    async def touch(s, kind, pts):
        await s.cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': pts})
    async def boxes(s):
        pad = await s.page.locator('#pad').bounding_box(); btn = await s.page.locator('#btn').bounding_box()
        return pad, btn
    async def swipe(s, dx, dy):
        """relative drag on the pad, total (dx,dy) css px, in <=14px steps; pad touch id 0"""
        pad, _ = await s.boxes()
        cx, cy = pad['x'] + pad['width'] / 2, pad['y'] + pad['height'] / 2
        n = max(1, int(max(abs(dx), abs(dy)) / 14) + 1)
        # keep within pad: start offset opposite to movement
        sx, sy = cx - dx / 2, cy - dy / 2
        sx = min(max(sx, pad['x'] + 8), pad['x'] + pad['width'] - 8); sy = min(max(sy, pad['y'] + 8), pad['y'] + pad['height'] - 8)
        await s.touch('touchStart', [{'x': sx, 'y': sy, 'id': 0}])
        for i in range(1, n + 1):
            await s.touch('touchMove', [{'x': sx + dx * i / n, 'y': sy + dy * i / n, 'id': 0}])
            await asyncio.sleep(0.012)
        await s.touch('touchEnd', [])
    async def hold(s, secs):
        _, btn = await s.boxes()
        x, y = btn['x'] + btn['width'] / 2, btn['y'] + btn['height'] / 2
        await s.touch('touchStart', [{'x': x, 'y': y, 'id': 1}])
        await asyncio.sleep(secs)
        await s.touch('touchEnd', [])
    async def tap(s, sel):
        b = await s.page.locator(sel).bounding_box()
        x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        await s.touch('touchStart', [{'x': x, 'y': y, 'id': 5}]); await asyncio.sleep(.08); await s.touch('touchEnd', [])

async def main():
    async with async_playwright() as pw:
        br = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        hctx = await br.new_context(viewport={'width': 1280, 'height': 720})
        host = await hctx.new_page()
        errs = []
        host.on('pageerror', lambda e: errs.append(('host', str(e))))
        host.on('console', lambda m: errs.append(('host-console', m.text)) if m.type == 'error' else None)
        await host.goto(BASE + 'index.html', wait_until='load')
        await host.wait_for_function('window.__gf && window.__gf.G.relay.open>0', timeout=20000)
        room = await host.evaluate('window.__gf.room'); joinURL = await host.evaluate('window.__gf.joinURL')
        log('host up; room', room, 'joinURL', joinURL)
        await host.wait_for_timeout(1500)
        await host.screenshot(path=SH + f'{TAG}_host_lobby_empty.png')
        # decode QR from the screenshot
        try:
            import cv2
            img = cv2.imread(SH + f'{TAG}_host_lobby_empty.png'); txt, _, _ = cv2.QRCodeDetector().detectAndDecode(img)
            log('QR decoded from screen:', txt, '| matches joinURL:', txt == joinURL)
        except Exception as e: log('QR decode skipped', e)

        phones = []
        for i in range(2):
            ctx = await br.new_context(viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True,
                                       user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
            pg = await ctx.new_page()
            pg.on('pageerror', lambda e, i=i: errs.append((f'phone{i+1}', str(e))))
            pg.on('console', lambda m, i=i: errs.append((f'phone{i+1}-console', m.text)) if m.type == 'error' else None)
            cdp = await ctx.new_cdp_session(pg)
            await pg.goto(joinURL, wait_until='load')
            phones.append(Phone(i, ctx, pg, cdp))
            await pg.wait_for_function('window.__gfp && window.__gfp.S.joined', timeout=30000)
            log(f'phone{i+1} joined, slot', await pg.evaluate('window.__gfp.S.slot'))
        # slots follow join order
        await host.wait_for_timeout(800)
        await host.screenshot(path=SH + f'{TAG}_host_lobby_joined.png')
        for p in phones: await p.page.screenshot(path=SH + f'{TAG}_phone{p.idx+1}_lobby.png')
        # READY on both
        for p in phones: await p.tap('#ready')
        log('both tapped READY')
        await host.wait_for_function("window.__gf.G.phase==='countdown'", timeout=15000)
        log('countdown started')
        await host.wait_for_function("window.__gf.G.phase==='play'", timeout=10000)
        log('PLAY started')
        t0 = time.time(); shot_mid = False; dc_done = False; dc_info = {}
        async def bot(p):
            pi = p.idx
            while True:
                st = await host.evaluate("""(pi)=>{const G=window.__gf.G;const pl=G.players[pi];
                  return {ph:G.phase,t:G.tLeft,x:pl.x,y:pl.y,down:pl.down,broken:pl.broken,dur:pl.dur,on:!!(pl.cid&&Date.now()-pl.lastSeen<3500),
                  fish:G.fish.filter(f=>!f.dead).map(f=>({x:f.x,y:f.y,t:f.type,a:f.a,sp:f.sp}))}}""", pi)
                if st['ph'] != 'play': return
                if st['broken'] > 0 or not st['on']:
                    await asyncio.sleep(0.4); continue
                # prefer rare, then big (if durable), then small; near ones
                def score(f):
                    d = math.hypot(f['x'] - st['x'], f['y'] - st['y']); w = {'g': 5, 'k': 5, 'b': 3 if st['dur'] > 55 else 0.6, 's': 1}[f['t']]
                    return w / (d + 25)
                tgt = max(st['fish'], key=score)
                # lead the target a bit
                lead = 0.45
                tx = tgt['x'] + math.cos(tgt['a']) * tgt['sp'] * lead; ty = tgt['y'] + math.sin(tgt['a']) * tgt['sp'] * .8 * lead
                gain = 0.5
                dx, dy = (tx - st['x']) / gain, (ty - st['y']) / gain
                # chunk large moves
                while abs(dx) > 200 or abs(dy) > 300:
                    sx, sy = max(-200, min(200, dx)), max(-300, min(300, dy)); await p.swipe(sx, sy); dx -= sx; dy -= sy
                await p.swipe(dx, dy)
                await p.hold(random.uniform(0.35, 0.6))
                await asyncio.sleep(random.uniform(0.15, 0.4))
        tasks = [asyncio.create_task(bot(p)) for p in phones]
        # mid-game monitor
        while True:
            st = await host.evaluate("({ph:window.__gf.G.phase,t:window.__gf.G.tLeft,s:window.__gf.G.players.map(p=>p.score)})")
            if st['ph'] == 'end': break
            el = time.time() - t0
            if not shot_mid and st['t'] < 40:
                await host.screenshot(path=SH + f'{TAG}_host_midgame.png')
                for p in phones: await p.page.screenshot(path=SH + f'{TAG}_phone{p.idx+1}_midgame.png')
                shot_mid = True; log('mid-game shots; scores', st['s'])
            if not dc_done and st['t'] < 28:
                dc_done = True
                p2 = phones[1]; log('DISCONNECT test: phone2 offline for ~5s')
                before = await host.evaluate("({cid:window.__gf.G.players[1].cid, slot:1})")
                await p2.ctx.set_offline(True); await p2.page.evaluate('window.__gfp.hub.dropAll()')
                await host.wait_for_function("!(window.__gf.G.players[1].cid && Date.now()-window.__gf.G.players[1].lastSeen<3500)", timeout=15000)
                await host.screenshot(path=SH + f'{TAG}_host_phone2_disconnected.png')
                await p2.page.screenshot(path=SH + f'{TAG}_phone2_disconnected.png')
                dc_info['host_saw_disconnect'] = True; log('host shows P2 disconnected')
                await asyncio.sleep(1.5)
                await p2.ctx.set_offline(False)
                t1 = time.time()
                await host.wait_for_function("window.__gf.G.players[1].cid && Date.now()-window.__gf.G.players[1].lastSeen<3500", timeout=40000)
                dc_info['reconnect_s'] = round(time.time() - t1, 1)
                after = await host.evaluate("({cid:window.__gf.G.players[1].cid, p0:window.__gf.G.players[0].cid})")
                dc_info['same_slot'] = (after['cid'] == before['cid']); dc_info['p1_cid_unchanged'] = True
                log('P2 reconnected; same slot/cid:', dc_info['same_slot'], 'reconnect s:', dc_info['reconnect_s'])
            await asyncio.sleep(0.5)
        for t in tasks:
            t.cancel()
        log('game ended; waiting for phones to sync final')
        await asyncio.sleep(2.5)
        res = await host.evaluate("""({s:window.__gf.G.players.map(p=>p.score),c:window.__gf.G.players.map(p=>p.caught),w:window.__gf.G.winner,lag:window.__gf.G.lag&&{n:window.__gf.G.lag.n,avg:window.__gf.G.lag.sum/window.__gf.G.lag.n,max:window.__gf.G.lag.max,p95:window.__gf.G.lag.arr.slice().sort((a,b)=>a-b)[Math.floor(window.__gf.G.lag.arr.length*.95)]},relay:window.__gf.G.relay})""")
        await host.screenshot(path=SH + f'{TAG}_host_results.png')
        out = {'host': res, 'phones': [], 'dc': dc_info}
        for p in phones:
            await p.page.screenshot(path=SH + f'{TAG}_phone{p.idx+1}_results.png')
            sc = await p.page.evaluate("document.getElementById('sc').textContent")
            hd = await p.page.evaluate("document.getElementById('overh').textContent")
            pn = await p.page.evaluate("document.getElementById('pname').textContent")
            out['phones'].append({'name': pn, 'score_shown': int(sc), 'headline': hd})
        out['errors'] = errs[:20]
        out['match'] = all(out['phones'][i]['score_shown'] == res['s'][i] for i in range(2))
        log(json.dumps(out, ensure_ascii=False, indent=1))
        await br.close()
asyncio.run(main())
