/* 撈金魚 big-screen host. Authoritative game logic lives here; phones only send input. */
(function () {
  'use strict';
  var W = 320, H = 180;
  var cv = document.getElementById('c'), ctx = cv.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  var Q = new URLSearchParams(location.search);
  var DURATION = Math.max(5, +Q.get('dur') || 60);
  var PX0 = 8, PY0 = 26, PX1 = 312, PY1 = 172;          // pond rect
  var NET_R = 13, GAIN = +Q.get('gain') || 0.5;
  var SCOOP_MIN = 7, SCOOP_BREAK = +Q.get('brk') || 26; // flick strength (m/s^2) window: below min = no scoop, above break = net tears
  var PAL = {
    ink: '#14102a', deep: '#0b2a5b', water: '#1456a0', water2: '#1b6ab8', light: '#2d86d6', hi: '#7cc8ff',
    stone: '#3c4166', stone2: '#6b7399', stone3: '#9aa3c7', lily: '#2e9e4f', lily2: '#5fd36b',
    cream: '#fff4d6', orange: '#ff9a2e', red: '#e8423c', dred: '#8b1d2c', gold: '#ffd23f', gold2: '#ff9f1c',
    blk: '#241b3d', blk2: '#5a4a8a', pink: '#ff4f8b', lime: '#b6f23a', white: '#ffffff', ground: '#2b1d3a', ground2: '#3d2a52', wood: '#7a4a2a'
  };
  var PCOL = [PAL.pink, PAL.lime], PNAME = ['P1', 'P2'];

  /* ---------- pixel text (threshold-rendered so it stays crisp & palette-limited) ---------- */
  var tcache = {}, tn = 0;
  function bmp(s, col, size) {
    var k = size + '|' + col + '|' + s, b = tcache[k];
    if (b) return b;
    if (++tn > 600) { tcache = {}; tn = 0; }
    var c = document.createElement('canvas'), g = c.getContext('2d', { willReadFrequently: true });
    g.font = size + 'px Fusion, monospace';
    var w = Math.ceil(g.measureText(s).width) + 2; c.width = w; c.height = size + 4;
    g.font = size + 'px Fusion, monospace'; g.textBaseline = 'top'; g.fillStyle = '#fff'; g.fillText(s, 1, 1);
    var d = g.getImageData(0, 0, c.width, c.height), p = d.data, r = parseInt(col.slice(1, 3), 16), gg = parseInt(col.slice(3, 5), 16), bb = parseInt(col.slice(5, 7), 16);
    for (var i = 0; i < p.length; i += 4) { if (p[i + 3] >= 110) { p[i] = r; p[i + 1] = gg; p[i + 2] = bb; p[i + 3] = 255; } else p[i + 3] = 0; }
    g.putImageData(d, 0, 0);
    return (tcache[k] = c);
  }
  // T(str,x,y,color,{sc,al:'l|c|r',sh:shadowColor,size})
  function T(s, x, y, col, o) {
    o = o || {}; var sc = o.sc || 1, b = bmp(String(s), col, o.size || 12), w = b.width * sc, h = b.height * sc;
    var dx = o.al === 'c' ? Math.round(x - w / 2) : o.al === 'r' ? Math.round(x - w) : Math.round(x);
    y = Math.round(y);
    if (o.sh) { ctx.drawImage(bmp(String(s), o.sh, o.size || 12), dx + sc, y + sc, w, h); }
    ctx.drawImage(b, dx, y, w, h);
    return w;
  }
  function R(x, y, w, h, col) { ctx.fillStyle = col; ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  function circleOutline(cx, cy, r, col) {
    ctx.fillStyle = col; cx = Math.round(cx); cy = Math.round(cy);
    for (var y = -r; y <= r; y++) { var x = Math.round(Math.sqrt(r * r - y * y)); ctx.fillRect(cx - x, cy + y, 1, 1); ctx.fillRect(cx + x, cy + y, 1, 1); }
    for (var xx = -r; xx <= r; xx++) { var yy = Math.round(Math.sqrt(r * r - xx * xx)); ctx.fillRect(cx + xx, cy - yy, 1, 1); ctx.fillRect(cx + xx, cy + yy, 1, 1); }
  }
  function circleDither(cx, cy, r, col, phase) {
    ctx.fillStyle = col; cx = Math.round(cx); cy = Math.round(cy);
    for (var y = -r; y <= r; y++) { var x = Math.floor(Math.sqrt(r * r - y * y)); for (var xx = -x; xx <= x; xx++) if (((xx + y + phase) & 1) === 0) ctx.fillRect(cx + xx, cy + y, 1, 1); }
  }

  /* ---------- sprites ---------- */
  function ell(g, cx, cy, rx, ry, col) { g.fillStyle = col; for (var y = -ry; y <= ry; y++) { var w = Math.round(rx * Math.sqrt(1 - (y * y) / (ry * ry + 0.0001))); g.fillRect(cx - w, cy + y, w * 2 + 1, 1); } }
  function makeFish(len, hh, body, belly, fin, eyeCol, frame) {
    var w = len + Math.round(len * 0.45), h = hh * 2 + 5, c = document.createElement('canvas'); c.width = w; c.height = h;
    var g = c.getContext('2d'), cy = Math.floor(h / 2), bx = w - Math.round(len / 2) - 1;
    // tail (left), wiggles
    var tl = Math.round(len * 0.42), off = frame ? 1 : -1;
    g.fillStyle = fin;
    for (var i = 0; i < tl; i++) { var sp = Math.round(i * (hh * 0.9) / tl); g.fillRect(i, cy - sp + (i > tl / 2 ? off : 0), 1, sp * 2 + 1); }
    ell(g, bx, cy, Math.round(len / 2), hh, body);
    ell(g, bx + 1, cy + Math.floor(hh / 2), Math.round(len / 2) - 2, Math.max(1, Math.floor(hh / 2)), belly);
    g.fillStyle = fin; g.fillRect(bx - 2, cy - hh - 1, Math.max(3, Math.round(len / 4)), 2); // dorsal
    g.fillStyle = PAL.white; g.fillRect(bx + Math.round(len / 2) - 3, cy - Math.floor(hh / 3) - 1, 2, 2);
    g.fillStyle = eyeCol; g.fillRect(bx + Math.round(len / 2) - 2, cy - Math.floor(hh / 3), 1, 1);
    return c;
  }
  var TYPES = {
    s: { pts: 1, len: 10, hh: 3, body: PAL.orange, belly: PAL.cream, fin: PAL.gold2, speed: [14, 24], cost: 6, n: 14 },
    b: { pts: 3, len: 19, hh: 6, body: PAL.red, belly: PAL.orange, fin: PAL.dred, speed: [9, 15], cost: 20, n: 4 },
    g: { pts: 5, len: 13, hh: 4, body: PAL.gold, belly: PAL.cream, fin: PAL.gold2, speed: [30, 42], cost: 12, n: 1, rare: 1 },
    k: { pts: 5, len: 13, hh: 4, body: PAL.blk, belly: PAL.blk2, fin: PAL.blk2, speed: [30, 42], cost: 12, n: 1, rare: 1 }
  };
  Object.keys(TYPES).forEach(function (k) {
    var t = TYPES[k]; t.spr = [0, 1].map(function (f) { return makeFish(t.len, t.hh, t.body, t.belly, t.fin, k === 'k' ? PAL.red : PAL.ink, f); });
    t.spr = t.spr.map(function (c) { var f = document.createElement('canvas'); f.width = c.width; f.height = c.height; var g = f.getContext('2d'); g.translate(c.width, 0); g.scale(-1, 1); g.drawImage(c, 0, 0); return [c, f]; });
  });

  /* ---------- static background ---------- */
  var BG = document.createElement('canvas'); BG.width = W; BG.height = H;
  (function () {
    var g = BG.getContext('2d');
    function r(x, y, w, h, c) { g.fillStyle = c; g.fillRect(x, y, w, h); }
    r(0, 0, W, H, PAL.ground);
    for (var y = 0; y < H; y += 4) for (var x = (y / 4 % 2) * 4; x < W; x += 8) r(x, y, 2, 1, PAL.ground2);
    // water: banded dither
    var bands = [PAL.water, PAL.water2, PAL.water, PAL.deep];
    r(PX0 - 3, PY0 - 3, PX1 - PX0 + 6, PY1 - PY0 + 6, PAL.stone);
    for (y = PY0; y < PY1; y++) for (x = PX0; x < PX1; x++) {
      var band = Math.floor((y - PY0) / 12) % 4, c = bands[band];
      if (((x + y) & 1) === 0 && ((y - PY0) % 12) > 8) c = PAL.light;
      r(x, y, 1, 1, c);
    }
    // stones
    for (x = PX0 - 3; x < PX1 + 3; x += 6) { r(x, PY0 - 3, 5, 3, PAL.stone2); r(x, PY1, 5, 3, PAL.stone2); r(x, PY0 - 3, 5, 1, PAL.stone3); r(x, PY1, 5, 1, PAL.stone3); }
    for (y = PY0 - 3; y < PY1 + 3; y += 6) { r(PX0 - 3, y, 3, 5, PAL.stone2); r(PX1, y, 3, 5, PAL.stone2); r(PX0 - 3, y, 1, 5, PAL.stone3); r(PX1, y, 1, 5, PAL.stone3); }
    // lily pads
    [[40, 150], [280, 60], [150, 40], [262, 150]].forEach(function (p) {
      for (var yy = -4; yy <= 4; yy++) { var w = Math.round(6 * Math.sqrt(1 - yy * yy / 17)); r(p[0] - w, p[1] + yy, w * 2 + 1, 1, PAL.lily); }
      r(p[0] - 2, p[1] - 1, 3, 1, PAL.lily2); r(p[0] + 1, p[1], 5, 1, PAL.water);
    });
    // lanterns on the ground
    [[4, 40], [4, 120], [316, 40], [316, 120]].forEach(function (p) { r(p[0] - 2, p[1] - 3, 5, 7, PAL.red); r(p[0] - 1, p[1] - 4, 3, 1, PAL.gold); r(p[0] - 1, p[1] + 4, 3, 1, PAL.gold); r(p[0], p[1] - 2, 1, 4, PAL.gold); });
  })();
  var SPARK = []; for (var i = 0; i < 46; i++) SPARK.push([PX0 + 4 + Math.random() * (PX1 - PX0 - 10) | 0, PY0 + 3 + Math.random() * (PY1 - PY0 - 8) | 0, Math.random() * 6.28]);

  /* ---------- sound (WebAudio 8-bit) ---------- */
  var AC = null, muted = false;
  function audioInit() { if (!AC) { try { AC = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) {} } if (AC && AC.state === 'suspended') AC.resume(); }
  function tone(f, d, type, vol, slideTo, delay) {
    if (!AC || muted || AC.state !== 'running') return;
    var t = AC.currentTime + (delay || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(f, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
    g.gain.setValueAtTime(vol || 0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(g); g.connect(AC.destination); o.start(t); o.stop(t + d + 0.02);
  }
  function noise(d, vol, delay) {
    if (!AC || muted || AC.state !== 'running') return;
    var n = Math.floor(AC.sampleRate * d), b = AC.createBuffer(1, n, AC.sampleRate), a = b.getChannelData(0);
    for (var i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
    s.buffer = b; g.gain.value = vol || 0.12; s.connect(f); f.connect(g); g.connect(AC.destination); s.start(AC.currentTime + (delay || 0));
  }
  var SFX = {
    join: function () { tone(660, .08, 'square', .07); tone(880, .12, 'square', .07, 0, .08); },
    ready: function () { tone(784, .08, 'triangle', .1); tone(1175, .12, 'triangle', .1, 0, .07); },
    dip: function () { noise(.18, .1); tone(300, .12, 'sine', .06, 120); },
    lift: function () { noise(.14, .07); tone(200, .1, 'sine', .05, 500); },
    s: function () { tone(988, .07, 'square', .07); tone(1319, .1, 'square', .07, 0, .07); },
    b: function () { [523, 659, 784].forEach(function (f, i) { tone(f, .1, 'square', .08, 0, i * .07); }); },
    r: function () { [659, 784, 988, 1319, 1568].forEach(function (f, i) { tone(f, .12, 'square', .08, 0, i * .07); }); },
    miss: function () { tone(180, .12, 'square', .05, 110); },
    brk: function () { noise(.3, .14); tone(400, .35, 'sawtooth', .08, 60); },
    beep: function () { tone(660, .12, 'square', .09); },
    go: function () { tone(1320, .35, 'square', .1); },
    tick: function () { tone(1000, .05, 'square', .05); },
    end: function () { [784, 659, 523, 392].forEach(function (f, i) { tone(f, .16, 'square', .09, 0, i * .13); }); },
    win: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone(f, .13, 'square', .09, 0, i * .1); }); }
  };
  function unlock() { audioInit(); }
  ['pointerdown', 'keydown', 'touchstart', 'click'].forEach(function (e) { addEventListener(e, unlock, { passive: true }); });

  /* ---------- game state ---------- */
  var room = (Q.get('room') || sessionStorage.getItem('gf-room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(room)) { var al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; room = ''; for (var qi = 0; qi < 6; qi++) room += al[Math.floor(Math.random() * al.length)]; }
  try { sessionStorage.setItem('gf-room', room); } catch (e) {}
  var base = Q.get('base') || (location.origin + location.pathname.replace(/[^/]*$/, ''));
  var joinURL = base + 'play.html?r=' + room;

  function newPlayer(i) {
    return { i: i, cid: null, lastSeen: 0, lastSeq: -1, cx: null, cy: null, lastRc: 0, ready: false, motion: false, lastSn: 0, lastStr: 0,
      x: i ? 240 : 80, y: 110, tx: i ? 240 : 80, ty: 110, lift: 0, cool: 0, dur: 100, broken: 0, score: 0, caught: { s: 0, b: 0, r: 0 }, speed: 0 };
  }
  var G = { phase: 'lobby', players: [newPlayer(0), newPlayer(1)], fish: [], fx: [], pops: [], ev: [], evId: 1, tLeft: DURATION, cd: 0, cdT: 0, winner: null, t: 0, relay: { open: 0, total: 4 }, hostRx: 0, round: 0 };
  function connected(p) { return p.cid && (Date.now() - p.lastSeen) < 3500; }

  function rnd(a, b) { return a + Math.random() * (b - a); }
  function spawnFish(type, edge) {
    var t = TYPES[type], sp = rnd(t.speed[0], t.speed[1]), a = Math.random() * 6.283;
    var f = { type: type, x: rnd(PX0 + 16, PX1 - 16), y: rnd(PY0 + 12, PY1 - 12), a: a, sp: sp, base: sp, turn: 0, frame: 0, ft: Math.random(), bump: 0, dead: 0, respawn: 0, wob: Math.random() * 6 };
    if (edge) { f.x = Math.random() < .5 ? PX0 + 6 : PX1 - 6; f.a = f.x < 100 ? 0 : Math.PI; }
    return f;
  }
  function resetFish() {
    G.fish = [];
    Object.keys(TYPES).forEach(function (k) { for (var i = 0; i < TYPES[k].n; i++) G.fish.push(spawnFish(k)); });
  }
  resetFish();

  function startCountdown() {
    unlock();
    G.round++;
    G.players.forEach(function (p, i) { var n = newPlayer(i); ['cid', 'lastSeen', 'lastSeq', 'cx', 'cy', 'lastRc', 'motion', 'lastSn'].forEach(function (k) { n[k] = p[k]; }); G.players[i] = n; });
    resetFish(); G.fx = []; G.pops = []; G.winner = null; G.tLeft = DURATION; G.phase = 'countdown'; G.cd = 3; G.cdT = 0; SFX.beep();
  }
  function finish() {
    G.phase = 'end'; G.players.forEach(function (p) { p.ready = false; p.lift = 0; });
    var a = G.players[0].score, b = G.players[1].score; G.winner = a === b ? -1 : (a > b ? 0 : 1);
    G.endT = 0; G.conf = []; for (var i = 0; i < 70; i++) G.conf.push({ x: rnd(0, W), y: rnd(-120, 0), v: rnd(30, 70), c: [PAL.gold, PAL.pink, PAL.lime, PAL.hi, PAL.white][i % 5], w: Math.random() * 6 });
    SFX.end(); setTimeout(function () { if (G.winner >= 0) SFX.win(); }, 650);
  }

  /* ---------- relay ---------- */
  var hub = new GFRelay.Hub({
    sub: 'gf1-' + room + '-u', pub: 'gf1-' + room + '-d',
    onmsg: onPhoneMsg,
    onstatus: function (i) { G.relay = i; }
  });
  function slotOf(cid) { for (var i = 0; i < 2; i++) if (G.players[i].cid === cid) return i; return -1; }
  function onPhoneMsg(m) {
    if (!m || typeof m.c !== 'string' || m.c.length > 24) return;
    var now = Date.now(), i = slotOf(m.c), p;
    G.rx = G.rx || {}; G.rx[m.k + ':' + (i < 0 ? '?' : i)] = (G.rx[m.k + ':' + (i < 0 ? '?' : i)] || 0) + 1;
    if (m.k === 'hi') {
      if (i < 0) { for (var j = 0; j < 2; j++) if (!G.players[j].cid) { i = j; break; } }
      if (i < 0) { // stale slot reuse: take over a slot whose phone vanished for >20s outside play
        for (j = 0; j < 2; j++) if (now - G.players[j].lastSeen > 20000 && G.phase !== 'play') { i = j; break; }
      }
      if (i < 0) { hub.send({ k: 'full', c: m.c }); return; }
      p = G.players[i];
      var wasConn = connected(p) && p.cid === m.c;
      p.cid = m.c; p.lastSeen = now; p.lastSeq = -1; p.cx = null; p.cy = null; p.lastRc = m.rc | 0; p.lastSn = m.sn | 0; p.motion = !!m.mo;
      if (!wasConn) SFX.join();
      broadcast(); return;
    }
    if (i < 0) { hub.send({ k: 'full', c: m.c }); return; }
    p = G.players[i];
    if (m.k === 'sc') { onScoopMsg(m); return; }
    if (m.k !== 'in') return;
    if (typeof m.s === 'number') { if (m.s <= p.lastSeq) return; p.lastSeq = m.s; }
    var wasDisc = !connected(p); p.lastSeen = now;
    if (typeof m.ts === 'number') { var lag = now - m.ts; if (lag > -5000 && lag < 20000) { G.lag = G.lag || { n: 0, sum: 0, max: 0, arr: [] }; G.lag.n++; G.lag.sum += lag; G.lag.max = Math.max(G.lag.max, lag); if (G.lag.arr.length < 5000) G.lag.arr.push(lag); } }
    if (wasDisc) { SFX.join(); }
    // relative motion from cumulative counters (survives lost/duplicated packets); smoothed in step()
    if (typeof m.x === 'number' && typeof m.y === 'number') {
      if (p.cx === null) { p.cx = m.x; p.cy = m.y; }
      else {
        var dx = Math.max(-500, Math.min(500, m.x - p.cx)), dy = Math.max(-500, Math.min(500, m.y - p.cy)); p.cx = m.x; p.cy = m.y;
        p.tx = Math.max(PX0 + 4, Math.min(PX1 - 4, p.tx + dx * GAIN)); p.ty = Math.max(PY0 + 4, Math.min(PY1 - 4, p.ty + dy * GAIN));
      }
    }
    p.motion = !!m.mo;
    if (typeof m.sn === 'number' && m.sn > p.lastSn) { p.lastSn = m.sn; doScoop(p, +m.ss || 0); }
    var rc = m.rc | 0;
    if (rc > p.lastRc) { if ((G.phase === 'lobby' || G.phase === 'end') && p.motion) { if (!p.ready) SFX.ready(); p.ready = true; } p.lastRc = rc; }
  }
  function onScoopMsg(m) {
    var i = slotOf(m.c); if (i < 0) return; var p = G.players[i];
    p.lastSeen = Date.now();
    if (typeof m.n === 'number' && m.n > p.lastSn) { p.lastSn = m.n; doScoop(p, +m.str || 0); }
  }

  function snapshot() {
    return {
      k: 'st', rm: room, mn: SCOOP_MIN, bk: SCOOP_BREAK, ph: G.phase, t: Math.ceil(G.tLeft * 10) / 10, cd: G.cd, w: G.winner, rd: G.round,
      pl: G.players.map(function (p) { return { c: p.cid, on: connected(p) ? 1 : 0, rd: p.ready ? 1 : 0, du: Math.max(0, Math.round(p.dur)), br: Math.ceil(p.broken * 10) / 10, lf: p.lift > 0 ? 1 : 0, mo: p.motion ? 1 : 0, sc: p.score, cs: p.caught.s, cb: p.caught.b, cr: p.caught.r }; }),
      ev: G.ev.map(function (e) { return { id: e.id, s: e.s, p: e.p, y: e.y }; })
    };
  }
  function broadcast() { hub.send(snapshot()); }
  setInterval(broadcast, 200);

  /* ---------- update ---------- */
  function addEvent(slot, pts, type) { G.ev.push({ id: G.evId++, s: slot, p: pts, y: type, t: G.t }); if (G.ev.length > 10) G.ev.shift(); }
  function splash(x, y, big) { G.fx.push({ x: x, y: y, t: 0, big: big }); }
  function pop(x, y, txt, col) { G.pops.push({ x: x, y: y, t: 0, txt: txt, col: col }); }

  function updateFish(dt) {
    G.fish.forEach(function (f) {
      var t = TYPES[f.type];
      if (f.dead) { f.respawn -= dt; if (f.respawn <= 0) { var nf = spawnFish(f.type, true); for (var k in nf) f[k] = nf[k]; } return; }
      f.turn -= dt;
      if (f.turn <= 0) { f.a += rnd(-1.1, 1.1); f.turn = rnd(.5, 2); f.sp = f.base * rnd(.7, 1.3); }
      if (f.bump > 0) f.bump -= dt;
      var sp = f.sp * (f.bump > 0 ? 2.2 : 1);
      // gently dodge dipped nets
      G.players.forEach(function (p) {
        if (p.lift <= 0 && p.broken <= 0 && G.phase === 'play') { var dx = f.x - p.x, dy = f.y - p.y, d = Math.hypot(dx, dy); if (d < NET_R + 10 && d > .1) { var k = TYPES[f.type].rare ? 1.8 : .5; f.a += Math.atan2(Math.sin(Math.atan2(dy, dx) - f.a), Math.cos(Math.atan2(dy, dx) - f.a)) * Math.min(1, dt * k); if (TYPES[f.type].rare) f.bump = Math.max(f.bump, .2); } }
      });
      f.x += Math.cos(f.a) * sp * dt; f.y += Math.sin(f.a) * sp * dt * .8;
      var mx = PX0 + t.len * .6 + 2, Mx = PX1 - t.len * .6 - 2, my = PY0 + t.hh + 3, My = PY1 - t.hh - 3;
      if (f.x < mx) { f.x = mx; f.a = Math.PI - f.a; } if (f.x > Mx) { f.x = Mx; f.a = Math.PI - f.a; }
      if (f.y < my) { f.y = my; f.a = -f.a; } if (f.y > My) { f.y = My; f.a = -f.a; }
      f.ft += dt * (4 + sp / 8); f.frame = Math.floor(f.ft) & 1;
    });
  }

  function breakNet(p, violent) {
    p.broken = 3.5; p.lift = 0; p.dur = 0; p.cool = 0; SFX.brk(); splash(p.x, p.y, true);
    pop(p.x, p.y - 20, violent ? '太用力!' : '破了!', PAL.red); addEvent(p.i, 0, violent ? 'v' : 'x');
  }
  function updatePlayers(dt) {
    var a = 1 - Math.exp(-dt * 14); // ease toward the (20-25 Hz) target positions
    G.players.forEach(function (p) {
      var ox = p.x, oy = p.y;
      p.x += (p.tx - p.x) * a; p.y += (p.ty - p.y) * a;
      p.speed = p.speed * .85 + (Math.hypot(p.x - ox, p.y - oy) / Math.max(dt, .001)) * .15;
      if (p.lift > 0) p.lift -= dt; if (p.cool > 0) p.cool -= dt;
      if (p.broken > 0) {
        p.broken -= dt;
        if (p.broken <= 0) { p.broken = 0; p.dur = 100; pop(p.x, p.y - 20, '新網!', PAL.cream); SFX.ready(); }
        return;
      }
      if (G.phase === 'play') { // paper net is always in the water: it slowly wears, faster when moving / big fish bump it
        var drain = 3 + Math.min(p.speed, 120) * 0.05;
        G.fish.forEach(function (f) { if (!f.dead && f.type === 'b' && Math.hypot(f.x - p.x, f.y - p.y) < NET_R + 3) drain += 14; });
        p.dur -= drain * dt;
        if (p.dur <= 0) breakNet(p, false);
      }
    });
  }
  function doScoop(p, str) {
    p.lastStr = str;
    if (G.phase !== 'play' || p.broken > 0 || p.cool > 0 || str < SCOOP_MIN) return;
    p.cool = .6; p.lift = .5; splash(p.x, p.y); SFX.lift();
    if (str >= SCOOP_BREAK) { breakNet(p, true); return; }   // too violent: paper tears
    var s = (str - SCOOP_MIN) / (SCOOP_BREAK - SCOOP_MIN), rad = NET_R * (.9 + .35 * s), mul = .8 + .7 * s;
    var cand = [];
    G.fish.forEach(function (f) { if (!f.dead) { var d = Math.hypot(f.x - p.x, f.y - p.y); if (d <= rad + TYPES[f.type].len * .15) cand.push([d, f]); } });
    if (!cand.length) { p.dur -= 2; SFX.miss(); return; }
    cand.sort(function (a, b) { return a[0] - b[0]; });
    cand = cand.slice(0, 3);
    var cost = 2; cand.forEach(function (c) { cost += TYPES[c[1].type].cost * mul; });
    if (p.dur - cost <= 0) { // too heavy: paper tears, fish escape
      cand.forEach(function (c) { c[1].bump = 1.2; c[1].a = Math.atan2(c[1].y - p.y, c[1].x - p.x); });
      breakNet(p, false); return;
    }
    p.dur -= cost; var best = 0, pts = 0;
    cand.forEach(function (c, i) {
      var f = c[1], t = TYPES[f.type]; pts += t.pts; p.caught[t.rare ? 'r' : f.type]++; if (t.rare) best = 2; else if (f.type === 'b' && best < 1) best = 1;
      f.dead = 1; f.respawn = t.rare ? rnd(5, 8) : f.type === 'b' ? rnd(3, 5) : rnd(1.8, 3.2); pop(f.x + i * 3, f.y - 8 - i * 9, '+' + t.pts, t.rare ? PAL.gold : PCOL[p.i]);
      G.fx.push({ x: f.x, y: f.y, t: 0, big: true });
    });
    p.score += pts; addEvent(p.i, pts, best === 2 ? 'r' : best === 1 ? 'b' : 's');
    (best === 2 ? SFX.r : best === 1 ? SFX.b : SFX.s)();
  }

  var last = performance.now();
  function step() {
    var n = performance.now(), dt = Math.min(.25, (n - last) / 1000); last = n; G.t += dt;
    G.ev = G.ev.filter(function (e) { return G.t - e.t < 3; });
    updateFish(dt);
    updatePlayers(dt);
    G.fx.forEach(function (e) { e.t += dt; }); G.fx = G.fx.filter(function (e) { return e.t < .8; });
    G.pops.forEach(function (e) { e.t += dt; }); G.pops = G.pops.filter(function (e) { return e.t < 1.1; });
    if (G.phase === 'lobby' || G.phase === 'end') {
      var both = G.players.every(function (p) { return connected(p) && p.ready; });
      if (both) startCountdown();
      if (G.phase === 'end') { G.endT += dt; (G.conf || []).forEach(function (c) { c.y += c.v * dt; if (c.y > H) c.y = -5; }); }
    } else if (G.phase === 'countdown') {
      G.cdT += dt; if (G.cdT >= 1) { G.cdT -= 1; G.cd--; if (G.cd > 0) SFX.beep(); else { G.phase = 'play'; G.tLeft = DURATION; SFX.go(); broadcast(); } }
    } else if (G.phase === 'play') {
      var before = Math.ceil(G.tLeft); G.tLeft -= dt;
      if (G.tLeft <= 10 && Math.ceil(G.tLeft) !== before && G.tLeft > 0) SFX.tick();
      if (G.tLeft <= 0) { G.tLeft = 0; finish(); broadcast(); }
    }
  }
  setInterval(step, 33);

  addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      if (G.phase === 'lobby' && G.players.some(connected)) startCountdown();
      else if (G.phase === 'end') startCountdown();
    } else if (e.key === 'm' || e.key === 'M') muted = !muted;
    else if (e.key === 'f' || e.key === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }
  });

  /* ---------- render ---------- */
  function drawFish(f) {
    var t = TYPES[f.type], dir = Math.cos(f.a) >= 0 ? 0 : 1, s = t.spr[f.frame][dir];
    var bob = Math.round(Math.sin(G.t * 3 + f.wob) * .6);
    if (f.dead) return;
    // shadow
    ctx.fillStyle = PAL.deep; var sw = s.width, sh = s.height;
    for (var y = 0; y < sh; y += 2) ctx.fillRect(Math.round(f.x - sw / 2) + 3 + (y & 2), Math.round(f.y - sh / 2) + y + 3, sw - 6, 1);
    ctx.drawImage(s, Math.round(f.x - sw / 2), Math.round(f.y - sh / 2) + bob);
    if (t.rare && ((G.t * 6 + f.wob) % 2) < 1) { var sx = Math.round(f.x + Math.sin(G.t * 5 + f.wob) * 8), sy = Math.round(f.y - 6 + Math.cos(G.t * 4) * 3); R(sx, sy - 1, 1, 3, PAL.white); R(sx - 1, sy, 3, 1, PAL.white); }
  }
  function drawNet(p) {
    var col = PCOL[p.i], x = Math.round(p.x), y = Math.round(p.y), on = connected(p), up = p.lift > 0;
    if (p.broken > 0) {
      var ox = x, oy = y; // torn frame: dashed ring + shreds
      ctx.fillStyle = PAL.stone2;
      for (var a = 0; a < 24; a++) { if (a % 5 === 2 || a % 5 === 3) continue; var an = a / 24 * 6.283; ctx.fillRect(Math.round(ox + Math.cos(an) * NET_R), Math.round(oy + Math.sin(an) * NET_R), 1, 1); }
      R(ox - 3, oy - 2, 2, 1, PAL.cream); R(ox + 2, oy + 3, 3, 1, PAL.cream); R(ox + 5, oy - 5, 1, 2, PAL.cream);
      if (((G.t * 4) | 0) & 1) T(Math.ceil(p.broken) + 's', x, y + 14, PAL.red, { al: 'c', sh: PAL.ink });
      T(PNAME[p.i], x, y - NET_R - 14, col, { al: 'c', sh: PAL.ink });
      return;
    }
    if (up) { // floating above water: shadow + raised net
      for (var yy = -NET_R; yy <= NET_R; yy += 2) { var w = Math.floor(Math.sqrt(NET_R * NET_R - yy * yy)); R(x - w + 3, y + yy + 5, w * 2, 1, PAL.deep); }
      y -= 5;
    } else {
      circleDither(x, y, NET_R, PAL.hi, 0);
      var rr = Math.floor((G.t * 10) % 3); circleOutline(x, y, NET_R + 2 + rr, PAL.hi);
    }
    var wear = 1 - p.dur / 100;
    if (up) circleDither(x, y, NET_R - 1, wear > .6 ? PAL.cream : PAL.white, 1);
    circleOutline(x, y, NET_R, col); circleOutline(x, y, NET_R - 1, col);
    if (up) { for (var h = 1; h <= 3; h++) R(x - NET_R + 3 + h, y - NET_R + 7 - h * 2 + 1, 1, 1, PAL.white); }
    // handle
    for (var k = 0; k < 9; k++) R(x + NET_R - 3 + k, y + NET_R - 3 + k, 2, 2, k < 3 ? col : PAL.wood);
    // cracks grow with wear
    var cr = Math.floor(wear * 8); ctx.fillStyle = up ? PAL.stone2 : PAL.deep;
    var cp = [[-4, -3], [-3, -2], [-2, -1], [4, 3], [3, 2], [2, 6], [-6, 4], [-5, 5], [5, -5], [6, -4]];
    for (var c = 0; c < cr && c < cp.length; c++) ctx.fillRect(x + cp[c][0], y + cp[c][1], 1, 1);
    T(PNAME[p.i], x, y - NET_R - 14, col, { al: 'c', sh: PAL.ink });
    if (!on) T('離線', x, y + NET_R + 3, PAL.red, { al: 'c', sh: PAL.ink });
  }
  function hud() {
    R(0, 0, W, 24, PAL.ink); R(0, 24, W, 1, PAL.stone);
    G.players.forEach(function (p, i) {
      var left = i === 0, x0 = left ? 5 : W - 5, on = connected(p), al = left ? 'l' : 'r';
      var w = T(PNAME[i], x0, 0, PCOL[i], { al: al });
      var dotx = left ? x0 + w + 3 : x0 - w - 6;
      R(dotx, 5, 4, 4, p.cid ? (on ? PAL.lime : PAL.red) : PAL.stone2);
      T(p.cid ? (on ? '' : '離線') : '', left ? dotx + 7 : dotx - 3, 0, PAL.red, { al: al });
      T(String(p.score), left ? x0 + 46 : x0 - 46, 0, PAL.white, { al: left ? 'l' : 'r', sc: 1, sh: PAL.dred });
      // durability bar
      var bw = 70, bx = left ? x0 : x0 - bw, pc = Math.max(0, p.dur) / 100;
      R(bx, 15, bw, 6, PAL.stone); R(bx + 1, 16, bw - 2, 4, PAL.ink);
      var bc = pc > .5 ? PAL.lime : pc > .25 ? PAL.gold : PAL.red; R(bx + 1, 16, Math.round((bw - 2) * pc), 4, bc);
      if (p.broken > 0) T('網破了', left ? bx + bw + 3 : bx - 3, 11, PAL.red, { al: left ? 'l' : 'r' });
    });
    var tl = Math.ceil(G.phase === 'lobby' || G.phase === 'countdown' ? DURATION : G.tLeft), m = Math.floor(tl / 60), s = tl % 60;
    T(m + ':' + (s < 10 ? '0' : '') + s, W / 2, 0, G.phase === 'play' && G.tLeft <= 10 ? (((G.t * 3) | 0) & 1 ? PAL.red : PAL.white) : PAL.gold, { al: 'c', sc: 1.5 | 0 || 1 });
    // relay status
    var ri = G.relay, rc = ri.open ? (ri.open === ri.total ? PAL.lime : PAL.gold) : PAL.red;
    R(W / 2 - 14, 15, 28, 6, PAL.stone); R(W / 2 - 13, 16, 26, 4, PAL.ink);
    for (var i = 0; i < ri.total; i++) R(W / 2 - 12 + i * 6, 17, 5, 2, i < ri.open ? rc : PAL.stone2);
  }
  function panel(x, y, w, h, col) { R(x - 1, y - 1, w + 2, h + 2, PAL.ink); R(x, y, w, h, col || PAL.stone); R(x + 2, y + 2, w - 4, h - 4, PAL.ink); }

  function drawQR(x, y, mod) {
    var qr = qrcode(0, 'M'); qr.addData(joinURL); qr.make(); var n = qr.getModuleCount(), q = 2;
    R(x, y, (n + q * 2) * mod, (n + q * 2) * mod, PAL.white);
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) R(x + (c + q) * mod, y + (r + q) * mod, mod, mod, PAL.ink);
    return (n + q * 2) * mod;
  }
  var qrCache = null;
  function qrImage() {
    if (!qrCache) { qrCache = document.createElement('canvas'); qrCache.width = qrCache.height = 140; var save = ctx; ctx = qrCache.getContext('2d'); var s = drawQR(0, 0, 3); ctx = save; qrCache.w = s; }
    return qrCache;
  }

  function lobby() {
    ctx.fillStyle = 'rgba(11,16,42,.78)'; ctx.fillRect(0, 25, W, H - 25);
    T('撈金魚', 160, 25, PAL.gold, { al: 'c', sc: 2, sh: PAL.dred });
    var q = qrImage(), qw = q.w; panel(6, 59, qw + 8, qw + 8, PAL.stone2);
    ctx.drawImage(q, 0, 0, qw, qw, 10, 63, qw, qw);
    var px = 134;
    T('手機掃左邊 QR 加入', px, 56, PAL.hi, {});
    T('房間碼 ' + room, px, 71, PAL.gold, {});
    G.players.forEach(function (p, i) {
      var y = 85 + i * 32, on = connected(p);
      panel(px, y, 180, 28, PCOL[i]);
      T(PNAME[i], px + 6, y + 2, PCOL[i], {});
      R(px + 30, y + 7, 4, 4, p.cid ? (on ? PAL.lime : PAL.red) : PAL.stone2);
      var st = !p.cid ? '等待加入…' : (!on ? '離線 (可重連)' : (p.ready ? 'READY!' : (p.motion ? '感應就緒' : '已連線')));
      T(st, px + 38, y + 2, p.ready && on ? PAL.lime : (on ? PAL.cream : PAL.stone3), {});
      T(!p.cid || !on || p.ready ? '' : (p.motion ? '按 READY' : '按「開始」'), px + 178, y + 2, PAL.gold, { al: 'r' });
    });
    T('雙方 READY 即開始 · Enter 強制'.replace('雙方 ', ''), px, 162, PAL.cream, {});
    T(base.replace(/^https?:\/\//, '').replace(/\/$/, '').slice(0, 40), px, 148, PAL.stone3, {});
    if (!AC || AC.state !== 'running') T('按任意鍵開啟音效', W - 5, 27, PAL.stone3, { al: 'r' });
  }
  function countdown() {
    ctx.fillStyle = 'rgba(11,16,42,.45)'; ctx.fillRect(0, 25, W, H - 25);
    var n = G.cd, pulse = 1 + Math.floor((1 - G.cdT) * 3);
    T(String(n), 160, 70, PAL.gold, { al: 'c', sc: 5 + (G.cdT < .2 ? 1 : 0), sh: PAL.dred });
    T('準備撈魚!', 160, 140, PAL.cream, { al: 'c', sh: PAL.ink });
  }
  function results() {
    ctx.fillStyle = 'rgba(11,16,42,.8)'; ctx.fillRect(0, 25, W, H - 25);
    (G.conf || []).forEach(function (c) { if (G.winner >= 0) R(c.x + Math.sin(G.t * 2 + c.w) * 3, c.y, 2, 2, c.c); });
    T('時間到!', 160, 28, PAL.gold, { al: 'c', sc: 2, sh: PAL.dred });
    var w = G.winner;
    T(w < 0 ? '平手!' : PNAME[w] + ' 獲勝!', 160, 54, w < 0 ? PAL.cream : PCOL[w], { al: 'c', sc: 2, sh: PAL.ink });
    G.players.forEach(function (p, i) {
      var x = 22 + i * 148, win = w === i; panel(x, 82, 128, 62, win ? PCOL[i] : PAL.stone);
      T(PNAME[i] + (win ? ' ★' : ''), x + 8, 86, PCOL[i], {});
      T(String(p.score), x + 120, 88, PAL.white, { al: 'r', sc: 2, sh: PAL.dred });
      T('小魚 ×' + p.caught.s + '  大魚 ×' + p.caught.b, x + 8, 112, PAL.cream, {});
      T('稀有 ×' + p.caught.r, x + 8, 126, PAL.gold, {});
    });
    T('雙方手機按 READY 或 Enter 再玩一次', 160, 152, PAL.cream, { al: 'c' });
    T('房間碼 ' + room, 160, 166, PAL.stone3, { al: 'c' });
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(BG, 0, 0);
    // sparkles
    SPARK.forEach(function (s) { if (Math.sin(G.t * 2 + s[2]) > .6) R(s[0], s[1], 2, 1, PAL.hi); });
    // ripples
    G.fx.forEach(function (e) { var r = 3 + Math.floor(e.t * (e.big ? 30 : 22)); if (e.t < .7) circleOutline(e.x, e.y, r, e.t < .35 ? PAL.white : PAL.hi); });
    G.fish.forEach(drawFish);
    G.players.forEach(function (p, i) { if (G.phase !== 'lobby' || p.cid) drawNet(p); });
    G.pops.forEach(function (e) { T(e.txt, e.x, e.y - e.t * 18, e.col, { al: 'c', sh: PAL.ink, sc: 1 }); });
    hud();
    if (G.phase === 'lobby') lobby(); else if (G.phase === 'countdown') countdown(); else if (G.phase === 'end') results();
    requestAnimationFrame(render);
  }
  var fontsReady = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('12px Fusion', '撈金魚abc123')]).catch(function () {}) : Promise.resolve();
  fontsReady.then(function () { tcache = {}; requestAnimationFrame(render); });
  window.__gf = { G: G, hub: hub, room: room, joinURL: joinURL, TYPES: TYPES, NET_R: NET_R, GAIN: GAIN, startCountdown: startCountdown };
})();
