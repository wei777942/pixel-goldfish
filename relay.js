/* Account-free realtime relay over public Nostr relays (WebSocket, port 443).
 * Messages are ephemeral events (kind 20420, never stored) tagged with a random room topic.
 * We publish to ALL relays at once and de-duplicate on receive, so any single relay may fail.
 * Needs vendor/noble-secp256k1.min.js (global nobleSecp) for BIP340 signatures. */
(function (root) {
  'use strict';
  var RELAYS = ['wss://nos.lol', 'wss://relay.primal.net', 'wss://relay.snort.social', 'wss://nostr.mom'];
  var KIND = 20420;
  var enc = new TextEncoder();
  function hex(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += (u8[i] < 16 ? '0' : '') + u8[i].toString(16); return s; }
  function now() { return Date.now(); }

  function Relay(hub, url) {
    this.hub = hub; this.url = url; this.ws = null; this.state = 'closed'; this.fail = 0;
    this.timer = null; this.pendingSince = 0; this.rejects = 0; this.lastReject = '';
  }
  Relay.prototype.connect = function () {
    var self = this, hub = this.hub;
    if (hub.stopped || this.ws) return;
    this.state = 'connecting'; hub._changed();
    var ws;
    try { ws = new WebSocket(this.url); } catch (e) { this._lost(); return; }
    this.ws = ws;
    ws.onopen = function () {
      if (self.ws !== ws) return;
      self.state = 'open'; self.fail = 0; self.pendingSince = 0;
      ws.send(JSON.stringify(['REQ', 'gf', { kinds: [KIND], '#t': [hub.subTopic], since: Math.floor(now() / 1000) - 4 }]));
      hub._changed();
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m[0] === 'EVENT') hub._onEvent(m[2]);
      else if (m[0] === 'OK') {
        self.pendingSince = 0;
        if (m[2] === false) { self.rejects++; self.lastReject = String(m[3] || ''); }
      }
    };
    ws.onclose = ws.onerror = function () { if (self.ws === ws) { self.ws = null; self._lost(); } };
  };
  Relay.prototype._lost = function () {
    var self = this;
    if (this.ws) { var w = this.ws; this.ws = null; try { w.onclose = w.onerror = w.onmessage = null; w.close(); } catch (e) {} }
    this.state = 'closed'; this.fail++; this.hub._changed();
    clearTimeout(this.timer);
    if (this.hub.stopped) return;
    var delay = Math.min(15000, 800 * Math.pow(1.7, Math.min(this.fail, 8))) * (0.7 + Math.random() * 0.6); // backoff + jitter
    this.timer = setTimeout(function () { self.connect(); }, delay);
  };
  Relay.prototype.send = function (str) {
    if (this.state !== 'open' || !this.ws) return false;
    try { this.ws.send(str); if (!this.pendingSince) this.pendingSince = now(); return true; } catch (e) { return false; }
  };
  Relay.prototype.drop = function () { // force a (test/health) reconnect
    this._lost();
  };

  /* opts: {sub, pub, onmsg(obj), onstatus(info), relays} */
  function Hub(opts) {
    var s = root.nobleSecp;
    this.subTopic = opts.sub; this.pubTopic = opts.pub; this.onmsg = opts.onmsg || function () {}; this.onstatus = opts.onstatus || function () {};
    this.sk = s.utils.randomPrivateKey(); this.pk = hex(s.schnorr.getPublicKey(this.sk));
    this.seen = {}; this.seenN = 0; this.stopped = false; this.signing = 0; this.sent = 0; this.recv = 0; this.counter = 0;
    var self = this, list = opts.relays || RELAYS;
    this.relays = list.map(function (u) { return new Relay(self, u); });
    this.lastInfo = '';
    this.wd = setInterval(function () { // watchdog: relay that never acks our events => dead socket
      var t = now();
      self.relays.forEach(function (r) { if (r.state === 'open' && r.pendingSince && t - r.pendingSince > 8000) r.drop(); });
    }, 2000);
    this.relays.forEach(function (r, i) { setTimeout(function () { r.connect(); }, i * 60); });
  }
  Hub.prototype.info = function () {
    var open = 0, connecting = 0;
    this.relays.forEach(function (r) { if (r.state === 'open') open++; else if (r.state === 'connecting') connecting++; });
    return { open: open, total: this.relays.length, connecting: connecting, online: open > 0 };
  };
  Hub.prototype._changed = function () {
    var i = this.info(), k = i.open + '/' + i.total + '/' + i.connecting;
    if (k !== this.lastInfo) { this.lastInfo = k; try { this.onstatus(i); } catch (e) {} }
  };
  Hub.prototype._onEvent = function (ev) {
    if (!ev || !ev.id || this.seen[ev.id]) return;
    this.seen[ev.id] = 1; if (++this.seenN > 3000) { this.seen = {}; this.seenN = 0; }
    var o; try { o = JSON.parse(ev.content); } catch (e) { return; }
    if (!o || typeof o !== 'object') return;
    this.recv++;
    try { this.onmsg(o); } catch (e) { console.error(e); }
  };
  /* send(obj, droppable): droppable messages are skipped if signing is backed up */
  Hub.prototype.send = function (obj, droppable) {
    var self = this, s = root.nobleSecp;
    if (!this.info().online) return false;
    if (droppable && this.signing > 3) return false;
    this.signing++;
    var ev = { pubkey: this.pk, created_at: Math.floor(now() / 1000), kind: KIND, tags: [['t', this.pubTopic]], content: JSON.stringify(obj) };
    var id = hex(new Uint8Array(0));
    return crypto.subtle.digest('SHA-256', enc.encode(JSON.stringify([0, ev.pubkey, ev.created_at, ev.kind, ev.tags, ev.content]))).then(function (d) {
      ev.id = hex(new Uint8Array(d));
      return s.schnorr.sign(ev.id, self.sk);
    }).then(function (sig) {
      ev.sig = hex(sig);
      var msg = JSON.stringify(['EVENT', ev]);
      self.seen[ev.id] = 1; // never process our own echo
      var n = 0; self.relays.forEach(function (r) { if (r.send(msg)) n++; });
      if (n) self.sent++;
    }).catch(function (e) { console.error('send', e); }).then(function () { self.signing--; });
  };
  Hub.prototype.dropAll = function () { this.relays.forEach(function (r) { r.drop(); }); };
  Hub.prototype.stop = function () { this.stopped = true; clearInterval(this.wd); this.relays.forEach(function (r) { clearTimeout(r.timer); if (r.ws) { try { r.ws.close(); } catch (e) {} } }); };

  root.GFRelay = { Hub: Hub, RELAYS: RELAYS };
})(window);
