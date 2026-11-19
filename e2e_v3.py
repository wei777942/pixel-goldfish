import asyncio, sys, json, time, random, math
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:34567/'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'v2dev'
SH = '/workspace/goldfish/shots/' if TAG in ('v2', 'v3') else '/workspace/goldfish/shots_dev/'
log = lambda *a: print(f'[{time.strftime("%H:%M:%S")}]', *a, flush=True)

# synthetic phone sensors: orientation @60Hz + motion with optional flick pulse; inv=iOS-style inverted accel sign
INIT = r"""
(() => {
  window.__perm = 'granted';
  const stub = (cls) => { if (window[cls]) window[cls].requestPermission = () => new Promise(r => setTimeout(() => r(window.__perm), 250)); };
  stub('DeviceMotionEvent'); stub('DeviceOrientationEvent');
  const sim = window.__sim = { on: false, beta: 45, gamma: 0, alpha: 10, inv: false, pulse: null, sent: 0 };
  const up = () => { const b = sim.beta * Math.PI / 180, g = sim.gamma * Math.PI / 180; return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)]; };
  sim.flick = (peak, ms = 110) => { sim.pulse = { t0: performance.now(), peak, ms }; };
  setInterval(() => {
    if (!sim.on) return;
    const u = up();
    window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: sim.alpha, beta: sim.beta + (Math.random() - .5) * .3, gamma: sim.gamma + (Math.random() - .5) * .3, absolute: false }));
    let a = 0;
    if (sim.pulse) { const t = performance.now() - sim.pulse.t0; if (t > sim.pulse.ms) sim.pulse = null; else a = sim.pulse.peak * Math.sin(Math.PI * t / sim.pulse.ms); }
    const lin = u.map(c => c * a + (Math.random() - .5) * .25), g = u.map(c => c * 9.81), k = sim.inv ? -1 : 1;
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
    out = {'tag': TAG, 'base': BASE}
    errs = []
    async with async_playwright() as pw:
        br = await pw.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        hctx = await br.new_context(viewport={'width': 1280, 'height': 720})
        host = await hctx.new_page()
        host.on('pageerror', lambda e: errs.append(('host', str(e))))
        host.on('console', lambda m: errs.append(('host-console', m.text)) if m.type == 'error' and 'WebSocket' not in m.text else None)
        await host.goto(BASE + 'index.html', wait_until='load')
        await host.wait_for_function('window.__gf && window.__gf.G.relay.open>0', timeout=20000)
        joinURL = await host.evaluate('window.__gf.joinURL'); log('host up', joinURL)

        # ---- denied path + no-sensor path (separate phones, separate rooms don't matter: they never get past the start screen)
        dctx, dpg = await new_phone(br, perm='denied')
        await dpg.goto(joinURL.split('?r=')[0] + '?r=DENY01', wait_until='load'); await dpg.wait_for_timeout(1200)
        await dpg.screenshot(path=SH + f'{TAG}_phone_start.png')
        await dpg.locator('#startbtn').tap(); await dpg.wait_for_selector('#scr-bad', state='visible', timeout=8000)
        await dpg.wait_for_timeout(400)
        out['denied'] = {'title': await dpg.inner_text('#badtitle'), 'steps': await dpg.locator('#badsteps li').count(), 'retry_visible': await dpg.locator('#retrybtn').is_visible()}
        await dpg.screenshot(path=SH + f'{TAG}_phone_denied.png'); log('denied screen', out['denied'])
        # retry (still denied) must show the screen again, not silently do nothing
        await dpg.locator('#retrybtn').tap(); await dpg.wait_for_timeout(700)
        out['denied']['retry_shows_again'] = await dpg.locator('#scr-bad').is_visible()
        # flip to granted: retry should now succeed
        await dpg.evaluate("window.__perm='granted'; window.__sim.on=true"); await dpg.locator('#retrybtn').tap()
        await dpg.wait_for_function("window.__gfp.S.mode==='run'", timeout=8000); out['denied']['retry_then_granted_ok'] = True
        await dctx.close()
        nctx, npg = await new_phone(br, sensors=False)   # desktop-like: no events at all
        await npg.goto(joinURL.split('?r=')[0] + '?r=NOSENS', wait_until='load'); await npg.wait_for_timeout(800)
        await npg.locator('#startbtn').tap(); await npg.wait_for_selector('#scr-bad', state='visible', timeout=9000)
        out['nosensor'] = {'title': await npg.inner_text('#badtitle')}; await npg.screenshot(path=SH + f'{TAG}_phone_nosensor.png'); log('nosensor', out['nosensor'])
        await nctx.close()

        # ---- real run: two phones (phone2 uses iOS-style inverted accel signs)
        phones = []
        for i in range(2):
            ctx, pg = await new_phone(br)
            pg.on('pageerror', lambda e, i=i: errs.append((f'phone{i+1}', str(e))))
            pg.on('console', lambda m, i=i: errs.append((f'phone{i+1}-console', m.text)) if m.type == 'error' and 'WebSocket' not in m.text else None)
            await pg.goto(joinURL, wait_until='load')
            await pg.evaluate(f"window.__sim.on = true; window.__sim.inv = {'true' if i else 'false'}; window.__sim.beta = {45 if i == 0 else 20}")
            await pg.locator('#startbtn').tap()
            await pg.wait_for_function("window.__gfp.S.mode==='run' && window.__gfp.S.joined", timeout=30000)
            phones.append((ctx, pg)); log(f'phone{i+1} started + joined slot', await pg.evaluate('window.__gfp.S.slot'))
        await host.wait_for_timeout(1500)
        await host.screenshot(path=SH + f'{TAG}_host_lobby_joined.png')
        for i, (c, pg) in enumerate(phones): await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_lobby.png')
        # ---- dip / lift threshold test in the lobby (phone-side state machine; host ignores scoops outside play)
        pg1 = phones[0][1]; th = {}
        S = lambda: pg1.evaluate('({n:window.__gfp.S.scN,down:window.__gfp.S.down,snap:window.__gfp.S.lastSnap})')
        async def tilt(g, b=45): await pg1.evaluate(f"window.__sim.gamma={g};window.__sim.beta={b}")
        await asyncio.sleep(1.2); s0 = await S()
        await tilt(3); await asyncio.sleep(1); s = await S(); th['tilt_3deg_goes_down'] = s['down']; th['tilt_3deg_scoops'] = s['n'] - s0['n']; await tilt(0)
        await asyncio.sleep(.6); s0 = await S()
        await tilt(20); await asyncio.sleep(.15); th['down_after_150ms'] = (await S())['down']; await tilt(0); await asyncio.sleep(1); s = await S(); th['quick_dip_150ms_scoops'] = s['n'] - s0['n']
        s0 = await S(); await tilt(20); await asyncio.sleep(.9); th['down_when_tilted_20deg'] = (await S())['down']
        for g in (14, 7, 0): await tilt(g); await asyncio.sleep(.1)
        await asyncio.sleep(.7); s = await S(); th['gentle_return_scoops'] = s['n'] - s0['n']; th['gentle_return_snap'] = round(s['snap'], 2); th['down_after_return'] = s['down']
        await asyncio.sleep(.5); s0 = await S(); await tilt(20); await asyncio.sleep(.9); await tilt(0); await asyncio.sleep(.9); s = await S()
        th['instant_snap_scoops'] = s['n'] - s0['n']; th['instant_snap_value'] = round(s['snap'], 2)
        out['thresholds'] = th; log('thresholds', th)
        for c, pg in phones: await pg.locator('#ready').tap()
        await host.wait_for_function("window.__gf.G.phase==='countdown'", timeout=15000); log('countdown')
        await host.wait_for_function("window.__gf.G.phase==='play'", timeout=10000); log('PLAY')
        B0 = [45, 20]
        violent = {'done': False, 'broke': False, 'pop': None}
        flicks = [0, 0]; hard = {'n': 0}
        async def tilt_to(pg, pi, g, bdelta): await pg.evaluate(f"window.__sim.gamma={g};window.__sim.beta={B0[pi] + bdelta}")
        async def ramp_return(pg, pi, g, bd, steps=4, gap=.07):
            for k in range(steps - 1, -1, -1):
                await tilt_to(pg, pi, g * k / steps, bd * k / steps); await asyncio.sleep(gap)
        async def bot(pi):
            c, pg = phones[pi]
            while True:
                st = await host.evaluate("""(pi)=>{const G=window.__gf.G,p=G.players[pi];return {ph:G.phase,x:p.x,y:p.y,br:p.broken,dur:p.dur,cool:p.cool,sp:p.speed,t:G.tLeft,dn:p.dn,
                  fish:G.fish.filter(f=>!f.dead).map(f=>({x:f.x,y:f.y,t:f.type,a:f.a,sp:f.sp}))}}""", pi)
                if st['ph'] != 'play': await tilt_to(pg, pi, 0, 0); return
                if st['br'] > 0: await tilt_to(pg, pi, 0, 0); await asyncio.sleep(.3); continue
                def score(f):
                    d = math.hypot(f['x'] - st['x'], f['y'] - st['y']); w = {'g': 5, 'k': 5, 'b': 3 if st['dur'] > 55 else .6, 's': 1}[f['t']]
                    return w / (d + 20)
                tg = max(st['fish'], key=score)
                tx = tg['x'] + math.cos(tg['a']) * tg['sp'] * .5; ty = tg['y'] + math.sin(tg['a']) * tg['sp'] * .8 * .5
                ex, ey = tx - st['x'], ty - st['y']; d = math.hypot(ex, ey)
                cl = lambda v: max(0, min(22, v))
                gx = math.copysign(cl(abs(ex) * .45 + 5), ex) if abs(ex) > 4 else 0; by = math.copysign(cl(abs(ey) * .45 + 5), ey) if abs(ey) > 4 else 0
                # --- scripted checks
                if pi == 0 and not violent['done'] and st['t'] < 45 and st['cool'] <= 0:
                    # stay in the water (sweep side to side, fast) until the paper wears out; record the wear stages seen
                    violent['done'] = True; t0 = time.time(); stages = []; d0 = st['dur']; log('P1 STAYS IN WATER until it breaks')
                    k = 0
                    while time.time() - t0 < 40:
                        await tilt_to(pg, 0, 22 if k % 2 == 0 else -22, 0); k += 1; await asyncio.sleep(.45)
                        q = await host.evaluate("({d:window.__gf.G.players[0].dur,b:window.__gf.G.players[0].broken,dn:window.__gf.G.players[0].dn})")
                        stg = await host.evaluate("(d)=>window.__gf.NetSprite.stageOf(d,false)", q['d'])
                        if not stages or stages[-1] != stg: stages.append(stg); await host.screenshot(path=SH + f'{TAG}_host_stage{stg}.png')
                        if q['b'] > 0: violent['broke'] = True; break
                    violent['secs_in_water'] = round(time.time() - t0, 1); violent['stages_seen'] = stages
                    await pg.screenshot(path=SH + f'{TAG}_phone1_netbroken.png'); await host.screenshot(path=SH + f'{TAG}_host_netbroken.png')
                    await tilt_to(pg, 0, 0, 0); await asyncio.sleep(.5); continue
                if pi == 1 and not hard['n'] and st['t'] < 55 and st['cool'] <= 0 and st['dur'] > 99:
                    hard['n'] = 1; await tilt_to(pg, 1, 0, 0); await asyncio.sleep(.3); d1 = await host.evaluate("window.__gf.G.players[1].dur")
                    await asyncio.sleep(3.5); d2 = await host.evaluate("window.__gf.G.players[1].dur")
                    await tilt_to(pg, 1, 22, 0); await asyncio.sleep(.8); await tilt_to(pg, 1, 0, 0); await asyncio.sleep(.7)
                    hard['dur_out_of_water_before_after'] = [d1, d2]; hard['no_wear_out_of_water'] = d1 == d2; log('out-of-water wear check', hard); continue
                # --- normal play: tilt toward fish (net dips + moves), then ease back to centre = scoop
                if d > 12:
                    await tilt_to(pg, pi, gx, by); await asyncio.sleep(.12)
                else:
                    await ramp_return(pg, pi, gx, by, steps=4, gap=.08); flicks[pi] += 1; await asyncio.sleep(.9)
        tasks = [asyncio.create_task(bot(i)) for i in range(2)]
        shot = False; dc = False; dcinfo = {}
        while True:
            st = await host.evaluate("({ph:window.__gf.G.phase,t:window.__gf.G.tLeft,s:window.__gf.G.players.map(p=>p.score)})")
            if st['ph'] == 'end': break
            if not shot and st['t'] < 30 and violent['done']:
                shot = True; await host.screenshot(path=SH + f'{TAG}_host_midgame.png')
                for i, (c, pg) in enumerate(phones): await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_midgame.png')
                log('midgame shots', st['s'])
            if not dc and st['t'] < 18:
                dc = True; c2, p2 = phones[1]; log('DISCONNECT phone2 ~4s')
                before = await host.evaluate("window.__gf.G.players[1].cid")
                await c2.set_offline(True); await p2.evaluate('window.__gfp.hub.dropAll()')
                await host.wait_for_function("!(window.__gf.G.players[1].cid && Date.now()-window.__gf.G.players[1].lastSeen<3500)", timeout=15000)
                await asyncio.sleep(1); await c2.set_offline(False); t1 = time.time()
                await host.wait_for_function("window.__gf.G.players[1].cid && Date.now()-window.__gf.G.players[1].lastSeen<3500", timeout=40000)
                after = await host.evaluate("window.__gf.G.players[1].cid"); dcinfo = {'same_slot_cid': before == after, 'reconnect_s': round(time.time() - t1, 1)}; log('reconnected', dcinfo)
            await asyncio.sleep(.5)
        for t in tasks: t.cancel()
        await asyncio.sleep(2.5)
        res = await host.evaluate("""({s:window.__gf.G.players.map(p=>p.score),c:window.__gf.G.players.map(p=>p.caught),w:window.__gf.G.winner,
          lag:(l=>l&&{n:l.n,avg:Math.round(l.sum/l.n),max:l.max,p95:l.arr.slice().sort((a,b)=>a-b)[Math.floor(l.arr.length*.95)]})(window.__gf.G.lag),rx:window.__gf.G.rx,relay:window.__gf.hub.stats()})""")
        await host.screenshot(path=SH + f'{TAG}_host_results.png')
        out['host'] = res; out['phones'] = []; out['flicks_sent_by_bot'] = flicks; out['violent'] = violent; out['hard_normal'] = hard; out['dc'] = dcinfo
        for i, (c, pg) in enumerate(phones):
            await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_results.png')
            out['phones'].append(await pg.evaluate("""({name:document.getElementById('pname').textContent,score_shown:+document.getElementById('sc').textContent,headline:document.getElementById('overh').textContent,
              sentIn:window.__gfp.S.sendN,sentScoops:window.__gfp.S.scN,lastSnap:window.__gfp.S.lastSnap,relay:window.__gfp.hub.stats()})"""))
        out['match'] = all(out['phones'][i]['score_shown'] == res['s'][i] for i in range(2))
        out['errors'] = errs[:12]
        json.dump(out, open(SH + f'{TAG}_run.json', 'w'), ensure_ascii=False, indent=1)
        log(json.dumps({k: out[k] for k in ['host', 'match', 'violent', 'hard_normal', 'thresholds', 'dc', 'denied', 'nosensor', 'errors', 'flicks_sent_by_bot']}, ensure_ascii=False)[:3500])
        for i in range(2): log('phone', i + 1, {k: v for k, v in out['phones'][i].items() if k != 'relay'})
        await br.close()
asyncio.run(main())
