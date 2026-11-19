/* 撈金魚 phone controller (motion sensing). Sends input only; renders what the big screen says.
 *  - tilt away from neutral (deviceorientation) -> net goes DOWN into the water and moves (rate control, sent as cumulative counters)
 *  - return to neutral (inside the deadzone, held ~200ms) -> ONE 'sc' scoop event with the snap-back speed; host decides the catch (no wear out of water) */
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

  // dead: tilt (|delta gravity|, ~sin angle) that puts the net in the water; exit: inside this for exitHold ms = scoop
  var TUNE = { dead: 0.07, exit: 0.06, exitHold: 200, minDip: 350, range: 0.42, vmax: 230, rateMs: 50, keepMs: 450 };
  var S = { slot: -1, st: null, lastSt: 0, joined: false, full: false, relayOn: false, seq: 0, cx: 0, cy: 0, rc: 0, sn: 0, ss: 0,
    seenEv: {}, lastSent: 0, dirty: false, mode: 'start' /* start|bad|run */, touchMode: false, tries: 0,
    u: null, u0: null, calUntil: 0, calAcc: null, vx: 0, vy: 0, lastOri: 0, tx: 0, ty: 0, lastTick: 0,
    down: false, downAt: 0, inDead: 0, hist: [], orient: 0, sendN: 0, scN: 0, lastSnap: 0 };

  /* ================= relay ================= */
  var hub = new GFRelay.Hub({
    sub: 'gf1-' + room + '-d', pub: 'gf1-' + room + '-u',
    onmsg: function (m) {
      if (m.k === 'full' && m.c === cid) { S.full = true; render(); return; }
      if (m.k !== 'st') return;
      S.st = m; S.lastSt = Date.now();
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
    hub.send({ k: 'in', c: cid, s: S.seq, x: Math.round(S.cx * 10) / 10, y: Math.round(S.cy * 10) / 10, d: S.down ? 1 : 0, rc: S.rc, sn: S.sn, ss: S.ss, mo: S.mode === 'run' ? 1 : 0, ts: now }, !force);
  }
  function sendScoop(snap) {
    S.sn++; S.ss = Math.round(snap * 100) / 100; S.scN++; S.seq++; S.sendN++;
    var ts = Date.now(), q = S.seq;
    // 'in' with d:0 first (it also carries the scoop counter), then the dedicated 'sc' event, re-sent twice with the same id
    hub.send({ k: 'in', c: cid, s: q, x: Math.round(S.cx * 10) / 10, y: Math.round(S.cy * 10) / 10, d: 0, rc: S.rc, sn: S.sn, ss: S.ss, mo: 1, ts: ts });
    var m = { k: 'sc', c: cid, n: S.sn, str: S.ss, q: q, ts: ts };
    hub.send(m); setTimeout(function () { hub.send(m); }, 90); setTimeout(function () { hub.send(m); }, 300);
    if (navigator.vibrate) navigator.vibrate(25);
    var d = $('dot'); d.classList.remove('lift'); void d.offsetWidth; d.classList.add('lift'); setTimeout(function () { d.classList.remove('lift'); }, 600);
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
  function calibrate() {
    S.calUntil = Date.now() + 700; S.calAcc = []; S.vx = S.vy = 0; S.down = false; S.inDead = 0; S.hist = [];
    $('msg').textContent = '校正中…';
    setTimeout(function () {
      if (S.calAcc && S.calAcc.length) { var m = [0, 0, 0]; S.calAcc.forEach(function (u) { m[0] += u[0]; m[1] += u[1]; m[2] += u[2]; }); S.u0 = norm(m); }
      else if (S.u) S.u0 = S.u.slice();
      S.calAcc = null; render();
    }, 720);
  }

  // snap-back speed: fastest drop of the tilt magnitude over ~100ms in the last 700ms (rad/s)
  function snapSpeed(now) {
    var h = S.hist, best = 0;
    for (var i = 0; i < h.length; i++) for (var j = i + 1; j < h.length; j++) {
      var dt = h[j].t - h[i].t; if (dt < 80) continue; if (dt > 160) break;
      var r = (h[i].m - h[j].m) / (dt / 1000); if (r > best) best = r;
    }
    return best;
  }
  function drawNetIcon() {
    var st = S.wear || 0, key = st + '|' + S.slot; if (S.iconKey === key) return; S.iconKey = key;
    var cv = $('netcv'), g = cv.getContext('2d'); g.clearRect(0, 0, 40, 40); g.drawImage(NetSprite.get(st, PCOL[S.slot >= 0 ? S.slot : 0], false), 0, 0);
  }
  function setNetState(st) { // 'down' | 'up' | 'broken' : visual only
    ['dot', 'netico'].forEach(function (id) { var el = $(id); ['down', 'up', 'broken'].forEach(function (c) { el.classList.toggle(c, c === st); }); });
  }
  // 50 Hz: tilt -> velocity (deadzone + curve + smoothing) -> integrated position; send at <=20 Hz
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
    var mag = Math.hypot(tx, ty), tvx = 0, tvy = 0;
    S.hist.push({ t: now, m: mag }); while (S.hist.length && now - S.hist[0].t > 800) S.hist.shift();
    if (mag > TUNE.dead) {
      var f = Math.min(1, (mag - TUNE.dead) / (TUNE.range - TUNE.dead)); f = Math.pow(f, 1.3);
      tvx = tx / mag * f * TUNE.vmax; tvy = ty / mag * f * TUNE.vmax;
    }
    var k = 1 - Math.exp(-dt * 12); S.vx += (tvx - S.vx) * k; S.vy += (tvy - S.vy) * k;
    if (Math.abs(S.vx) > 0.4 || Math.abs(S.vy) > 0.4) { S.cx += S.vx * dt; S.cy += S.vy * dt; S.dirty = true; }
    // dip / lift state machine
    var calibrating = !!S.calAcc || now <= S.calUntil || !S.u0, brokenNow = S.st && S.slot >= 0 && S.st.pl[S.slot] && S.st.pl[S.slot].br > 0;
    if (calibrating) { S.down = false; S.inDead = 0; }
    else if (!S.down) {
      if (mag > TUNE.dead) { S.down = true; S.downAt = now; S.inDead = 0; sendIn(true); if (navigator.vibrate) navigator.vibrate(8); }
    } else if (mag < TUNE.exit) {
      if (!S.inDead) S.inDead = now;
      else if (now - S.inDead >= TUNE.exitHold) {          // back at centre for ~200ms: LIFT
        var held = S.inDead - S.downAt, snap = snapSpeed(S.inDead + 40);
        S.down = false; S.inDead = 0; S.vx = S.vy = 0; S.lastSnap = snap;
        if (held >= TUNE.minDip) sendScoop(snap); else sendIn(true);
      }
    } else S.inDead = 0;
    setNetState(brokenNow ? 'broken' : S.down ? 'down' : 'up');
    sendIn(false);
    var el = $('tilt'); var wd = el.clientWidth / 2 - 18, ht = el.clientHeight / 2 - 18;
    var px = Math.max(-1, Math.min(1, tx / TUNE.range)) * wd + 'px', py = Math.max(-1, Math.min(1, ty / TUNE.range)) * ht + 'px', dt0 = $('dot');
    dt0.style.setProperty('--tx', px); dt0.style.setProperty('--ty', py); dt0.style.transform = 'translate(' + px + ',' + py + ')';
    if (now - S.lastOri > 3000 && S.lastOri) showBad('lost');
  }
  setInterval(tick, 20);

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
    window.addEventListener('deviceorientation', onOri);
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
    S.lastOri = 0; S.u = null; S.orient = 0; attach();
    var t0 = Date.now(), iv = setInterval(function () {
      if (S.orient > 0) { clearInterval(iv); finishStart(); }
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
    $('dbgscoop').addEventListener('click', function () { S.down = true; S.downAt = Date.now() - 500; sendIn(true); setTimeout(function () { S.down = false; sendScoop(1); }, 100); });
    setInterval(function () { if (S.touchMode) sendIn(false); }, 45);
  }
  ['contextmenu', 'selectstart', 'dragstart'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });

  /* ================= feedback / render ================= */
  function events(m) {
    (m.ev || []).forEach(function (e) {
      if (S.seenEv[e.id]) return; S.seenEv[e.id] = 1;
      if (S.slot < 0 || e.s !== S.slot) return;
      var bad = e.y === 'x' || e.y === 'v';
      var d = document.createElement('div'); d.className = 'pop' + (bad ? ' x' : ''); d.textContent = bad ? 'X' : '+' + e.p; $('pops').appendChild(d); setTimeout(function () { d.remove(); }, 1200);
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
    S.wear = NetSprite.stageOf(me.du, me.br > 0); drawNetIcon();
    var playing = ph === 'play';
    var showReady = (ph === 'lobby' || ph === 'end') && hostOn && S.mode === 'run';
    $('ready').style.display = showReady ? 'block' : 'none'; $('hint').style.display = showReady ? 'none' : 'flex';
    $('ready').disabled = !!me.rd; $('ready').textContent = me.rd ? 'READY! 等對手' : 'READY';
    var msg = '';
    if (S.calAcc) msg = '校正中…請握穩不要動';
    else if (ph === 'lobby') msg = me.rd ? '等待另一位玩家 READY…' : '握穩手機，準備好就按 READY';
    else if (ph === 'countdown') msg = '準備!（倒數時自動校正）';
    else if (playing) msg = me.br > 0 ? '紙網破了…等新網' : '傾斜移動 · 往上快速一甩撈起';
    $('msg').textContent = hostOn && S.calAcc ? '校正中…' : '';
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
