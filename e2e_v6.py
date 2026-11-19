import asyncio, sys, json, time, random, math
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:34567/'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'v2dev'
SH = '/workspace/goldfish/shots/' if TAG in ('v2', 'v3', 'v4', 'v5', 'v5_1', 'v6') else '/workspace/goldfish/shots_dev/'
log = lambda *a: print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)

# synthetic phone sensors: orientation @60Hz + motion with optional flick pulse; inv=iOS-style inverted accel sign
INIT = r"""
(() => {
  window.__perm = 'granted';
  const stub = (cls) => { if (window[cls]) window[cls].requestPermission = () => new Promise(r => setTimeout(() => r(window.__perm), 250)); };
  stub('DeviceMotionEvent'); stub('DeviceOrientationEvent');
  const sim = window.__sim = { on: false, beta: 45, gamma: 0, alpha: 10, inv: false, pulse: null, sent: 0 };
  const up = () => { const b = sim.beta * Math.PI / 180, g = sim.gamma * Math.PI / 180; return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)]; };
  sim.noise = 0.25;
  sim.gesture = (kind, peak = 14, ms = 110) => { sim.pulse = { t0: performance.now(), peak: kind === 'push' ? -peak : peak, ms }; };
  setInterval(() => {
    if (!sim.on) return;
    const u = up();
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: sim.alpha, beta: sim.beta + (Math.random() - .5) * .3, gamma: sim.gamma + (Math.random() - .5) * .3, absolute: false }));
    let a = 0;
    if (sim.pulse) { const t = performance.now() - sim.pulse.t0; if (t > 2 * sim.pulse.ms) sim.pulse = null; else a = sim.pulse.peak * Math.sin(Math.PI * t / sim.pulse.ms); }
    const lin = u.map(c => c * a + (Math.random() - .5) * sim.noise), g = u.map(c => c * 9.81), k = sim.inv ? -1 : 1;
    const v = (x) => ({ x: k * x[0], y: k * x[1], z: k * x[2] });
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', { acceleration: v(lin), accelerationIncludingGravity: v(lin.map((c, i) => c + g[i])), rotationRate: { alpha: 0, beta: 0, gamma: 0 }, interval: 16 }));
  }, 16);
})();
"""

async def new_phone(br, perm='granted', sensors=True):
    ctx = await br.new_context(viewport={'width': 390, 'height': 780}, device_scale_factor=2, is_mobile=True, has_touch=True,
        user_agent='Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1')
    if sensors: await ctx.add_init_script(INIT.replace("window.__perm = 'granted'", f"window.__perm = '{perm}'"))
    return ctx, await ctx.new_page()


async def main():
    out = {'tag': TAG, 'base': BASE}; errs = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        hctx = await br.new_context(viewport={'width': 1280, 'height': 720})
        host = await hctx.new_page()
        host.on('pageerror', lambda e: errs.append(('host', str(e))))
        host.on('console', lambda m: errs.append(('host-console', m.text)) if m.type == 'error' and 'WebSocket' not in m.text else None)
        await host.goto(BASE + 'index.html?dur=40', wait_until='load')
        await host.wait_for_function('window.__gf && window.__gf.G.relay.open>0', timeout=20000)
        await host.evaluate("localStorage.removeItem('gf-best-1p')")
        joinURL = await host.evaluate('window.__gf.joinURL'); log('host up', joinURL)
        await asyncio.sleep(1.2)
        out['title'] = {'phase': await host.evaluate('window.__gf.G.phase'), 'mode': await host.evaluate('window.__gf.G.mode'), 'buttons': await host.evaluate('window.__gf.G.btns.map(b=>b.id)')}
        await host.screenshot(path=SH + f'{TAG}_host_title.png'); log('title', out['title'])
        async def click_btn(bid, pg=host):
            b = await pg.evaluate("(id)=>window.__gf.G.btns.find(b=>b.id===id)", bid)
            r = await pg.evaluate("(()=>{const r=document.getElementById('c').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
            x = r[0] + (b['x'] + b['w'] / 2) / 320 * r[2]; y = r[1] + (b['y'] + b['h'] / 2) / 180 * r[3]
            await pg.mouse.move(x, y); await asyncio.sleep(.25); await pg.mouse.click(x, y)
        # hover shows the selection on 2P (screenshot), then click 1P
        b2 = await host.evaluate("window.__gf.G.btns.find(b=>b.id==='p2')"); r = await host.evaluate("(()=>{const r=document.getElementById('c').getBoundingClientRect();return [r.left,r.top,r.width,r.height]})()")
        await host.mouse.move(r[0] + (b2['x'] + 20) / 320 * r[2], r[1] + (b2['y'] + 20) / 180 * r[3]); await asyncio.sleep(.5)
        out['hover_2p_selected'] = await host.evaluate('window.__gf.G.sel'); await host.screenshot(path=SH + f'{TAG}_host_title_hover2p.png')
        await click_btn('p1'); await asyncio.sleep(.6)
        out['after_click_1p'] = {'phase': await host.evaluate('window.__gf.G.phase'), 'mode': await host.evaluate('window.__gf.G.mode')}; log('clicked 1P', out['after_click_1p'])
        await host.screenshot(path=SH + f'{TAG}_host_lobby_1p_empty.png')
        # ---------------- 1P ----------------
        async def start_phone(pg, beta):
            await pg.evaluate(f"window.__sim.on = true; window.__sim.beta = {beta}")
            await pg.locator('#startbtn').tap(); await pg.wait_for_function("window.__gfp.S.mode==='run' && window.__gfp.S.joined", timeout=30000)
        ctxA, pA = await new_phone(br); pA.on('pageerror', lambda e: errs.append(('phoneA', str(e))))
        await pA.goto(joinURL, wait_until='load'); await start_phone(pA, 45); log('phone A joined slot', await pA.evaluate('window.__gfp.S.slot'))
        ctxB, pB = await new_phone(br); pB.on('pageerror', lambda e: errs.append(('phoneB', str(e))))
        await pB.goto(joinURL, wait_until='load'); await pB.wait_for_function("window.__gfp.S.full===true", timeout=15000)
        out['phoneB_full_in_1p'] = {'full': True, 'msg': await pB.inner_text('#msg'), 'pname': await pB.inner_text('#pname')}; await pB.screenshot(path=SH + f'{TAG}_phone_full_1p.png'); log('B refused in 1P', out['phoneB_full_in_1p'])
        await asyncio.sleep(1.2); await host.screenshot(path=SH + f'{TAG}_host_lobby_1p_joined.png'); await pA.screenshot(path=SH + f'{TAG}_phone_lobby_1p.png')
        out['phoneA_1p'] = {'pname': await pA.inner_text('#pname'), 'ready_visible': await pA.locator('#ready').is_visible()}
        B0 = {0: 45, 1: 20}
        async def tilt_to(pg, pi, g, bd): await pg.evaluate(f"window.__sim.gamma={g};window.__sim.beta={B0[pi] + bd}")
        async def hstate(pi): return await host.evaluate("""(pi)=>{const G=window.__gf.G,p=G.players[pi];return {ph:G.phase,x:p.x,y:p.y,br:p.broken,dur:p.dur,dn:p.dn,
                  fish:G.fish.filter(f=>!f.dead).map(f=>({x:f.x,y:f.y,t:f.type,a:f.a,sp:f.sp}))}}""", pi)
        async def bot(pg, pi):
            while True:
                st = await hstate(pi)
                if st['ph'] != 'play': await tilt_to(pg, pi, 0, 0); return
                if st['br'] > 0: await tilt_to(pg, pi, 0, 0); await asyncio.sleep(.3); continue
                def score(f):
                    d = math.hypot(f['x'] - st['x'], f['y'] - st['y']); w = {'g': 5, 'k': 5, 'b': 3 if st['dur'] > 55 else .6, 's': 1}[f['t']]
                    return w / (d + 20)
                tg = max(st['fish'], key=score)
                tx = tg['x'] + math.cos(tg['a']) * tg['sp'] * .6; ty = tg['y'] + math.sin(tg['a']) * tg['sp'] * .8 * .6
                ex, ey = tx - st['x'], ty - st['y']; d = math.hypot(ex, ey) or 1
                if d > 11:
                    m = min(10.5, 4 + .25 * d); await tilt_to(pg, pi, ex / d * m, ey / d * m); await asyncio.sleep(.12)
                else:
                    await tilt_to(pg, pi, 0, 0); await asyncio.sleep(.2); t0 = time.time()
                    while time.time() - t0 < 1.5:
                        st = await hstate(pi)
                        if st['ph'] != 'play' or st['br'] > 0: break
                        if st['fish']:
                            tg = min(st['fish'], key=lambda f: math.hypot(f['x'] - st['x'], f['y'] - st['y'])); ex, ey = tg['x'] - st['x'], tg['y'] - st['y']; d = math.hypot(ex, ey) or 1
                        if time.time() - t0 > .45 and d < 9: break
                        await tilt_to(pg, pi, ex / d * 18, ey / d * 18); await asyncio.sleep(.07)
                    await tilt_to(pg, pi, 0, 0); await asyncio.sleep(.8)
        async def ready_all(pgs):
            for pg in pgs:
                try: await pg.wait_for_selector('#ready', state='visible', timeout=20000)
                except Exception:
                    diag = await pg.evaluate("({mode:window.__gfp.S.mode,bad:window.__gfp.S.badReason,slot:window.__gfp.S.slot,joined:window.__gfp.S.joined,full:window.__gfp.S.full,stAge:Date.now()-window.__gfp.S.lastSt,ph:window.__gfp.S.st&&window.__gfp.S.st.ph,relayOn:window.__gfp.S.relayOn,lastOriAge:Date.now()-window.__gfp.S.lastOri})")
                    log('READY NOT VISIBLE diag', diag); out.setdefault('ready_diag', []).append(diag); await pg.screenshot(path=SH + f'{TAG}_READY_NOT_VISIBLE.png'); raise
                await pg.locator('#ready').tap()
        async def play_round(pgs, tag):
            await ready_all(pgs)
            await host.wait_for_function("window.__gf.G.phase==='countdown'", timeout=15000)
            await host.wait_for_function("window.__gf.G.phase==='play'", timeout=10000); log(tag, 'PLAY')
            tasks = [asyncio.create_task(bot(pg, i)) for i, pg in enumerate(pgs)]; shot = False
            while True:
                st = await host.evaluate("({ph:window.__gf.G.phase,t:window.__gf.G.tLeft,s:window.__gf.G.players.map(p=>p.score)})")
                if st['ph'] == 'end': break
                if not shot and st['t'] < 22:
                    shot = True; await host.screenshot(path=SH + f'{TAG}_host_midgame_{tag}.png')
                    for i, pg in enumerate(pgs): await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_midgame_{tag}.png')
                await asyncio.sleep(.5)
            for t in tasks: t.cancel()
            await asyncio.sleep(2.5)
        await play_round([pA], '1p')
        res = await host.evaluate("({s:window.__gf.G.players.map(p=>p.score),best:window.__gf.G.best,newBest:window.__gf.G.newBest,mode:window.__gf.G.mode,stored:localStorage.getItem('gf-best-1p')})")
        await host.screenshot(path=SH + f'{TAG}_host_results_1p.png'); await pA.screenshot(path=SH + f'{TAG}_phone_results_1p.png')
        shown = await pA.evaluate("({sc:+document.getElementById('sc').textContent,head:document.getElementById('overh').textContent,over:document.getElementById('overp').innerText})")
        out['one_player'] = {'host': res, 'phone': shown, 'match': shown['sc'] == res['s'][0], 'no_opponent_text': 'vs' not in shown['over'] and '對手' not in shown['over']}; log('1P result', out['one_player'])
        # ---------------- back to title (click the 回標題 button) ----------------
        await click_btn('back'); await asyncio.sleep(1.0)
        out['back_to_title_click'] = {'phase': await host.evaluate('window.__gf.G.phase'), 'mode': await host.evaluate('window.__gf.G.mode')}; log('back via click', out['back_to_title_click'])
        await host.screenshot(path=SH + f'{TAG}_host_title_again.png'); await pA.screenshot(path=SH + f'{TAG}_phone_title_wait.png')
        out['phoneA_msg_at_title'] = await pA.inner_text('#msg')
        # ---------------- 2P (keyboard '2') ----------------
        await host.keyboard.press('2'); await asyncio.sleep(1.0)
        out['after_key_2'] = {'phase': await host.evaluate('window.__gf.G.phase'), 'mode': await host.evaluate('window.__gf.G.mode')}; log('pressed 2', out['after_key_2'])
        await pB.wait_for_function("window.__gfp.S.joined===true && window.__gfp.S.full===false", timeout=20000)   # B gets a seat once 2P opens
        await start_phone(pB, 20); log('phone B joined slot', await pB.evaluate('window.__gfp.S.slot'))
        await asyncio.sleep(1.5); await host.screenshot(path=SH + f'{TAG}_host_lobby_2p.png'); await pA.screenshot(path=SH + f'{TAG}_phone1_lobby_2p.png'); await pB.screenshot(path=SH + f'{TAG}_phone2_lobby_2p.png')
        out['slots_2p'] = await host.evaluate("window.__gf.G.players.map(p=>!!p.cid)")
        out['phoneA_pname_2p'] = await pA.inner_text('#pname')
        await play_round([pA, pB], '2p')
        res = await host.evaluate("({s:window.__gf.G.players.map(p=>p.score),w:window.__gf.G.winner,relay:window.__gf.hub.stats(),lag:(l=>l&&{n:l.n,avg:Math.round(l.sum/l.n),max:l.max})(window.__gf.G.lag)})")
        await host.screenshot(path=SH + f'{TAG}_host_results_2p.png')
        ph = []
        for i, pg in enumerate([pA, pB]):
            await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_results_2p.png'); ph.append(await pg.evaluate("({sc:+document.getElementById('sc').textContent,head:document.getElementById('overh').textContent})"))
        out['two_player'] = {'host': res['s'], 'phones': ph, 'match': all(ph[i]['sc'] == res['s'][i] for i in range(2)), 'winner': res['w'], 'lag': res['lag'], 'relay': [(r['url'][6:], r['acks'], r['lost']) for r in res['relay']]}; log('2P result', out['two_player'])
        # ---------------- back to title with Esc ----------------
        await host.keyboard.press('Escape'); await asyncio.sleep(1.0)
        out['back_to_title_esc'] = {'phase': await host.evaluate('window.__gf.G.phase'), 'mode': await host.evaluate('window.__gf.G.mode')}; log('back via Esc', out['back_to_title_esc'])
        await host.screenshot(path=SH + f'{TAG}_host_title_after_2p.png')
        out['errors'] = errs[:12]
        json.dump(out, open(SH + f'{TAG}_run.json', 'w'), ensure_ascii=False, indent=1)
        log('DONE', json.dumps(out, ensure_ascii=False)[:2500])
        await br.close()
asyncio.run(main())
