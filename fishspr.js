/* Top-down (dorsal view) pixel fish. Each frame is rasterised analytically per destination pixel (nearest sample, no smoothing),
 * so rotation to 16 headings keeps hard pixel edges. Variants: tail wag (4 phases x 2 amplitudes) and body bend
 * (0, +-gentle curve, +-sharp turn: body narrows and a pale flank / raised fin shows = partial side profile). Cached lazily. */
(function () {
  var INK = '#14102a', CREAM = '#fff4d6';
  var SPEC = {
    s: { L: 10, W: 3.0, TL: 6, TW: 3.4, body: '#ff9a2e', rim: '#e0701a', ridge: '#ffb347', tail: '#ffd23f', tail2: '#ff9f1c', fin: '#ffd23f', flank: CREAM, eyes: [[0.2, 0.62, 0.9, INK]] },
    b: { L: 19, W: 6.5, TL: 11, TW: 7.2, body: '#e8423c', rim: '#8b1d2c', ridge: '#ff6a4a', tail: '#ff9a2e', tail2: '#e8423c', fin: '#ff9a2e', flank: '#ffb06a', eyes: [[0.17, 0.66, 1.15, INK]],
      patches: [[0.36, 0.28, 0.15, 0.3, CREAM], [0.62, -0.25, 0.12, 0.28, '#ff9a2e'], [0.5, 0.1, 0.07, 0.15, CREAM]] },
    g: { L: 13, W: 4.3, TL: 10, TW: 6.4, body: '#ffd23f', rim: '#ff9f1c', ridge: CREAM, tail: '#ffe27a', tail2: '#ff9f1c', fin: '#ffe27a', flank: CREAM, eyes: [[0.18, 0.64, 1.0, INK]] },
    k: { L: 13, W: 4.9, TL: 10, TW: 6.8, body: '#241b3d', rim: '#5a4a8a', ridge: '#5a4a8a', tail: '#5a4a8a', tail2: '#241b3d', fin: '#5a4a8a', flank: '#5a4a8a', bulge: 1, eyes: [[0.2, 1.0, 1.9, '#8b6fd0']] }
  };
  var cache = {}, NDIR = 16;
  function hw(sp, t) { // dorsal half-width along the body, t = 0 (snout) .. 1 (tail root)
    if (t < 0 || t > 1) return 0;
    if (t < 0.34) { var q = (0.34 - t) / 0.34; return sp.W * Math.sqrt(Math.max(0, 1 - q * q)); }
    return sp.W * (1 - Math.pow((t - 0.34) / 0.66, 1.25) * 0.78);
  }
  function make(type, di, bend, wi, amp) {
    var sp = SPEC[type], L = sp.L, ang = di / NDIR * Math.PI * 2, ca = Math.cos(ang), sa = Math.sin(ang);
    var bendVal = [0, 0.07, 0.17][Math.abs(bend)] * L * (bend < 0 ? -1 : 1);       // >0: turning toward +v, tail swings to -v
    var wag = [0, 1, 0, -1][wi] * (amp ? 0.075 : 0.04) * L;
    var roll = Math.abs(bend) === 2, outer = bend > 0 ? -1 : 1, TLt = sp.TL / L;
    var R = Math.ceil(Math.sqrt(Math.pow(L / 2 + sp.TL, 2) + Math.pow(Math.abs(bendVal) * 2.8 + Math.abs(wag) * 2.8 + sp.TW, 2)) + 2), S = R * 2;
    var cv = document.createElement('canvas'); cv.width = cv.height = S; var g = cv.getContext('2d');
    var sh = document.createElement('canvas'); sh.width = sh.height = S; var gs = sh.getContext('2d');
    var grid = new Array(S * S);
    for (var py = 0; py < S; py++) for (var px = 0; px < S; px++) {
      var dx = px + 0.5 - R, dy = py + 0.5 - R, u = dx * ca + dy * sa, v = -dx * sa + dy * ca;
      var t = (L / 2 - u) / L, tt = Math.max(0, t), vl = v - (-bendVal + wag) * tt * tt;
      var col = null, h = hw(sp, t) * (roll ? 0.68 : 1), av = Math.abs(vl);
      if (t >= 0 && t <= 1 && av < h) {
        col = sp.body;
        if (av > h - 0.95) col = sp.rim;
        else if (av < 0.55 && t > 0.12 && t < 0.8) col = sp.ridge;
        if (sp.patches && av <= h - 0.95) sp.patches.forEach(function (p) { var a = ((t - p[0]) / p[2]), b = ((vl / sp.W - p[1]) / p[3]); if (a * a + b * b < 1) col = p[4]; });
        if (type === 's' && av < 0.9 * h && t > 0.46 && t < 0.62 && av <= h - 0.95) col = CREAM;
        if (roll && vl * outer > 0.2 * h && av <= h - 0.95) col = sp.flank;   // pale flank = glimpse of the side
      } else {
        // pectoral fins (swept back), flap with the wag; bigger on the raised (outer) side while rolled
        if (t > 0.34 && t < 0.6 && av >= h) {
          var dv = av - hw(sp, t) * (roll ? 0.68 : 1), F = sp.W * (0.62 + 0.2 * wag / (0.075 * L)) * (roll && vl * outer > 0 ? 1.5 : 1);
          if (dv < F * (1 - (t - 0.34) / 0.26)) col = sp.fin;
        }
        if (t > 1 - 0.02 && t <= 1 + TLt) { // fan tail with a forked edge and rays
          var s = Math.min(1, Math.max(0, (t - 1) / TLt)), ph = hw(sp, 1), tw = ph + (sp.TW - ph) * Math.pow(s, 0.72);
          if (roll) tw *= 0.8;
          if (av < tw && !(s > 0.7 && av < (s - 0.7) * sp.TW * 1.05)) {
            var ray = Math.floor(Math.atan2(vl, s * sp.TL + 1.2) * 7); col = (ray & 1) ? sp.tail : sp.tail2;
            if (av > tw - 0.8 && s > 0.3) col = sp.tail;
          }
        }
      }
      // eyes (drawn last: bulging ones stick out of the head, seen from above)
      sp.eyes.forEach(function (e) {
        var ev = e[1] * (sp.bulge ? 1 : hw(sp, e[0])) * (sp.bulge ? 1 : 1); if (sp.bulge) ev = hw(sp, e[0]) * (roll ? .68 : 1) + 0.5;
        [-1, 1].forEach(function (sg) {
          var a = (t - e[0]) * L, b = vl - sg * ev; if (roll && sg === outer) return;
          if (a * a + b * b < e[2] * e[2]) { col = e[3]; if (sp.bulge && a * a + b * b < 1.1 && a < 0.1 && b * sg < 0) col = INK; if (sp.bulge && a < -0.2 && (b * sg) > 0.1 && a > -1.0 && a * a + b * b < 2.2) col = '#ffffff'; }
        });
      });
      grid[py * S + px] = col;
    }
    // 1px darker outline so the fish read against the water
    var out = sp.rim === '#5a4a8a' ? '#14102a' : '#0b2a5b';
    for (py = 0; py < S; py++) for (px = 0; px < S; px++) {
      var c = grid[py * S + px];
      if (c) { g.fillStyle = c; g.fillRect(px, py, 1, 1); if (((px + py) & 1) === 0) { gs.fillStyle = '#0b2a5b'; gs.fillRect(px, py, 1, 1); } }
    }
    var og = g.getImageData(0, 0, S, S), od = og.data, oc = [parseInt(out.slice(1, 3), 16), parseInt(out.slice(3, 5), 16), parseInt(out.slice(5, 7), 16)];
    for (py = 0; py < S; py++) for (px = 0; px < S; px++) {
      if (grid[py * S + px]) continue;
      var nb = (px > 0 && grid[py * S + px - 1]) || (px < S - 1 && grid[py * S + px + 1]) || (py > 0 && grid[(py - 1) * S + px]) || (py < S - 1 && grid[(py + 1) * S + px]);
      if (nb) { var k = (py * S + px) * 4; od[k] = oc[0]; od[k + 1] = oc[1]; od[k + 2] = oc[2]; od[k + 3] = 255; }
    }
    g.putImageData(og, 0, 0);
    return { c: cv, sh: sh, R: R };
  }
  function get(type, heading, bend, wi, amp) {
    var di = ((Math.round(heading / (Math.PI * 2) * NDIR) % NDIR) + NDIR) % NDIR, key = type + '|' + di + '|' + bend + '|' + wi + '|' + amp, e = cache[key];
    return e || (cache[key] = make(type, di, bend, wi, amp));
  }
  window.FishSprite = { get: get, SPEC: SPEC };
})();
