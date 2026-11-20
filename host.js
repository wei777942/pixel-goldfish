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
  var TYPES = {
    s: { pts: 1, len: 10, hh: 3, body: PAL.orange, belly: PAL.cream, fin: PAL.gold2, speed: [14, 24], cost: 6, n: 14 },
    b: { pts: 3, len: 19, hh: 6, body: PAL.red, belly: PAL.orange, fin: PAL.dred, speed: [9, 15], cost: 20, n: 4 },
    g: { pts: 5, len: 13, hh: 4, body: PAL.gold, belly: PAL.cream, fin: PAL.gold2, speed: [30, 42], cost: 12, n: 1, rare: 1 },
    k: { pts: 5, len: 13, hh: 4, body: PAL.blk, belly: PAL.blk2, fin: PAL.blk2, speed: [30, 42], cost: 12, n: 1, rare: 1 }
  };

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

  /* ---------- sound (WebAudio 8-bit: sfx + looping chiptune music) ---------- */
  var AC = null, MASTER = null, SFXB = null, MUSB = null, NOISEBUF = null;
  var muted = false; try { muted = localStorage.getItem('gf-muted') === '1'; } catch (e) {}
  var AUD = { catchCalls: 0, lastCatch: -1, lastCount: 0, track: 'none', steps: 0, bar: 0, bpm: 0, unlockedAt: 0 };
  function audioInit() {
    if (!AC) {
      try {
        AC = new (window.AudioContext || window.webkitAudioContext)();
        MASTER = AC.createGain(); MASTER.gain.value = muted ? 0 : 1; MASTER.connect(AC.destination);
        SFXB = AC.createGain(); SFXB.gain.value = 1; SFXB.connect(MASTER);
        MUSB = AC.createGain(); MUSB.gain.value = 0; MUSB.connect(MASTER);
        var n = AC.sampleRate | 0; NOISEBUF = AC.createBuffer(1, n, AC.sampleRate); var a = NOISEBUF.getChannelData(0); for (var i = 0; i < n; i++) a[i] = Math.random() * 2 - 1;
      } catch (e) { AC = null; }
    }
    if (AC && AC.state !== 'running') { var pr = AC.resume(); if (pr && pr.then) pr.then(function () { if (!AUD.unlockedAt) AUD.unlockedAt = Date.now(); }); }
    else if (AC && !AUD.unlockedAt) AUD.unlockedAt = Date.now();
  }
  function setMuted(m) {
    muted = m; try { localStorage.setItem('gf-muted', m ? '1' : '0'); } catch (e) {}
    if (MASTER) MASTER.gain.setTargetAtTime(m ? 0 : 1, AC.currentTime, 0.02);
    drawMuteIcon();
  }
  function tone(f, d, type, vol, slideTo, delay) {
    if (!AC || muted || AC.state !== 'running') return;
    var t = AC.currentTime + (delay || 0), o = AC.createOscillator(), g = AC.createGain();
    o.type = type || 'square'; o.frequency.setValueAtTime(f, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + d);
    g.gain.setValueAtTime(vol || 0.08, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d); o.connect(g); g.connect(SFXB); o.start(t); o.stop(t + d + 0.02);
  }
  function noise(d, vol, delay) {
    if (!AC || muted || AC.state !== 'running') return;
    var n = Math.floor(AC.sampleRate * d), b = AC.createBuffer(1, n, AC.sampleRate), a = b.getChannelData(0);
    for (var i = 0; i < n; i++) a[i] = (Math.random() * 2 - 1) * (1 - i / n);
    var s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1800;
    s.buffer = b; g.gain.value = vol || 0.12; s.connect(f); f.connect(g); g.connect(SFXB); s.start(AC.currentTime + (delay || 0));
  }
  var SFX = {
    join: function () { tone(660, .08, 'square', .07); tone(880, .12, 'square', .07, 0, .08); },
    ready: function () { tone(784, .08, 'triangle', .1); tone(1175, .12, 'triangle', .1, 0, .07); },
    dip: function () { noise(.18, .1); tone(300, .12, 'sine', .06, 120); },
    lift: function () { noise(.14, .07); tone(200, .1, 'sine', .05, 500); },
    s: function () { tone(988, .07, 'square', .07); tone(1319, .1, 'square', .07, 0, .07); },
    b: function () { [523, 659, 784].forEach(function (f, i) { tone(f, .1, 'square', .08, 0, i * .07); }); },
    r: function () { [659, 784, 988, 1319, 1568].forEach(function (f, i) { tone(f, .12, 'square', .08, 0, i * .07); }); },
    /* caught a fish: k = 0 small, 1 big, 2 rare (golden/black); n = fish in this scoop */
    catch: function (k, n) {
      AUD.catchCalls++; AUD.lastCatch = k; AUD.lastCount = n; try { console.info('[sfx] catch', k, n); } catch (e) {}
      tone(420, .12, 'sine', .08, 1100); // splashy rising "plip"
      if (k === 0) { tone(988, .06, 'square', .09, 0, .05); tone(1319, .2, 'square', .09, 0, .11); tone(2637, .14, 'triangle', .04, 0, .11); }
      else if (k === 1) {
        [523, 659, 784, 1047].forEach(function (f, i) { tone(f, .1, 'square', .09, 0, .04 + i * .065); tone(f * 2, .08, 'triangle', .035, 0, .04 + i * .065); });
        [1047, 1319, 1568].forEach(function (f) { tone(f, .34, 'square', .06, 0, .34); }); tone(131, .3, 'triangle', .12, 0, .34);
      } else {
        [784, 784, 1047, 1319].forEach(function (f, i) { tone(f, i < 3 ? .08 : .14, 'square', .09, 0, .04 + i * .085); });
        [1047, 1319, 1568, 2093].forEach(function (f) { tone(f, .55, 'square', .055, 0, .4); }); tone(131, .5, 'triangle', .14, 0, .4); noise(.25, .05, .4);
        [2093, 2637, 3136, 4186, 3136, 2637, 3136, 4186].forEach(function (f, i) { tone(f, .09, 'triangle', .05, 0, .5 + i * .05); });
      }
      if (n > 1) { tone(1760, .07, 'square', .07, 0, .55); tone(2349, .16, 'square', .07, 0, .62); }
    },
    miss: function () { tone(180, .12, 'square', .05, 110); },
    brk: function () { noise(.3, .14); tone(400, .35, 'sawtooth', .08, 60); },
    beep: function () { tone(660, .12, 'square', .09); },
    go: function () { tone(1320, .35, 'square', .1); },
    tick: function () { tone(1000, .05, 'square', .05); },
    end: function () { [784, 659, 523, 392].forEach(function (f, i) { tone(f, .16, 'square', .09, 0, i * .13); }); },
    win: function () { [523, 659, 784, 1047, 784, 1047, 1319].forEach(function (f, i) { tone(f, .13, 'square', .09, 0, i * .1); }); }
  };
  /* --- music: 8-bar loop in C (C Am F G x2), scheduled ahead of time with a 30 ms timer --- */
  function mtof(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  var MEL = [[76, 79, 76, 72, 76, 79, 84, 79], [69, 72, 76, 72, 69, 72, 76, 0], [77, 81, 77, 72, 77, 81, 84, 81], [79, 83, 86, 83, 79, 0, 74, 0],
             [84, 0, 79, 76, 79, 0, 76, 72], [81, 0, 76, 72, 76, 0, 72, 69], [77, 79, 81, 79, 77, 76, 74, 72], [74, 76, 79, 83, 86, 0, 83, 79]];
  var ROOT = [48, 45, 41, 43], CHORD = [[60, 64, 67], [57, 60, 64], [60, 65, 69], [59, 62, 67]];
  var mTrack = 'none', mStep = 0, mNext = 0, MVOL = { none: 0, soft: 0.5, game: 0.85 };
  function mnote(m, t, d, type, vol) {
    var o = AC.createOscillator(), g = AC.createGain(); o.type = type; o.frequency.value = mtof(m);
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(vol, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(MUSB); o.start(t); o.stop(t + d + 0.02);
  }
  function mhit(t, d, vol, hp) {
    var s = AC.createBufferSource(), g = AC.createGain(), f = AC.createBiquadFilter(); f.type = hp ? 'highpass' : 'bandpass'; f.frequency.value = hp ? 6000 : 1800;
    s.buffer = NOISEBUF; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + d); s.connect(f); f.connect(g); g.connect(MUSB); s.start(t, Math.random() * .5); s.stop(t + d + .02);
  }
  function mkick(t) { var o = AC.createOscillator(), g = AC.createGain(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(45, t + .1); g.gain.setValueAtTime(.22, t); g.gain.exponentialRampToValueAtTime(0.0001, t + .13); o.connect(g); g.connect(MUSB); o.start(t); o.stop(t + .15); }
  function mstep(s, t, e, game) {
    var bar = (s >> 3) & 7, i = s & 7, ch = bar & 3;
    AUD.steps++; AUD.bar = bar;
    if (game) {
      var mel = MEL[bar][i]; if (mel) mnote(mel, t, e * 1.8, 'square', .05);
      if (i === 0 || i === 4) mnote(ROOT[ch], t, e * 1.9, 'triangle', .16); else if (i === 2) mnote(ROOT[ch] + 12, t, e * 1.4, 'triangle', .12); else if (i === 6) mnote(ROOT[ch] + 7, t, e * 1.4, 'triangle', .12);
      if (i & 1) mnote(CHORD[ch][(i >> 1) % 3], t, e * .7, 'square', .02);
      if (i === 0 || i === 4) mkick(t); if (i === 2 || i === 6) mhit(t, .09, .07, false); if (i & 1) mhit(t, .03, .03, true);
    } else {
      if (i === 0) mnote(ROOT[ch], t, e * 7, 'sine', .16);
      mnote(CHORD[ch][[0, 1, 2, 1, 0, 1, 2, 1][i]], t, e * 1.6, 'triangle', .07);
      if (i === 0 || i === 4) { var mm = MEL[bar][i]; if (mm) mnote(mm, t, e * 3, 'sine', .05); }
    }
  }
  function wantTrack() { return G.phase === 'play' ? 'game' : G.phase === 'countdown' ? 'none' : 'soft'; }
  function musicTick() {
    if (!AC || AC.state !== 'running' || !MUSB) return;
    var want = wantTrack();
    if (want !== mTrack) {
      mTrack = want; AUD.track = want; mStep = 0; mNext = AC.currentTime + 0.06;
      MUSB.gain.cancelScheduledValues(AC.currentTime); MUSB.gain.setTargetAtTime(MVOL[want], AC.currentTime, want === 'none' ? 0.08 : 0.03);
    }
    if (mTrack === 'none' || muted) { mNext = Math.max(mNext, AC.currentTime + 0.05); return; }
    var game = mTrack === 'game', bpm = game ? (G.phase === 'play' && G.tLeft <= 10 ? 158 : 140) : 88, e = 60 / bpm / 2; AUD.bpm = bpm;
    if (mNext < AC.currentTime - 0.3) mNext = AC.currentTime + 0.05;
    while (mNext < AC.currentTime + 0.16) { mstep(mStep, mNext, e, game); mNext += e; mStep = (mStep + 1) & 63; }
  }
  setInterval(musicTick, 30);
  function unlock() { audioInit(); }
  ['pointerdown', 'keydown', 'touchstart', 'touchend', 'click'].forEach(function (e) { addEventListener(e, unlock, { passive: true }); });
  /* small pixel speaker icon (no text) bottom-right: tap to mute / unmute (M key too) */
  var muteBtn = document.createElement('button'), muteCv = document.createElement('canvas'); muteCv.width = 12; muteCv.height = 10;
  muteBtn.setAttribute('aria-label', 'sound'); muteBtn.appendChild(muteCv);
  muteBtn.style.cssText = 'position:fixed;right:10px;bottom:10px;width:40px;height:34px;padding:0;border:2px solid #6a5acd;background:rgba(20,16,42,.7);border-radius:3px;cursor:pointer;z-index:9;opacity:.75';
  muteCv.style.cssText = 'width:100%;height:100%;image-rendering:pixelated;display:block';
  muteBtn.addEventListener('pointerdown', function (e) { e.stopPropagation(); }); muteBtn.addEventListener('click', function (e) { e.stopPropagation(); audioInit(); setMuted(!muted); });
  function drawMuteIcon() {
    var c = muteCv.getContext('2d'); c.clearRect(0, 0, 12, 10); c.fillStyle = muted ? '#8a84b0' : '#fff4d6';
    c.fillRect(1, 3, 2, 4); c.fillRect(3, 2, 1, 6); c.fillRect(4, 1, 1, 8); c.fillRect(5, 0, 1, 10);
    if (muted) { c.fillStyle = '#ff5a6e'; for (var i = 0; i < 5; i++) { c.fillRect(7 + i, 2 + i, 1, 1); c.fillRect(7 + i, 6 - i, 1, 1); } }
    else { c.fillRect(7, 3, 1, 4); c.fillRect(9, 1, 1, 8); }
    muteBtn.style.borderColor = muted ? '#5a5478' : '#6a5acd';
  }
  drawMuteIcon(); document.body.appendChild(muteBtn);

  /* ---------- game state ---------- */
  var room = (Q.get('room') || sessionStorage.getItem('gf-room') || '').toUpperCase();
  if (!/^[A-Z0-9]{4,10}$/.test(room)) { var al = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; room = ''; for (var qi = 0; qi < 6; qi++) room += al[Math.floor(Math.random() * al.length)]; }
  try { sessionStorage.setItem('gf-room', room); } catch (e) {}
  var base = Q.get('base') || (location.origin + location.pathname.replace(/[^/]*$/, ''));
  var joinURL = base + 'play.html?r=' + room;

  function newPlayer(i) {
    return { i: i, cid: null, lastSeen: 0, lastSeq: -1, cx: null, cy: null, lastRc: 0, ready: false, motion: false, lastSn: 0, lastStr: 0, dn: false, downT: 0, ign: -1,
      x: i ? 240 : 80, y: 110, tx: i ? 240 : 80, ty: 110, lift: 0, cool: 0, dur: 100, broken: 0, score: 0, caught: { s: 0, b: 0, r: 0 }, speed: 0 };
  }
  var BEST_KEY = 'gf-best-1p', bestInit = 0; try { bestInit = +localStorage.getItem(BEST_KEY) || 0; } catch (e) {}
  var G = { phase: 'title', mode: 0, sel: 0, btns: [], best: bestInit, newBest: false, players: [newPlayer(0), newPlayer(1)], fish: [], fx: [], pops: [], ev: [], evId: 1, tLeft: DURATION, cd: 0, cdT: 0, winner: null, t: 0, relay: { open: 0, total: 4 }, hostRx: 0, round: 0 };
  function cap() { return G.mode === 1 ? 1 : 2; }
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
  function chooseMode(m) {
    audioInit();
    unlock(); G.mode = m;
    if (m === 1) {
      var a = G.players[0], b = G.players[1];
      if (!a.cid && b.cid) { var n0 = newPlayer(0); ['cid', 'lastSeen', 'lastSeq', 'cx', 'cy', 'lastRc', 'motion', 'lastSn'].forEach(function (k) { n0[k] = b[k]; }); G.players[0] = n0; G.players[1] = newPlayer(1); }
      else if (b.cid) { var old = b.cid; G.players[1] = newPlayer(1); hub.send({ k: 'full', c: old, md: 1 }); }
    }
    G.players.forEach(function (p) { p.ready = false; p.score = 0; p.caught = { s: 0, b: 0, r: 0 }; p.dur = 100; p.broken = 0; p.dn = false; });
    G.winner = null; G.phase = 'lobby'; SFX.ready(); broadcast();
  }
  function toTitle() {
    G.phase = 'title'; G.mode = 0; G.winner = null; G.players.forEach(function (p) { p.ready = false; p.dn = false; p.lift = 0; p.score = 0; p.caught = { s: 0, b: 0, r: 0 }; p.dur = 100; p.broken = 0; }); SFX.join(); broadcast();
  }
  function finish() {
    G.phase = 'end'; G.players.forEach(function (p) { p.ready = false; p.lift = 0; });
    var a = G.players[0].score, b = G.players[1].score; G.winner = a === b ? -1 : (a > b ? 0 : 1);
    G.newBest = false;
    if (G.mode === 1) { G.winner = null; if (a > G.best) { G.best = a; G.newBest = a > 0; try { localStorage.setItem(BEST_KEY, String(a)); } catch (e) {} } }
    G.endT = 0; G.conf = []; for (var i = 0; i < 70; i++) G.conf.push({ x: rnd(0, W), y: rnd(-120, 0), v: rnd(30, 70), c: [PAL.gold, PAL.pink, PAL.lime, PAL.hi, PAL.white][i % 5], w: Math.random() * 6 });
    SFX.end(); setTimeout(function () { if (G.mode === 1 ? G.newBest : G.winner >= 0) SFX.win(); }, 650);
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
      if (i < 0) { for (var j = 0; j < cap(); j++) if (!G.players[j].cid) { i = j; break; } }
      if (i < 0) { // stale slot reuse: take over a slot whose phone vanished for >20s outside play
        for (j = 0; j < cap(); j++) if (now - G.players[j].lastSeen > 20000 && G.phase !== 'play') { i = j; break; }
      }
      if (i < 0) { hub.send({ k: 'full', c: m.c, md: G.mode }); return; }
      p = G.players[i];
      var wasConn = connected(p) && p.cid === m.c;
      p.cid = m.c; p.lastSeen = now; p.lastSeq = -1; p.cx = null; p.cy = null; p.lastRc = m.rc | 0; p.lastSn = m.sn | 0; p.motion = !!m.mo; p.ign = -1; p.dn = false; p.downT = 0;
      if (!wasConn) SFX.join();
      broadcast(); return;
    }
    if (i < 0) { hub.send({ k: 'full', c: m.c, md: G.mode }); return; }
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
    if (m.s > p.ign) { var nd = !!m.d && G.phase === 'play' && p.broken <= 0; if (nd && !p.dn) { p.downT = 0; splash(p.x, p.y); SFX.dip(); } p.dn = nd; }
    if (typeof m.sn === 'number' && m.sn > p.lastSn) { p.lastSn = m.sn; doScoop(p, +m.ss || 0, m.s); }
    var rc = m.rc | 0;
    if (rc > p.lastRc) { if ((G.phase === 'lobby' || G.phase === 'end') && p.motion) { if (!p.ready) SFX.ready(); p.ready = true; } p.lastRc = rc; }
  }
  function onScoopMsg(m) {
    var i = slotOf(m.c); if (i < 0) return; var p = G.players[i];
    p.lastSeen = Date.now();
    if (typeof m.n === 'number' && m.n > p.lastSn) { p.lastSn = m.n; doScoop(p, +m.str || 0, m.q); }
  }

  function snapshot() {
    return {
      k: 'st', rm: room, ph: G.phase, md: G.mode, bs: G.best, nw: G.newBest ? 1 : 0, t: Math.ceil(G.tLeft * 10) / 10, cd: G.cd, w: G.winner, rd: G.round,
      pl: G.players.map(function (p) { return { c: p.cid, on: connected(p) ? 1 : 0, rd: p.ready ? 1 : 0, du: Math.max(0, Math.round(p.dur)), br: Math.ceil(p.broken * 10) / 10, lf: p.lift > 0 ? 1 : 0, dn: p.dn ? 1 : 0, mo: p.motion ? 1 : 0, sc: p.score, cs: p.caught.s, cb: p.caught.b, cr: p.caught.r }; }),
      ev: G.ev.map(function (e) { return { id: e.id, s: e.s, p: e.p, y: e.y }; })
    };
  }
  function broadcast() { hub.send(snapshot(), true); }  // droppable: relays that rate-limit us get skipped, others carry it
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
        if (p.dn && p.broken <= 0 && G.phase === 'play') { var dx = f.x - p.x, dy = f.y - p.y, d = Math.hypot(dx, dy); if (d < NET_R + 10 && d > .1) { var k = TYPES[f.type].rare ? 1.4 : .3; f.a += Math.atan2(Math.sin(Math.atan2(dy, dx) - f.a), Math.cos(Math.atan2(dy, dx) - f.a)) * Math.min(1, dt * k); if (TYPES[f.type].rare) f.bump = Math.max(f.bump, .2); } }
      });
      f.x += Math.cos(f.a) * sp * dt; f.y += Math.sin(f.a) * sp * dt * .8;
      var mx = PX0 + t.len * .6 + 2, Mx = PX1 - t.len * .6 - 2, my = PY0 + t.hh + 3, My = PY1 - t.hh - 3;
      if (f.x < mx) { f.x = mx; f.a = Math.PI - f.a; } if (f.x > Mx) { f.x = Mx; f.a = Math.PI - f.a; }
      if (f.y < my) { f.y = my; f.a = -f.a; } if (f.y > My) { f.y = My; f.a = -f.a; }
      // visual only: heading eases toward the swim direction; turn rate bends the body, sharp turns / darts show a flank
      var hd = Math.atan2(Math.sin(f.a) * .8, Math.cos(f.a));
      if (f.va === undefined) { f.va = hd; f.tr = 0; f.bd = 0; }
      var da = Math.atan2(Math.sin(hd - f.va), Math.cos(hd - f.va)), step = da * (1 - Math.exp(-dt * 6.5));
      f.va += step; f.tr += ((step / Math.max(dt, .001)) - f.tr) * Math.min(1, dt * 12);
      var at = Math.abs(f.tr), want = at > 2.6 ? 2 : at > .7 ? 1 : 0;
      if (f.bump > 0 && at > 1.2) want = 2;
      f.bd = want * (f.tr < 0 ? -1 : 1);
      f.ft += dt * (4 + sp / 8); f.frame = Math.floor(f.ft) & 1;
    });
  }

  function breakNet(p) {
    p.broken = 3.5; p.lift = 0; p.dur = 0; p.cool = 0; p.dn = false; p.downT = 0; SFX.brk(); splash(p.x, p.y, true);
    pop(p.x, p.y - 20, '破了!', PAL.red); addEvent(p.i, 0, 'x');
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
      if (!connected(p)) { p.dn = false; }
      if (G.phase !== 'play') { p.dn = false; p.downT = 0; return; }
      if (p.dn) { // net is in the water: it wears, faster when moving fast or bumped by big fish
        p.downT += dt;
        var drain = 2.5 + Math.min(p.speed, 120) * 0.04;
        G.fish.forEach(function (f) { if (!f.dead && f.type === 'b' && Math.hypot(f.x - p.x, f.y - p.y) < NET_R + 3) drain += 10; });
        p.dur -= drain * dt;
        if (p.dur <= 0) breakNet(p);
      } else p.downT = 0;
    });
  }
  // phone says: net came back to centre = lifted out of the water (no wear out of water)
  function doScoop(p, str, q) {
    p.lastStr = str; if (typeof q === 'number') p.ign = Math.max(p.ign, q);
    var held = p.downT; p.dn = false; p.downT = 0;
    if (G.phase !== 'play' || p.broken > 0 || p.cool > 0 || held < 0.2) return;
    p.cool = .6; p.lift = .5; splash(p.x, p.y); SFX.lift();
    var rad = NET_R * 1.2, mul = 1;
    var cand = [];
    G.fish.forEach(function (f) { if (!f.dead) { var d = Math.hypot(f.x - p.x, f.y - p.y); if (d <= rad + TYPES[f.type].len * .15) cand.push([d, f]); } });
    if (!cand.length) { SFX.miss(); return; }
    cand.sort(function (a, b) { return a[0] - b[0]; });
    cand = cand.slice(0, 3);
    var best = 0, pts = 0;
    cand.forEach(function (c, i) {
      var f = c[1], t = TYPES[f.type]; pts += t.pts; p.caught[t.rare ? 'r' : f.type]++; if (t.rare) best = 2; else if (f.type === 'b' && best < 1) best = 1;
      f.dead = 1; f.respawn = t.rare ? rnd(5, 8) : f.type === 'b' ? rnd(3, 5) : rnd(1.8, 3.2); pop(f.x + i * 3, f.y - 8 - i * 9, '+' + t.pts, t.rare ? PAL.gold : PCOL[p.i]);
      G.fx.push({ x: f.x, y: f.y, t: 0, big: true });
    });
    p.score += pts; addEvent(p.i, pts, best === 2 ? 'r' : best === 1 ? 'b' : 's');
    SFX.catch(best, cand.length);
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
      var both = G.players.slice(0, cap()).every(function (p) { return connected(p) && p.ready; });
      if (G.phase === 'lobby' && both) startCountdown(); else if (G.phase === 'end' && both) startCountdown();
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
    var k = e.key;
    if (G.phase === 'title') {
      if (k === 'ArrowLeft' || k === 'ArrowUp') { G.sel = 0; SFX.join(); } else if (k === 'ArrowRight' || k === 'ArrowDown') { G.sel = 1; SFX.join(); }
      else if (k === '1') chooseMode(1); else if (k === '2') chooseMode(2);
      else if (k === 'Enter' || k === ' ') chooseMode(G.sel + 1);
    } else if (k === 'Enter' || k === ' ') {
      if (G.phase === 'lobby' && G.players.slice(0, cap()).some(connected)) startCountdown();
      else if (G.phase === 'end') startCountdown();
    } else if ((k === 'Escape' || k === 'Backspace') && (G.phase === 'lobby' || G.phase === 'end')) toTitle();
    if (k === 'm' || k === 'M') { audioInit(); setMuted(!muted); }
    else if (k === 'f' || k === 'F') { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen && document.documentElement.requestFullscreen(); }
  });
  function toCanvas(e) { var r = cv.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width * W, y: (e.clientY - r.top) / r.height * H }; }
  function hitBtn(p) { for (var i = 0; i < G.btns.length; i++) { var b = G.btns[i]; if (p.x >= b.x && p.x < b.x + b.w && p.y >= b.y && p.y < b.y + b.h) return b; } return null; }
  function act(id) {
    audioInit();
    if (id === 'p1') chooseMode(1); else if (id === 'p2') chooseMode(2);
    else if (id === 'back') toTitle();
    else if (id === 'again' && G.phase === 'end') startCountdown();
  }
  cv.addEventListener('pointermove', function (e) { if (G.phase !== 'title') return; var b = hitBtn(toCanvas(e)); if (b && b.id === 'p1' && G.sel !== 0) { G.sel = 0; SFX.join(); } else if (b && b.id === 'p2' && G.sel !== 1) { G.sel = 1; SFX.join(); } });
  cv.addEventListener('pointerdown', function (e) { var b = hitBtn(toCanvas(e)); if (b) { e.preventDefault(); act(b.id); } });

  /* ---------- render ---------- */
  function drawFish(f) {
    var t = TYPES[f.type];
    if (f.dead) return;
    var amp = (f.sp * (f.bump > 0 ? 2.2 : 1)) > 20 ? 1 : 0, wi = Math.floor(f.ft * (amp ? .8 : .5)) & 3;
    var e = FishSprite.get(f.type, f.va === undefined ? 0 : f.va, f.bd || 0, wi, amp);
    var bx = Math.round(f.x) - e.R, by = Math.round(f.y) - e.R, bob = Math.round(Math.sin(G.t * 3 + f.wob) * .6);
    ctx.drawImage(e.sh, bx + 2, by + 3);   // shadow on the pond floor (dithered)
    ctx.drawImage(e.c, bx, by + bob);
    if (t.rare && ((G.t * 6 + f.wob) % 2) < 1) { var sx = Math.round(f.x + Math.sin(G.t * 5 + f.wob) * 8), sy = Math.round(f.y - 6 + Math.cos(G.t * 4) * 3); R(sx, sy - 1, 1, 3, PAL.white); R(sx - 1, sy, 3, 1, PAL.white); }
  }
  /* dipped net = under the fish, tinted a little by the water; cached per wear stage + colour */
  var wetCache = {};
  function wetNet(st, col) {
    var k = st + col; if (wetCache[k]) return wetCache[k];
    var src = NetSprite.get(st, col, true), c = document.createElement('canvas'); c.width = src.width; c.height = src.height;
    var x = c.getContext('2d'); x.drawImage(src, 0, 0); x.globalCompositeOperation = 'source-atop'; x.fillStyle = 'rgba(10,50,120,0.32)'; x.fillRect(0, 0, c.width, c.height);
    return (wetCache[k] = c);
  }
  /* layer 'under': nets in the water, drawn before the fish. layer 'over': everything else (raised nets, broken net, rim + name of dipped nets) */
  function drawNet(p, layer) {
    if (layer === 'under') {
      if (!p.dn || p.broken > 0) return;
      var ux = Math.round(p.x), uy = Math.round(p.y);
      circleDither(ux, uy, NET_R, PAL.hi, 0);
      ctx.drawImage(wetNet(NetSprite.stageOf(p.dur, false), PCOL[p.i]), ux - NetSprite.C, uy - NetSprite.C);
      return;
    }
    var col = PCOL[p.i], x = Math.round(p.x), y = Math.round(p.y), on = connected(p), up = !p.dn, st = NetSprite.stageOf(p.dur, p.broken > 0);
    if (p.broken > 0) {
      if (p.broken < 1 && ((G.t * 8) | 0) & 1) { T(PNAME[p.i], x, y - NET_R - 14, col, { al: 'c', sh: PAL.ink }); return; } // blinks just before the new net arrives
      ctx.drawImage(NetSprite.get(5, col, false), x - NetSprite.C, y - NetSprite.C);
      T(PNAME[p.i], x, y - NET_R - 14, col, { al: 'c', sh: PAL.ink });
      return;
    }
    if (up) { // floating above water: shadow + raised net
      for (var yy = -NET_R; yy <= NET_R; yy += 2) { var w = Math.floor(Math.sqrt(NET_R * NET_R - yy * yy)); R(x - w + 3, y + yy + 5, w * 2, 1, PAL.deep); }
      y -= p.lift > 0 ? 9 : 5;
    } else {
      // dipped: the net body is already drawn under the fish; only the rim (thin ring + pulsing ripple) goes on top
      var rr = Math.floor((G.t * 10) % 3); circleOutline(x, y, NET_R + 2 + rr, PAL.hi); circleOutline(x, y, NET_R, col);
    }
    if (up) ctx.drawImage(NetSprite.get(st, col, false), x - NetSprite.C, y - NetSprite.C);
    T(PNAME[p.i], x, y - NET_R - 14, col, { al: 'c', sh: PAL.ink });
    if (!on) T('離線', x, y + NET_R + 3, PAL.red, { al: 'c', sh: PAL.ink });
  }
  function hud() {
    R(0, 0, W, 24, PAL.ink); R(0, 24, W, 1, PAL.stone);
    G.players.slice(0, cap()).forEach(function (p, i) {
      var left = i === 0, x0 = left ? 5 : W - 5, on = connected(p), al = left ? 'l' : 'r';
      var w = T(PNAME[i], x0, 0, PCOL[i], { al: al });
      var dotx = left ? x0 + w + 3 : x0 - w - 6;
      R(dotx, 5, 4, 4, p.cid ? (on ? PAL.lime : PAL.red) : PAL.stone2);
      T(p.cid ? (on ? '' : '離線') : '', left ? dotx + 7 : dotx - 3, 0, PAL.red, { al: al });
      T(String(p.score), left ? x0 + 46 : x0 - 46, 0, PAL.white, { al: left ? 'l' : 'r', sc: 1, sh: PAL.dred });
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
    if (!qrCache) { qrCache = document.createElement('canvas'); qrCache.width = qrCache.height = 140; var save = ctx; ctx = qrCache.getContext('2d'); var s = drawQR(0, 0, 2); ctx = save; qrCache.w = s; }
    return qrCache;
  }

  function outlineT(s, x, y, col, o) { // chunky pixel title text: ink outline + shadow + fill
    o = o || {}; var sc = o.sc || 1;
    [[-sc, 0], [sc, 0], [0, -sc], [0, sc], [-sc, -sc], [sc, sc], [-sc, sc], [sc, -sc]].forEach(function (d) { T(s, x + d[0], y + d[1], PAL.ink, { al: o.al, sc: sc }); });
    T(s, x, y, col, { al: o.al, sc: sc, sh: o.sh });
  }
  function miniNet(x, y, col, r, wob) { // tiny paper net icon
    x = Math.round(x); y = Math.round(y + (wob || 0));
    circleDither(x, y, r - 1, PAL.white, 1); circleDither(x, y, r - 1, PAL.cream, 0); circleOutline(x, y, r, col); circleOutline(x, y, r - 1, col);
    for (var k = 0; k < r - 1; k++) R(x + r - 2 + k, y + r - 2 + k, 2, 2, k < 2 ? col : PAL.wood);
  }
  function button(id, x, y, w, h, selected, blink) {
    G.btns.push({ id: id, x: x, y: y, w: w, h: h });
    var on = selected && (!blink || ((G.t * 5) | 0) % 2 === 0);
    R(x - 2, y - 2, w + 4, h + 4, PAL.ink); R(x - 1, y - 1, w + 2, h + 2, selected ? (on ? PAL.gold : PAL.gold2) : PAL.stone2);
    R(x, y, w, h, selected ? PAL.deep : PAL.ink); R(x + 1, y + 1, w - 2, 1, selected ? PAL.light : PAL.stone);
  }
  function title() {
    ctx.fillStyle = 'rgba(11,16,42,.28)'; ctx.fillRect(0, 0, W, H);
    // waving banner of ripples around the logo
    var bob = Math.round(Math.sin(G.t * 2) * 2);
    for (var i = 0; i < 3; i++) { var rr = 36 + ((G.t * 14 + i * 22) % 66); if (rr < 100) circleOutline(160, 44, rr, i % 2 ? PAL.hi : PAL.light); }
    // a goldfish circling the logo
    var ang = G.t * 0.7, fx = 160 + Math.cos(ang) * 118, fy = 44 + Math.sin(ang) * 30, hd = Math.atan2(Math.cos(ang) * 30, -Math.sin(ang) * 118);
    var e = FishSprite.get('g', hd, 0, ((G.t * 6) | 0) & 3, 1); ctx.drawImage(e.sh, Math.round(fx) - e.R + 2, Math.round(fy) - e.R + 3); ctx.drawImage(e.c, Math.round(fx) - e.R, Math.round(fy) - e.R);
    var ang2 = ang + 3.1, fx2 = 160 + Math.cos(ang2) * 118, fy2 = 44 + Math.sin(ang2) * 30, hd2 = Math.atan2(Math.cos(ang2) * 30, -Math.sin(ang2) * 118);
    var e2 = FishSprite.get('b', hd2, 0, ((G.t * 5) | 0) & 3, 0); ctx.drawImage(e2.sh, Math.round(fx2) - e2.R + 2, Math.round(fy2) - e2.R + 3); ctx.drawImage(e2.c, Math.round(fx2) - e2.R, Math.round(fy2) - e2.R);
    // logo
    outlineT('撈金魚', 160, 14 + bob, PAL.gold, { al: 'c', sc: 4, sh: PAL.dred });
    T('GOLDFISH SCOOP', 160, 74, PAL.hi, { al: 'c', sh: PAL.ink });
    ctx.drawImage(NetSprite.get(0, PAL.pink, false), 28 - NetSprite.C, 36 + bob - NetSprite.C);
    ctx.drawImage(NetSprite.get(0, PAL.lime, false), 292 - NetSprite.C, 36 - bob - NetSprite.C);
    // two choices
    var bw = 116, bh = 50, by = 100, xs = [34, 170];
    [['p1', '1P', '練習'], ['p2', '2P', '對戰']].forEach(function (c, i) {
      var sel = G.sel === i, x = xs[i], dy = sel ? Math.round(Math.sin(G.t * 6) * 1) : 0;
      button(c[0], x, by + dy, bw, bh, sel, true);
      if (i === 0) miniNet(x + 24, by + dy + 25, PAL.pink, 11, 0); else { miniNet(x + 17, by + dy + 25, PAL.pink, 9, 0); miniNet(x + 33, by + dy + 25, PAL.lime, 9, 0); }
      T(c[1], x + 56, by + dy + 6, sel ? PAL.gold : PAL.white, { sc: 2, sh: PAL.dred });
      T(c[2], x + 58, by + dy + 30, sel ? PAL.cream : PAL.stone3, {});
      if (sel && ((G.t * 3) | 0) % 2 === 0) { R(x - 8, by + dy + 24, 4, 7, PAL.gold); R(x - 4, by + dy + 26, 2, 3, PAL.gold); }
    });
    if (G.best > 0) { T('★ ' + G.best, 92, 154, PAL.gold, { al: 'c' }); }
    T('點選 · ← → · Enter', 160, 166, PAL.stone3, { al: 'c' });
    if (!AC || AC.state !== 'running') T('♪', W - 6, 168, PAL.stone3, { al: 'r' });
  }
  function slotCard(i, x, y, w, h) {
    var p = G.players[i], on = connected(p);
    panel(x, y, w, h, PCOL[i]);
    miniNet(x + 15, y + h / 2, PCOL[i], 9, 0);
    R(x + 30, y + h / 2 - 2, 4, 4, p.cid ? (on ? PAL.lime : PAL.red) : PAL.stone2);
    var st = !p.cid ? (((G.t * 2) | 0) % 2 ? '…' : '  …') : (!on ? '離線' : (p.ready ? 'READY!' : (p.motion ? '感應就緒' : '已連線')));
    T(st, x + 40, y + h / 2 - 6, p.ready && on ? PAL.lime : (on ? PAL.cream : PAL.stone3), {});
    if (p.cid && on && !p.ready) T(p.motion ? '按 READY' : '按「開始」', x + w - 4, y + h / 2 - 6, PAL.gold, { al: 'r' });
  }
  function lobby() {
    ctx.fillStyle = 'rgba(11,16,42,.72)'; ctx.fillRect(0, 25, W, H - 25);
    button('back', 6, 30, 46, 14, false, false); T('< 返回', 29, 31, PAL.cream, { al: 'c' });
    var one = G.mode === 1;
    outlineT(one ? '1P 練習' : '2P 對戰', 160, 30, PAL.gold, { al: 'c', sc: 2, sh: PAL.dred });
    var q = qrImage(), qw = q.w, qx = 44, qy = 62;
    panel(qx - 4, qy - 4, qw + 8, qw + 8, PAL.stone2); ctx.drawImage(q, 0, 0, qw, qw, qx, qy, qw, qw);
    // little phone icon + room code under the QR
    var cy = qy + qw + 10; R(qx + 2, cy, 6, 10, PAL.stone3); R(qx + 3, cy + 1, 4, 7, PAL.ink); R(qx + 4, cy + 9, 2, 1, PAL.stone2);
    T(room, qx + 12, cy - 1, PAL.gold, {});
    var sx = 140, sw = 168;
    if (one) slotCard(0, sx, 74, sw, 32); else { slotCard(0, sx, 62, sw, 32); slotCard(1, sx, 100, sw, 32); }
    T(one ? 'READY 開始' : '雙方 READY 開始', sx + sw / 2, 148, PAL.cream, { al: 'c' });
    if (!AC || AC.state !== 'running') T('♪', W - 6, 168, PAL.stone3, { al: 'r' });
  }
  function countdown() {
    ctx.fillStyle = 'rgba(11,16,42,.45)'; ctx.fillRect(0, 25, W, H - 25);
    var n = G.cd, pulse = 1 + Math.floor((1 - G.cdT) * 3);
    T(String(n), 160, 70, PAL.gold, { al: 'c', sc: 5 + (G.cdT < .2 ? 1 : 0), sh: PAL.dred });
    T('準備撈魚!', 160, 140, PAL.cream, { al: 'c', sh: PAL.ink });
  }
  function results() {
    ctx.fillStyle = 'rgba(11,16,42,.8)'; ctx.fillRect(0, 25, W, H - 25);
    (G.conf || []).forEach(function (c) { if (G.mode === 1 ? G.newBest : G.winner >= 0) R(c.x + Math.sin(G.t * 2 + c.w) * 3, c.y, 2, 2, c.c); });
    outlineT('時間到!', 160, 28, PAL.gold, { al: 'c', sc: 2, sh: PAL.dred });
    if (G.mode === 1) {
      var p0 = G.players[0];
      panel(80, 52, 160, 78, PAL.pink);
      miniNet(102, 76, PAL.pink, 9, 0);
      T(String(p0.score), 178, 56, PAL.white, { al: 'c', sc: 3, sh: PAL.dred });
      T('小魚 ×' + p0.caught.s + '  大魚 ×' + p0.caught.b + '  稀有 ×' + p0.caught.r, 160, 102, PAL.cream, { al: 'c' });
      T('★ ' + G.best + (G.newBest ? '  新紀錄!' : ''), 160, 115, G.newBest ? PAL.gold : PAL.stone3, { al: 'c' });
    } else {
      var w = G.winner;
      T(w < 0 ? '平手!' : PNAME[w] + ' 獲勝!', 160, 54, w < 0 ? PAL.cream : PCOL[w], { al: 'c', sc: 2, sh: PAL.ink });
      G.players.forEach(function (p, i) {
        var x = 22 + i * 148, win = w === i; panel(x, 82, 128, 56, win ? PCOL[i] : PAL.stone);
        T(PNAME[i] + (win ? ' ★' : ''), x + 8, 86, PCOL[i], {});
        T(String(p.score), x + 120, 88, PAL.white, { al: 'r', sc: 2, sh: PAL.dred });
        T('小魚 ×' + p.caught.s + '  大魚 ×' + p.caught.b, x + 8, 112, PAL.cream, {});
        T('稀有 ×' + p.caught.r, x + 8, 124, PAL.gold, {});
      });
    }
    T(G.mode === 1 ? '手機 READY 再玩' : '雙方 READY 再玩', 160, 138, PAL.stone3, { al: 'c' });
    button('again', 50, 152, 100, 18, false, false); T('再玩一次', 100, 155, PAL.lime, { al: 'c' });
    button('back', 170, 152, 100, 18, false, false); T('回標題', 220, 155, PAL.cream, { al: 'c' });
  }

  function render() {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(BG, 0, 0);
    // sparkles
    SPARK.forEach(function (s) { if (Math.sin(G.t * 2 + s[2]) > .6) R(s[0], s[1], 2, 1, PAL.hi); });
    // ripples
    G.fx.forEach(function (e) { var r = 3 + Math.floor(e.t * (e.big ? 30 : 22)); if (e.t < .7) circleOutline(e.x, e.y, r, e.t < .35 ? PAL.white : PAL.hi); });
    var nets = G.phase !== 'title' ? G.players.slice(0, cap()).filter(function (p) { return G.phase !== 'lobby' || p.cid; }) : [];
    nets.forEach(function (p) { drawNet(p, 'under'); });
    G.fish.forEach(drawFish);
    nets.forEach(function (p) { drawNet(p, 'over'); });
    G.pops.forEach(function (e) { T(e.txt, e.x, e.y - e.t * 18, e.col, { al: 'c', sh: PAL.ink, sc: 1 }); });
    G.btns = [];
    if (G.phase !== 'title') hud();
    if (G.phase === 'title') title(); else if (G.phase === 'lobby') lobby(); else if (G.phase === 'countdown') countdown(); else if (G.phase === 'end') results();
    requestAnimationFrame(render);
  }
  var fontsReady = (document.fonts && document.fonts.load) ? Promise.all([document.fonts.load('12px Fusion', '撈金魚abc123')]).catch(function () {}) : Promise.resolve();
  fontsReady.then(function () { tcache = {}; requestAnimationFrame(render); });
  window.__gf = {NetSprite: NetSprite, FishSprite: FishSprite,  G: G, hub: hub, room: room, joinURL: joinURL, TYPES: TYPES, NET_R: NET_R, GAIN: GAIN, startCountdown: startCountdown, chooseMode: chooseMode, toTitle: toTitle, audio: function () { return { state: AC ? AC.state : 'none', muted: muted, catchCalls: AUD.catchCalls, lastCatch: AUD.lastCatch, lastCount: AUD.lastCount, track: AUD.track, steps: AUD.steps, bar: AUD.bar, bpm: AUD.bpm, unlockedAt: AUD.unlockedAt }; }, setMuted: setMuted, SFX: SFX };
})();
