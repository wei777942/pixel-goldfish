import asyncio, sys, json, time, random, math
from playwright.async_api import async_playwright

BASE = sys.argv[1] if len(sys.argv) > 1 else 'http://localhost:34567/'
TAG = sys.argv[2] if len(sys.argv) > 2 else 'v2dev'
SH = '/workspace/goldfish/shots/' if TAG in ('v2', 'v3', 'v4', 'v5') else '/workspace/goldfish/shots_dev/'
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
        # ---- phone-side behaviour tests (lobby; host ignores in-water state outside play). rings: 3 deg per ring; dip ring 4.0 (12 deg), return ring 3.0 (9 deg)
        pg1 = phones[0][1]; th = {}
        S = lambda: pg1.evaluate('({dip:window.__gfp.S.dipN,lift:window.__gfp.S.liftN,cancel:window.__gfp.S.cancelN,sc:window.__gfp.S.scN,down:window.__gfp.S.down,cx:window.__gfp.S.cx,cy:window.__gfp.S.cy,ring:window.__gfp.S.ring})')
        async def tiltg(g, b=0): await pg1.evaluate(f"window.__sim.gamma={g};window.__sim.beta={45 + b}")
        async def setsl(id, v): await pg1.evaluate(f"(()=>{{const e=document.getElementById('{id}');e.value={v};e.dispatchEvent(new Event('input'))}})()")
        async def openpanel(): await pg1.locator('#gear').tap(); await asyncio.sleep(.3)
        await asyncio.sleep(1.5); s0 = await S()
        th['defaults'] = await pg1.evaluate("JSON.stringify(window.__gfp.USER)"); th['deg_per_ring'] = 3
        # 1) slow tilting inside the dip ring (up to 10 deg = ring 3.3) in all four directions never dips; a sudden jump to 10 deg doesn't either
        for g, b in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            for k in range(0, 31): await tiltg(k / 3 * g, k / 3 * b); await asyncio.sleep(.1)
            await tiltg(0, 0); await asyncio.sleep(.4)
        await tiltg(10, 0); await asyncio.sleep(.6); await tiltg(0); await asyncio.sleep(.5)
        s = await S(); th['slow_tilt_within_circle_dips'] = s['dip'] - s0['dip']; th['slow_tilt_down'] = s['down']
        await tiltg(7, 0); await asyncio.sleep(.5); await pg1.screenshot(path=SH + f'{TAG}_phone1_rings_abovewater_lobby.png'); await tiltg(0)
        # 2) tilt beyond the dip ring -> in water; back inside the return ring -> scoop
        s0 = await S(); await tiltg(18, 0); await asyncio.sleep(.9); s = await S(); th['beyond_dip_goes_down'] = s['down']; th['ring_at_18deg'] = round(s['ring'], 2)
        await pg1.screenshot(path=SH + f'{TAG}_phone1_inwater_lobby.png')
        await tiltg(0); await asyncio.sleep(.7); s = await S(); th['return_scoops'] = s['sc'] - s0['sc']; th['down_after_return'] = s['down']
        # 3) a quick graze (150 ms beyond the ring) is cancelled, no scoop
        s0 = await S(); await tiltg(18, 0); await asyncio.sleep(.15); await tiltg(0); await asyncio.sleep(.7); s = await S(); th['graze_scoops'] = s['sc'] - s0['sc']; th['graze_cancelled'] = s['cancel'] - s0['cancel']
        # 4) hysteresis: jitter between ring 3.8 and 4.2 (10 Hz) for 3 s. default band (return ring 3.0): one dip, no flicker. return ring 3.9: flickers.
        async def jitter(n=30):
            for k in range(n): await tiltg(11.4 if k % 2 == 0 else 12.6); await asyncio.sleep(.1)
            await tiltg(0); await asyncio.sleep(.8)
        await tiltg(0); await asyncio.sleep(.5); s0 = await S(); await jitter(); s = await S(); th['jitter_default_dips'] = s['dip'] - s0['dip']; th['jitter_default_scoops'] = s['sc'] - s0['sc']
        await openpanel(); await setsl('tn-ret', 3.9); await pg1.locator('#tclose').tap(); await asyncio.sleep(.2)
        s0 = await S(); await jitter(); s = await S(); th['jitter_narrow_band_dips'] = s['dip'] - s0['dip']; th['jitter_narrow_band_cancelled'] = s['cancel'] - s0['cancel']
        # 5) sliders change behaviour: dip ring 6 -> 16 deg (ring 5.3) no longer dips; dip ring 3 -> 10 deg (ring 3.3) dips
        await openpanel(); await setsl('tn-dip', 6.0); await setsl('tn-ret', 3.0); th['ret_after_dip6'] = await pg1.evaluate("window.__gfp.USER.ret"); await pg1.locator('#tclose').tap(); await asyncio.sleep(.2)
        s0 = await S(); await tiltg(16, 0); await asyncio.sleep(.8); s = await S(); th['dip6_tilt16_down'] = s['down']; await tiltg(0); await asyncio.sleep(.6)
        await openpanel(); await setsl('tn-dip', 3.0); th['dip_value_shown'] = await pg1.inner_text('#to-dip'); th['ret_auto_clamped_to'] = await pg1.evaluate("window.__gfp.USER.ret")
        await pg1.locator('#tclose').tap(); await asyncio.sleep(.2); await tiltg(0); await asyncio.sleep(.5)
        await tiltg(10, 0); await asyncio.sleep(.8); s = await S(); th['dip3_tilt10_down'] = s['down']; await tiltg(0); await asyncio.sleep(.6)
        # speeds: above-water travel at 9 deg and in-water travel at 18 deg for 1 s
        await openpanel(); await setsl('tn-dip', 4.0); await setsl('tn-ret', 3.0); await pg1.locator('#tclose').tap(); await asyncio.sleep(.3)
        async def travel(deg):
            await tiltg(0); await asyncio.sleep(1.0); a = await S(); await tiltg(deg); await asyncio.sleep(1.0); b = await S(); await tiltg(0); await asyncio.sleep(.9); return round(abs(b['cx'] - a['cx']), 1)
        th['air_travel_9deg_sens1.0'] = await travel(9)
        await openpanel(); await setsl('tn-sens', 2.0); await pg1.locator('#tclose').tap(); await asyncio.sleep(.3); th['air_travel_9deg_sens2.0'] = await travel(9)
        await openpanel(); await setsl('tn-sens', 1.0); await pg1.locator('#tclose').tap(); await asyncio.sleep(.3)
        th['water_travel_18deg_wspeed0.6'] = await travel(18)
        await openpanel(); await setsl('tn-wspeed', 1.2); await pg1.locator('#tclose').tap(); await asyncio.sleep(.3); th['water_travel_18deg_wspeed1.2'] = await travel(18)
        await openpanel(); await setsl('tn-dead', 2.0); await pg1.locator('#tclose').tap(); await asyncio.sleep(.3); th['air_travel_4deg_dead2.0(=6deg)'] = await travel(4)
        await openpanel(); await setsl('tn-dip', 5.5); await setsl('tn-dead', 1.0); await setsl('tn-wspeed', 0.6)
        th['saved_in_localstorage'] = await pg1.evaluate("localStorage.getItem('gf-tune-v5c')")
        await pg1.reload(wait_until='load'); await asyncio.sleep(.8)
        th['after_reload_user'] = await pg1.evaluate("JSON.stringify(window.__gfp.USER)")
        await pg1.evaluate("window.__sim.on=true;window.__sim.beta=45;window.__sim.gamma=0"); await pg1.locator('#startbtn').tap()
        await pg1.wait_for_function("window.__gfp.S.mode==='run' && window.__gfp.S.joined", timeout=30000)
        await openpanel(); await pg1.locator('#treset').tap(); await asyncio.sleep(.2)
        th['reset_equals_defaults'] = await pg1.evaluate("JSON.stringify(window.__gfp.USER)===JSON.stringify(window.__gfp.DEF)"); th['after_reset_user'] = await pg1.evaluate("JSON.stringify(window.__gfp.USER)")
        await tiltg(14, 0); await asyncio.sleep(.6); await pg1.screenshot(path=SH + f'{TAG}_phone_tuning_panel.png'); await tiltg(0); await asyncio.sleep(.8)
        await pg1.locator('#tclose').tap()
        out['thresholds'] = th; log('thresholds', json.dumps(th, ensure_ascii=False))
        await asyncio.sleep(1)
        for c, pg in phones: await pg.locator('#ready').tap()
        await host.wait_for_function("window.__gf.G.phase==='countdown'", timeout=15000); log('countdown')
        await host.wait_for_function("window.__gf.G.phase==='play'", timeout=10000); log('PLAY')
        B0 = [45, 20]
        wear = {'done': False, 'broke': False}; nowear = {'n': 0}; shots = {'up': False, 'down': False}
        gestures = [0, 0]
        async def tilt_to(pg, pi, g, bdelta): await pg.evaluate(f"window.__sim.gamma={g};window.__sim.beta={B0[pi] + bdelta}")
        async def hstate(pi): return await host.evaluate("""(pi)=>{const G=window.__gf.G,p=G.players[pi];return {ph:G.phase,x:p.x,y:p.y,br:p.broken,dur:p.dur,cool:p.cool,t:G.tLeft,dn:p.dn,
                  fish:G.fish.filter(f=>!f.dead).map(f=>({x:f.x,y:f.y,t:f.type,a:f.a,sp:f.sp}))}}""", pi)
        async def bot(pi):
            c, pg = phones[pi]
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
                # --- scripted checks
                if pi == 0 and not wear['done'] and st['t'] < 55 and st['cool'] <= 0 and not st['dn']:
                    # tilt beyond the dip ring and stay in the water, sweeping fast, until the paper wears out; screenshot each wear stage
                    wear['done'] = True; await tilt_to(pg, 0, 0, 0); await asyncio.sleep(.4); t0 = time.time(); stages = []; k = 0; log('P1 STAYS IN WATER until it breaks')
                    while time.time() - t0 < 45:
                        await tilt_to(pg, 0, 22 if k % 2 == 0 else -22, 0); k += 1; await asyncio.sleep(.45)
                        q = await host.evaluate("({d:window.__gf.G.players[0].dur,b:window.__gf.G.players[0].broken,dn:window.__gf.G.players[0].dn})")
                        stg = await host.evaluate("(d)=>window.__gf.NetSprite.stageOf(d,false)", q['d'])
                        if not stages or stages[-1] != stg: stages.append(stg); await host.screenshot(path=SH + f'{TAG}_host_stage{stg}.png')
                        if q['b'] > 0: wear['broke'] = True; break
                    wear['secs_in_water'] = round(time.time() - t0, 1); wear['stages_seen'] = stages
                    await pg.screenshot(path=SH + f'{TAG}_phone1_netbroken.png'); await host.screenshot(path=SH + f'{TAG}_host_netbroken.png')
                    await tilt_to(pg, 0, 0, 0); await asyncio.sleep(.5); continue
                if pi == 1 and not nowear['n'] and st['t'] < 61 and st['dur'] > 99 and not st['dn']:
                    nowear['n'] = 1; d1 = await host.evaluate("window.__gf.G.players[1].dur")
                    for k in range(8): await tilt_to(pg, 1, 10 if k % 2 == 0 else -10, 0); await asyncio.sleep(.45)       # moving back and forth inside the circle (ring 3.3), above the water
                    await tilt_to(pg, 1, 0, 0); await asyncio.sleep(.3); d2 = await host.evaluate("window.__gf.G.players[1].dur")
                    nowear['dur_before_after_moving_in_air'] = [d1, d2]; nowear['no_wear_above_water'] = d1 == d2; log('above-water wear check', nowear); continue
                # --- normal play: tilt toward the fish inside the circle (above water), then tilt beyond the dip ring (net dips, still moves) and come back inside = scoop
                if d > 34:
                    m = min(10.5, 3 + .1 * d); await tilt_to(pg, pi, ex / d * m, ey / d * m); await asyncio.sleep(.12)
                else:
                    await tilt_to(pg, pi, 0, 0); await asyncio.sleep(.2)
                    if pi == 0 and not shots['up']:
                        shots['up'] = True; await tilt_to(pg, 0, ex / d * 7, ey / d * 7); await asyncio.sleep(.4); await pg.screenshot(path=SH + f'{TAG}_phone1_midgame_abovewater.png')
                    t0 = time.time(); shot_in = False
                    while time.time() - t0 < 1.5:
                        st = await hstate(pi)
                        if st['ph'] != 'play' or st['br'] > 0: break
                        if st['fish']:
                            tg = min(st['fish'], key=lambda f: math.hypot(f['x'] - st['x'], f['y'] - st['y']))
                            ex, ey = tg['x'] - st['x'], tg['y'] - st['y']; d = math.hypot(ex, ey) or 1
                        if time.time() - t0 > .45 and d < 9: break
                        await tilt_to(pg, pi, ex / d * 18, ey / d * 18)
                        if pi == 0 and not shots['down'] and time.time() - t0 > .35:
                            shots['down'] = True; await pg.screenshot(path=SH + f'{TAG}_phone1_midgame_inwater.png')
                        await asyncio.sleep(.07)
                    await tilt_to(pg, pi, 0, 0); gestures[pi] += 1; await asyncio.sleep(.8)
        tasks = [asyncio.create_task(bot(i)) for i in range(2)]
        shot = False; dc = False; dcinfo = {}
        while True:
            st = await host.evaluate("({ph:window.__gf.G.phase,t:window.__gf.G.tLeft,s:window.__gf.G.players.map(p=>p.score)})")
            if st['ph'] == 'end': break
            if not shot and st['t'] < 30 and wear['done']:
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
        out['host'] = res; out['phones'] = []; out['gesture_cycles_by_bot'] = gestures; out['wear'] = wear; out['nowear'] = nowear; out['dc'] = dcinfo
        for i, (c, pg) in enumerate(phones):
            await pg.screenshot(path=SH + f'{TAG}_phone{i+1}_results.png')
            out['phones'].append(await pg.evaluate("""({name:document.getElementById('pname').textContent,score_shown:+document.getElementById('sc').textContent,headline:document.getElementById('overh').textContent,
              sentIn:window.__gfp.S.sendN,dips:window.__gfp.S.dipN,lifts:window.__gfp.S.liftN,cancels:window.__gfp.S.cancelN,scoops:window.__gfp.S.scN,relay:window.__gfp.hub.stats()})"""))
        out['match'] = all(out['phones'][i]['score_shown'] == res['s'][i] for i in range(2))
        out['errors'] = errs[:12]
        json.dump(out, open(SH + f'{TAG}_run.json', 'w'), ensure_ascii=False, indent=1)
        log(json.dumps({k: out[k] for k in ['host', 'match', 'wear', 'nowear', 'dc', 'denied', 'nosensor', 'errors', 'gesture_cycles_by_bot']}, ensure_ascii=False)[:3500])
        for i in range(2): log('phone', i + 1, {k: v for k, v in out['phones'][i].items() if k != 'relay'})
        await br.close()
asyncio.run(main())
