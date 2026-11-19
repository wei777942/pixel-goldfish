/* 撈金魚 phone controller (motion sensing). Sends input only; renders what the big screen says.
 *  - tilt (deviceorientation) -> rate-controlled net position, sent as cumulative counters at ~20 Hz
 *  - quick upward flick (devicemotion) -> ONE 'sc' scoop event with strength; the host decides catch / tear */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var Q = new URLSearchParams(location.search);
  var room = (Q.get('r') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!room) {
    $('join').style.display = 'flex';
    $('gobtn').onclick = function () { var v = $('roomin').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (v.length >= 4) location.search = '?r=' + v; };
    return;
  }
  var PCOL = ['#ff4f8b', '#b6f23a'];
  var cid; try { cid = localStorage.getItem('gf-cid-' + room); } catch (e) {}
  if (!cid) { cid = 'p' + Math.random().toString(36).slice(2, 10); try { localStorage.setItem('gf-cid-' + room, cid); } catch (e) {} }

  var TUNE = { dead: 0.07, range: 0.42, vmax: 230, flickMin: 7, collectMs: 70, cooldownMs: 700, rateMs: 50, keepMs: 450 };
  var S = { slot: -1, st: null, lastSt: 0, joined: false, full: false, relayOn: false, seq: 0, cx: 0, cy: 0, rc: 0, sn: 0, ss: 0,
    seenEv: {}, lastSent: 0, dirty: false, mode: 'start' /* start|bad|run */, touchMode: false, tries: 0,
    u: null, u0: null, calUntil: 0, calAcc: null, vx: 0, vy: 0, lastOri: 0, lastMot: 0, tx: 0, ty: 0, lastTick: 0,
    lp: null, s: 1, flick: null, lastScoopAt: 0, lastPeak: 0, peakShown: 0, lastPhase: '', brk: 26, orient: 0, motion: 0, sendN: 0, scN: 0 };

  /* ================= relay ================= */
  var hub = new GFRelay.Hub({
    sub: 'gf1-' + room + '-d', pub: 'gf1-' + room + '-u',
    onmsg: function (m) {
      if (m.k === 'full' && m.c === cid) { S.full = true; render(); return; }
      if (m.k !== 'st') return;
      S.st = m; S.lastSt = Date.now(); if (m.bk) S.brk = m.bk;
      var i = -1; for (var j = 0; j < m.pl.length; j++) if (m.pl[j].c === cid) i = j;
      if (i >= 0) { if (!S.joined || S.slot !== i) { S.joined = true; S.slot = i; S.full = false; $('app').style.setProperty('--pc', PCOL[i]); } }
      if (m.ph !== S.lastPhase) { if (m.ph === 'countdown' && S.mode === 'run') calibrate(); S.lastPhase = m.ph; }
      events(m); render();
    },
    onstatus: function (i) { S.relayOn = i.online; if (i.online) hi(); render(); }
  });
  function hi() { hub.send({ k: 'hi', c: cid, rc: S.rc, sn: S.sn, mo: S.mode === 'run' ? 1 : 0 }); }
  setInterval(function () { if (S.relayOn && (!S.joined && !S.full || S.joined && Date.now() - S.lastSt > 3500)) hi(); }, 1500);

  /* ================= sending ================= */
  function sendIn(force) {
    var now = Date.now();
    if (!S.relayOn) return;
    if (!force && !S.dirty && now - S.lastSent < TUNE.keepMs) return;
    if (!force && now - S.lastSent < TUNE.rateMs) return;       // <= 20 msg/s
    S.lastSent = now; S.dirty = false; S.seq++; S.sendN++;
    hub.send({ k: 'in', c: cid, s: S.seq, x: Math.round(S.cx * 10) / 10, y: Math.round(S.cy * 10) / 10, rc: S.rc, sn: S.sn, ss: S.ss, mo: S.mode === 'run' ? 1 : 0, ts: now }, !force);
  }
  function sendScoop(peak) {
    S.sn++; S.ss = Math.round(peak * 10) / 10; S.scN++;
    var m = { k: 'sc', c: cid, n: S.sn, str: S.ss, ts: Date.now() };
    hub.send(m); setTimeout(function () { hub.send(m); }, 90); setTimeout(function () { hub.send(m); }, 300);  // same id: host de-dupes
    S.lastPeak = peak; S.peakShown = Date.now(); if (navigator.vibrate) navigator.vibrate(peak >= S.brk ? [80, 40, 80] : 25);
    flickMeter(peak);
  }

  /* ================= sensors ================= */
  function norm(v) { var n = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / n, v[1] / n, v[2] / n]; }
  // "up" direction expressed in the device frame, from W3C alpha/beta/gamma (independent of alpha, no gimbal trouble upright)
  function upFrom(beta, gamma) {
    var b = beta * Math.PI / 180, g = gamma * Math.PI / 180;
    return [-Math.cos(b) * Math.sin(g), Math.sin(b), Math.cos(b) * Math.cos(g)];
  }
  function onOri(e) {
    if (typeof e.beta !== 'number' || typeof e.gamma !== 'number') return;
    var u = upFrom(e.beta, e.gamma), now = Date.now();
    S.orient++; S.lastOri = now;
    if (!S.u) S.u = u; else { var a = 0.4; S.u = norm([S.u[0] + (u[0] - S.u[0]) * a, S.u[1] + (u[1] - S.u[1]) * a, S.u[2] + (u[2] - S.u[2]) * a]); }
    if (S.calAcc) S.calAcc.push(u);
  }
  function onMot(e) {
    var now = Date.now(); S.motion++; S.lastMot = now;
    var ag = e.accelerationIncludingGravity, ac = e.acceleration, lin = null;
    if (ag && typeof ag.x === 'number' && ag.x !== null) {
      var g = [ag.x, ag.y, ag.z];
      if (!S.lp) S.lp = g.slice(); else for (var i = 0; i < 3; i++) S.lp[i] += (g[i] - S.lp[i]) * 0.04;
      // platform sign convention (iOS reports inverted vs spec): gravity LP must point along "up"
      if (S.u && Math.hypot(S.lp[0], S.lp[1], S.lp[2]) > 4) { var d = S.lp[0] * S.u[0] + S.lp[1] * S.u[1] + S.lp[2] * S.u[2]; if (Math.abs(d) > 3) S.s = d > 0 ? 1 : -1; }
      lin = (ac && typeof ac.x === 'number' && ac.x !== null) ? [ac.x, ac.y, ac.z] : [g[0] - S.lp[0], g[1] - S.lp[1], g[2] - S.lp[2]];
    } else if (ac && typeof ac.x === 'number' && ac.x !== null) lin = [ac.x, ac.y, ac.z];
    if (!lin || !S.u || S.mode !== 'run' || S.touchMode) return;
    var up = S.s * (lin[0] * S.u[0] + lin[1] * S.u[1] + lin[2] * S.u[2]);
    // flick state machine: rising edge -> collect peak for ~70ms -> fire one scoop
    if (!S.flick) {
      if (up > TUNE.flickMin && now - S.lastScoopAt > TUNE.cooldownMs && now > S.calUntil) S.flick = { t0: now, peak: up };
    } else {
      if (up > S.flick.peak) S.flick.peak = up;
      if (now - S.flick.t0 >= TUNE.collectMs) { var p = S.flick.peak; S.flick = null; S.lastScoopAt = now; S.vx = S.vy = 0; S.holdUntil = now + 450; sendScoop(p); }
    }
  }

  function calibrate() {
    S.calUntil = Date.now() + 700; S.calAcc = []; S.vx = S.vy = 0;
    $('msg').textContent = '校正中…請握穩不要動';
    setTimeout(function () {
      if (S.calAcc && S.calAcc.length) { var m = [0, 0, 0]; S.calAcc.forEach(function (u) { m[0] += u[0]; m[1] += u[1]; m[2] += u[2]; }); S.u0 = norm(m); }
      else if (S.u) S.u0 = S.u.slice();
      S.calAcc = null; render();
    }, 720);
  }

  // 50 Hz: tilt -> velocity (deadzone + response curve + smoothing) -> integrated position; send at <=20 Hz
  function tick() {
    var now = Date.now(), dt = Math.min(0.1, (now - (S.lastTick || now)) / 1000); S.lastTick = now;
    if (S.mode !== 'run' || S.touchMode) { sendIn(false); return; }
    var tx = 0, ty = 0;
    if (S.u && S.u0 && now > S.calUntil) {
      var u = S.u, u0 = S.u0, dx = u[0] - u0[0], dyv = u[1] - u0[1], dz = u[2] - u0[2];
      // pose-independent: divide by how much a roll / pitch of 1 rad moves the gravity vector from the calibrated pose
      var kx = 1 / Math.max(0.35, Math.hypot(u0[0], u0[2])), ky = 1 / Math.max(0.35, Math.hypot(u0[1], u0[2]));
      tx = -dx * kx;                             // right edge down -> net right
      var tn = Math.hypot(u0[1], u0[2]) || 1, t1 = u0[2] / tn, t2 = -u0[1] / tn;   // pitch tangent in the y-z plane
      ty = (dyv * t1 + dz * t2) * ky;            // top edge down (away) -> negative -> net moves up the screen
    }
    S.tx = tx; S.ty = ty;
    var tvx = 0, tvy = 0;
    if (now >= (S.holdUntil || 0) && !S.flick) {
      var mag = Math.hypot(tx, ty);
      if (mag > TUNE.dead) {
        var f = Math.min(1, (mag - TUNE.dead) / (TUNE.range - TUNE.dead)); f = Math.pow(f, 1.3);
        tvx = tx / mag * f * TUNE.vmax; tvy = ty / mag * f * TUNE.vmax;
      }
    }
    var k = 1 - Math.exp(-dt * 12); S.vx += (tvx - S.vx) * k; S.vy += (tvy - S.vy) * k;
    if (Math.abs(S.vx) > 0.4 || Math.abs(S.vy) > 0.4) { S.cx += S.vx * dt; S.cy += S.vy * dt; S.dirty = true; }
    sendIn(false);
    // tilt dot
    var el = $('tilt'); var w = el.clientWidth / 2 - 18, h = el.clientHeight / 2 - 18;
    $('dot').style.transform = 'translate(' + Math.max(-1, Math.min(1, tx / TUNE.range)) * w + 'px,' + Math.max(-1, Math.min(1, ty / TUNE.range)) * h + 'px)';
    // sensor watchdog
    if (now - S.lastOri > 3000 && S.lastOri) showBad('lost');
  }
  setInterval(tick, 20);

  function flickMeter(peak) {
    var max = S.brk * 1.25, pct = Math.min(100, peak / max * 100);
    $('ffill').style.width = pct + '%'; $('fval').textContent = peak.toFixed(1) + (peak >= S.brk ? ' 太用力!' : ' OK');
    $('ffill').style.background = peak >= S.brk ? '#e8423c' : PCOL[Math.max(0, S.slot)];
    $('fzone').style.left = (TUNE.flickMin / max * 100) + '%'; $('fzone').style.width = ((S.brk - TUNE.flickMin) / max * 100) + '%';
    $('fbreak').style.width = (100 - S.brk / max * 100) + '%';
    clearTimeout(S.fmT); S.fmT = setTimeout(function () { $('ffill').style.width = '0'; }, 1400);
  }

  /* ================= permission flow ================= */
  function isIOS() { return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }
  function showScreen(which) {
    $('scr').classList.toggle('show', which !== 'none');
    $('scr-start').style.display = which === 'start' ? 'contents' : 'none';
    $('scr-bad').style.display = which === 'bad' ? 'contents' : 'none';
  }
  function showBad(reason, detail) {
    S.mode = 'bad'; S.u = null; S.u0 = null; showScreen('bad');
    var ios = isIOS(), steps = [], why = '', title = '無法使用動作感應器', note = '';
    if (reason === 'denied') {
      why = '你剛剛沒有允許「動作與方向」存取（或被系統拒絕）。撈金魚要靠手機的傾斜和揮動來玩，沒有這個權限就無法操作。';
      if (ios) {
        steps = ['完全關閉 Safari：從螢幕底部往上滑停住開啟 App 切換畫面，把 Safari 往上滑掉。',
          '重新打開 Safari，再掃一次 QR code，按「開始」，在跳出的詢問選「允許」。',
          '如果還是沒有跳出詢問：到「設定 > App > Safari > 進階 > 網站資料」，刪除本網站（wei777942.github.io）的資料，再重掃 QR code。',
          '如果是從 LINE、Instagram 等 App 內建瀏覽器打開的，請改用 Safari 開啟。'];
        note = 'iPhone 沒有「動作與方向」的總開關：這項權限是每次由網站詢問；被拒絕後，Safari 通常要完全關閉重開才會再問一次。';
      } else {
        steps = ['點網址列左側的圖示（鎖頭或設定圖示）進入網站設定，把「動作感應器」設為允許，然後重新整理頁面。',
          '如果是從 LINE、Instagram 等 App 內建瀏覽器打開的，請改用 Chrome 或系統瀏覽器開啟。', '關閉這個分頁後重新掃 QR code，再按「開始」。'];
      }
    } else if (reason === 'nosensor') {
      title = '偵測不到動作感應器';
      why = '這個瀏覽器沒有送出傾斜或加速度資料。可能是電腦瀏覽器、沒有感應器的裝置，或系統把感應器關掉了。';
      steps = ['請用手機的 Safari（iPhone）或 Chrome（Android）打開，不要用電腦。', '不要用 LINE、Instagram 等 App 內建瀏覽器，改用系統瀏覽器。',
        ios ? '若剛按過「不允許」，請照上一步完全關閉 Safari 後重新掃 QR code。' : '確認手機沒有開啟省電模式或關閉感應器，並允許網站使用「動作感應器」。'];
    } else if (reason === 'lost') {
      title = '感應器沒有資料了';
      why = '剛剛還有感應器資料，但現在停止了（可能切換到別的 App、螢幕鎖定，或瀏覽器暫停了感應器）。';
      steps = ['保持這個畫面在最前面、螢幕不要鎖定。', '按「重試」重新啟用感應器。'];
    } else if (reason === 'error') {
      why = '要求權限時發生錯誤：' + (detail || '未知錯誤') + '。請確認網址是 https:// 開頭，並且是從按鈕直接點擊觸發。';
      steps = ['按「重試」再試一次。', '仍然失敗請關閉分頁，重新掃 QR code。'];
    }
    $('badtitle').textContent = title; $('badwhy').textContent = why;
    $('badsteps').innerHTML = ''; steps.forEach(function (t) { var li = document.createElement('li'); li.textContent = t; $('badsteps').appendChild(li); });
    $('badnote').textContent = note; S.badReason = reason; render();
  }

  var listening = false;
  function attach() {
    if (listening) return; listening = true;
    window.addEventListener('deviceorientation', onOri); window.addEventListener('devicemotion', onMot);
  }
  function onStartTap() {
    // requestPermission() MUST be invoked synchronously inside the tap handler (iOS user-gesture rule)
    var reqs = [], names = [];
    try { if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') { reqs.push(DeviceMotionEvent.requestPermission()); names.push('motion'); } } catch (e) { reqs.push(Promise.reject(e)); names.push('motion'); }
    try { if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') { reqs.push(DeviceOrientationEvent.requestPermission()); names.push('orientation'); } } catch (e) { reqs.push(Promise.reject(e)); names.push('orientation'); }
    S.tries++;
    $('startbtn').disabled = true; $('retrybtn').disabled = true;
    Promise.all(reqs.map(function (p) { return Promise.resolve(p).then(function (v) { return { v: v }; }, function (e) { return { err: e }; }); })).then(function (rs) {
      $('startbtn').disabled = false; $('retrybtn').disabled = false;
      var denied = rs.some(function (r) { return !r.err && r.v !== 'granted'; }), err = rs.filter(function (r) { return r.err; })[0];
      if (denied) { showBad('denied'); return; }
      if (err) { showBad(/NotAllowed/i.test(String(err.err && err.err.name)) ? 'denied' : 'error', String(err.err && (err.err.message || err.err.name))); return; }
      beginSensing();
    });
  }
  function beginSensing() {
    S.lastOri = 0; S.u = null; S.orient = 0; S.motion = 0; S.lp = null; attach();
    var t0 = Date.now(), iv = setInterval(function () {
      if (S.orient > 0 && S.motion > 0 || S.orient > 0 && Date.now() - t0 > 2500) { clearInterval(iv); finishStart(); }
      else if (Date.now() - t0 > 3000) { clearInterval(iv); showBad('nosensor'); }
    }, 80);
  }
  function finishStart() {
    S.mode = 'run'; S.touchMode = false; S.u0 = null; S.cx = S.cx; showScreen('none'); calibrate();
    sendIn(true); hi(); render();
  }
  $('startbtn').addEventListener('click', onStartTap);
  $('retrybtn').addEventListener('click', onStartTap);
  $('recal').addEventListener('click', function () { calibrate(); if (navigator.vibrate) navigator.vibrate(15); });
  $('ready').addEventListener('click', function () { S.rc++; sendIn(true); setTimeout(function () { sendIn(true); }, 120); setTimeout(function () { sendIn(true); }, 400); if (navigator.vibrate) navigator.vibrate(20); });

  /* hidden debug fallback: ?touch=1 shows a touch-only mode (drag the tilt box to move, button = scoop of fixed strength) */
  if (Q.get('touch') === '1') {
    $('touchbtn').style.display = 'inline-block'; $('dbg').style.display = 'flex';
    $('touchbtn').addEventListener('click', function () { S.mode = 'run'; S.touchMode = true; showScreen('none'); sendIn(true); hi(); render(); });
    var tl = $('tilt'), ptr = null, lx = 0, ly = 0;
    tl.addEventListener('pointerdown', function (e) { if (!S.touchMode) return; ptr = e.pointerId; lx = e.clientX; ly = e.clientY; tl.setPointerCapture(e.pointerId); });
    tl.addEventListener('pointermove', function (e) { if (e.pointerId !== ptr) return; S.cx += e.clientX - lx; S.cy += e.clientY - ly; lx = e.clientX; ly = e.clientY; S.dirty = true; sendIn(false); });
    tl.addEventListener('pointerup', function () { ptr = null; });
    $('dbgscoop').addEventListener('click', function () { sendScoop(15); });
    setInterval(function () { if (S.touchMode) sendIn(false); }, 45);
  }
  ['contextmenu', 'selectstart', 'dragstart'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });

  /* ================= feedback / render ================= */
  function events(m) {
    (m.ev || []).forEach(function (e) {
      if (S.seenEv[e.id]) return; S.seenEv[e.id] = 1;
      if (S.slot < 0 || e.s !== S.slot) return;
      var bad = e.y === 'x' || e.y === 'v';
      var d = document.createElement('div'); d.className = 'pop' + (bad ? ' x' : ''); d.textContent = e.y === 'v' ? '太用力!' : e.y === 'x' ? '破了!' : '+' + e.p; $('pops').appendChild(d); setTimeout(function () { d.remove(); }, 1200);
      if (navigator.vibrate) navigator.vibrate(bad ? [60, 40, 60] : e.y === 'r' ? [30, 30, 30, 30, 60] : 25);
    });
  }
  function render() {
    var m = S.st, me = m && S.slot >= 0 ? m.pl[S.slot] : null, now = Date.now();
    var hostOn = m && now - S.lastSt < 3500;
    $('pname').textContent = S.full ? '房間已滿' : S.slot >= 0 ? 'P' + (S.slot + 1) + (S.slot ? ' 綠' : ' 粉') : (S.relayOn ? '加入中…' : '連線中…');
    var c;
    if (!S.relayOn) c = ['off', '中繼離線 · 重連中…']; else if (!hostOn) c = ['warn', S.joined ? '大螢幕無回應 · 重連中…' : '尋找大螢幕…']; else c = ['on', '已連線 · 房間 ' + room];
    $('app').classList.toggle('offline', !S.relayOn || !hostOn);
    $('conn').innerHTML = '<span class="dot ' + c[0] + '"></span>' + c[1];
    if (!me || !hostOn) { $('ready').style.display = 'none'; $('hint').style.display = ''; $('msg').textContent = S.full ? '這個房間已有兩位玩家' : ''; if (!me) return; }
    $('sc').textContent = me.sc;
    var ph = m.ph, tl = Math.ceil(m.t);
    $('tm').textContent = ph === 'play' ? (tl + 's') : ph === 'countdown' ? m.cd : ph === 'end' ? '0s' : '--';
    $('barfill').style.width = me.du + '%'; $('barfill').style.background = me.du > 50 ? '#b6f23a' : me.du > 25 ? '#ffd23f' : '#e8423c';
    $('nstxt').textContent = me.br > 0 ? '破了! ' + Math.ceil(me.br) + ' 秒後換新網' : me.du + '%';
    var playing = ph === 'play';
    var showReady = (ph === 'lobby' || ph === 'end') && hostOn && S.mode === 'run';
    $('ready').style.display = showReady ? 'block' : 'none'; $('hint').style.display = showReady ? 'none' : 'flex';
    $('ready').disabled = !!me.rd; $('ready').textContent = me.rd ? 'READY! 等對手' : 'READY';
    var msg = '';
    if (S.calAcc) msg = '校正中…請握穩不要動';
    else if (ph === 'lobby') msg = me.rd ? '等待另一位玩家 READY…' : '握穩手機，準備好就按 READY';
    else if (ph === 'countdown') msg = '準備!（倒數時自動校正）';
    else if (playing) msg = me.br > 0 ? '紙網破了…等新網' : '傾斜移動 · 往上快速一甩撈起';
    $('msg').textContent = hostOn ? msg : '';
    $('hint').textContent = me.br > 0 ? '紙網破了！等新網…' : playing ? '往上快速一甩 = 撈!' : '往上快速一甩 = 撈!';
    $('tilt').classList.toggle('act', Math.hypot(S.tx || 0, S.ty || 0) > TUNE.dead);
    var over = $('over');
    if (ph === 'end') {
      var w = m.w, me2 = m.pl[S.slot], other = m.pl[1 - S.slot];
      $('overh').textContent = w === -1 ? '平手!' : w === S.slot ? '你贏了!' : '你輸了…';
      $('overh').style.color = w === S.slot ? '#ffd23f' : w === -1 ? '#fff4d6' : '#9aa3c7';
      $('overp').innerHTML = '你 <b style="color:' + PCOL[S.slot] + '">' + me2.sc + '</b> 分 vs 對手 ' + other.sc + ' 分<br><small>小×' + me2.cs + ' 大×' + me2.cb + ' 稀有×' + me2.cr + '</small>';
      over.style.display = 'flex'; over.style.pointerEvents = 'none';
      var rb = $('actrow').getBoundingClientRect(); over.style.height = Math.max(200, rb.top - 6) + 'px';
    } else over.style.display = 'none';
  }
  setInterval(render, 500);
  if (navigator.wakeLock) { var wl = function () { navigator.wakeLock.request('screen').catch(function () {}); }; wl(); document.addEventListener('visibilitychange', function () { if (!document.hidden) wl(); }); }
  showScreen('start');
  window.__gfp = { S: S, hub: hub, cid: cid, TUNE: TUNE };
  render();
})();
