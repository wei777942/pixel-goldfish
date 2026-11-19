/* 撈金魚 phone controller: sends input only; renders what the big screen says. */
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

  var S = { slot: -1, st: null, lastSt: 0, joined: false, full: false, relayOn: false, seq: 0, cx: 0, cy: 0, d: 0, rc: 0, seenEv: {}, lastSent: 0, dirty: false, lastPhase: '', lastRound: -1, tries: 0 };
  var hub = new GFRelay.Hub({
    sub: 'gf1-' + room + '-d', pub: 'gf1-' + room + '-u',
    onmsg: function (m) {
      if (m.k === 'full' && m.c === cid) { S.full = true; render(); return; }
      if (m.k !== 'st') return;
      S.st = m; S.lastSt = Date.now();
      var i = -1; for (var j = 0; j < m.pl.length; j++) if (m.pl[j].c === cid) i = j;
      if (i >= 0) { if (!S.joined || S.slot !== i) { S.joined = true; S.slot = i; S.full = false; document.getElementById('app').style.setProperty('--pc', PCOL[i]); } }
      events(m); render();
    },
    onstatus: function (i) { S.relayOn = i.online; if (i.online) { S.sayHi = 0; hi(); } render(); }
  });
  function hi() { hub.send({ k: 'hi', c: cid, rc: S.rc }); }
  setInterval(function () { if (S.relayOn && !S.joined && !S.full) { hi(); } else if (S.relayOn && S.joined && Date.now() - S.lastSt > 3500) { hi(); } }, 1500);

  /* ---- input: cumulative relative movement (loss/dup tolerant) ---- */
  function sendIn(force) {
    var now = Date.now();
    if (!S.relayOn) return;
    if (!force && !S.dirty && now - S.lastSent < 450) return;
    if (!force && now - S.lastSent < 90) return;
    S.lastSent = now; S.dirty = false; S.seq++;
    hub.send({ k: 'in', c: cid, s: S.seq, x: Math.round(S.cx * 10) / 10, y: Math.round(S.cy * 10) / 10, d: S.d, rc: S.rc, ts: now }, !force);
  }
  setInterval(function () { sendIn(false); }, 45);

  var pad = $('pad'), btn = $('btn'), padPtr = null, lx = 0, ly = 0;
  pad.addEventListener('pointerdown', function (e) { if (padPtr !== null) return; padPtr = e.pointerId; lx = e.clientX; ly = e.clientY; pad.setPointerCapture(e.pointerId); pad.classList.add('act'); e.preventDefault(); });
  pad.addEventListener('pointermove', function (e) {
    if (e.pointerId !== padPtr) return;
    var evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e]; if (!evs.length) evs = [e];
    evs.forEach(function (c) { S.cx += c.clientX - lx; S.cy += c.clientY - ly; lx = c.clientX; ly = c.clientY; });
    S.dirty = true; e.preventDefault();
  });
  function padEnd(e) { if (e.pointerId === padPtr) { padPtr = null; pad.classList.remove('act'); } }
  pad.addEventListener('pointerup', padEnd); pad.addEventListener('pointercancel', padEnd); pad.addEventListener('lostpointercapture', padEnd);

  var btnPtr = null;
  function setDown(v) { if (S.d === v) return; S.d = v; btn.classList.toggle('down', !!v); if (v && navigator.vibrate) navigator.vibrate(12); sendIn(true); setTimeout(function () { sendIn(true); }, 70); }
  btn.addEventListener('pointerdown', function (e) { if (btn.disabled) return; btnPtr = e.pointerId; btn.setPointerCapture(e.pointerId); setDown(1); e.preventDefault(); });
  function btnEnd(e) { if (e.pointerId === btnPtr) { btnPtr = null; setDown(0); } }
  btn.addEventListener('pointerup', btnEnd); btn.addEventListener('pointercancel', btnEnd); btn.addEventListener('lostpointercapture', btnEnd);
  ['contextmenu', 'selectstart', 'dragstart'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); }); });
  window.addEventListener('blur', function () { setDown(0); });
  document.addEventListener('visibilitychange', function () { if (document.hidden) setDown(0); });

  $('ready').addEventListener('click', function () { S.rc++; sendIn(true); setTimeout(function () { sendIn(true); }, 120); setTimeout(function () { sendIn(true); }, 400); if (navigator.vibrate) navigator.vibrate(20); });

  /* ---- feedback ---- */
  function events(m) {
    (m.ev || []).forEach(function (e) {
      if (S.seenEv[e.id]) return; S.seenEv[e.id] = 1;
      if (S.slot < 0 || e.s !== S.slot) return;
      var d = document.createElement('div'); d.className = 'pop' + (e.y === 'x' ? ' x' : ''); d.textContent = e.y === 'x' ? '破了!' : '+' + e.p; $('pops').appendChild(d); setTimeout(function () { d.remove(); }, 1200);
      if (navigator.vibrate) navigator.vibrate(e.y === 'x' ? [60, 40, 60] : e.y === 'r' ? [30, 30, 30, 30, 60] : 25);
    });
  }
  function render() {
    var m = S.st, me = m && S.slot >= 0 ? m.pl[S.slot] : null, now = Date.now();
    var hostOn = m && now - S.lastSt < 3500;
    $('pname').textContent = S.full ? '房間已滿' : S.slot >= 0 ? 'P' + (S.slot + 1) + (S.slot ? ' 綠' : ' 粉') : (S.relayOn ? '加入中…' : '連線中…');
    var c;
    if (!S.relayOn) c = ['off', '中繼離線 · 重連中…']; else if (!hostOn) c = ['warn', S.joined ? '大螢幕無回應 · 重連中…' : '尋找大螢幕…']; else c = ['on', '已連線 · 房間 ' + room];
    $('conn').innerHTML = '<span class="dot ' + c[0] + '"></span>' + c[1];
    if (!me || !hostOn) { btn.disabled = true; $('ready').style.display = 'none'; btn.style.display = ''; $('msg').textContent = S.full ? '這個房間已有兩位玩家' : ''; if (!me) return; }
    $('sc').textContent = me.sc;
    var ph = m.ph, tl = Math.ceil(m.t);
    $('tm').textContent = ph === 'play' ? (tl + 's') : ph === 'countdown' ? m.cd : ph === 'end' ? '0s' : '--';
    $('barfill').style.width = me.du + '%'; $('barfill').style.background = me.du > 50 ? '#b6f23a' : me.du > 25 ? '#ffd23f' : '#e8423c';
    $('nstxt').textContent = me.br > 0 ? '破了! ' + Math.ceil(me.br) + ' 秒後換新網' : (me.dn ? '水中…' : me.du + '%');
    var playing = ph === 'play';
    btn.disabled = !(playing && hostOn) || me.br > 0;
    var showReady = (ph === 'lobby' || ph === 'end') && hostOn;
    $('ready').style.display = showReady ? 'block' : 'none'; btn.style.display = showReady ? 'none' : '';
    $('ready').disabled = !!me.rd; $('ready').textContent = me.rd ? 'READY! 等待對手' : 'READY';
    var msg = '';
    if (ph === 'lobby') msg = me.rd ? '等待另一位玩家 READY…' : '準備好就按 READY';
    else if (ph === 'countdown') msg = '準備!';
    else if (playing) msg = me.br > 0 ? '紙網破了…等新網' : '拖曳移動 · 按住下水 · 放開撈起';
    else if (ph === 'end') msg = '';
    $('msg').textContent = hostOn ? msg : '';
    if (!playing && S.d) setDown(0);
    var over = $('over');
    if (ph === 'end') {
      var w = m.w, me2 = m.pl[S.slot], other = m.pl[1 - S.slot];
      $('overh').textContent = w === -1 ? '平手!' : w === S.slot ? '你贏了!' : '你輸了…';
      $('overh').style.color = w === S.slot ? '#ffd23f' : w === -1 ? '#fff4d6' : '#9aa3c7';
      $('overp').innerHTML = '你 <b style="color:' + PCOL[S.slot] + '">' + me2.sc + '</b> 分 vs 對手 ' + other.sc + ' 分<br><small>小×' + me2.cs + ' 大×' + me2.cb + ' 稀有×' + me2.cr + '</small>';
      over.style.display = 'flex'; over.style.pointerEvents = 'none';
      over.style.justifyContent = 'flex-start'; over.style.paddingTop = '18vh'; over.style.background = 'rgba(20,16,42,.9)';
      over.style.height = '62vh'; over.style.bottom = 'auto';
    } else over.style.display = 'none';
  }
  setInterval(render, 500);
  if (navigator.wakeLock) { var wl = function () { navigator.wakeLock.request('screen').catch(function () {}); }; wl(); document.addEventListener('visibilitychange', function () { if (!document.hidden) wl(); }); }
  window.__gfp = { S: S, hub: hub, cid: cid };
  render();
})();
