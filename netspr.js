/* Pixel paper-net sprites with 5 wear stages (+ broken). Shared by the big screen and the phone icon.
 * stage 0 intact, 1 small tear, 2 cracks, 3 bigger holes, 4 almost gone, 5 broken (frame + shreds). */
(function () {
  var R = 13, C = 15, SZ = 40, cache = {};
  var WOOD = '#7a4a2a', CREAM = '#fff4d6', WHITE = '#ffffff', FIBER = '#c9bfa6', DARK = '#6b7399';
  function stageOf(dur, broken) { if (broken) return 5; return dur > 80 ? 0 : dur > 60 ? 1 : dur > 40 ? 2 : dur > 20 ? 3 : 4; }
  function get(stage, col, down) {
    var key = stage + col + (down ? 'd' : 'u'), c = cache[key];
    if (c) return c;
    c = document.createElement('canvas'); c.width = c.height = SZ;
    var g = c.getContext('2d');
    function px(x, y, w, h, color) { g.fillStyle = color; g.fillRect(C + x, C + y, w || 1, h || 1); }
    function clr(x, y, w, h) { g.clearRect(C + x, C + y, w || 1, h || 1); }
    var paper = down ? '#bfe3ff' : WHITE, paper2 = down ? '#7cc8ff' : CREAM;
    if (stage < 5) {
      for (var y = -R + 1; y <= R - 1; y++) { var w = Math.floor(Math.sqrt((R - 1) * (R - 1) - y * y)); for (var x = -w; x <= w; x++) px(x, y, 1, 1, ((x + y) & 1) ? paper : paper2); }
      // paper fibres
      [[-6, -4, 3], [2, -7, 3], [-3, 5, 4], [4, 2, 3]].forEach(function (f) { px(f[0], f[1], f[2], 1, down ? '#9ad2fb' : FIBER); });
      if (stage >= 1) { clr(4, -6, 1, 1); clr(5, -5, 1, 2); px(3, -7, 1, 1, DARK); px(6, -4, 1, 1, DARK); } // small tear
      if (stage >= 2) { // cracks
        var cr = [[-8, -4], [-7, -3], [-6, -2], [-5, -2], [-4, -1], [-3, 0], [3, 4], [4, 5], [5, 5], [6, 6], [7, 7], [-5, 5], [-6, 6], [8, -2], [9, -1]];
        cr.forEach(function (p) { px(p[0], p[1], 1, 1, DARK); }); clr(-2, 1, 1, 1); clr(2, 3, 1, 1);
      }
      if (stage >= 3) { // bigger holes
        clr(-7, -6, 4, 3); clr(2, -9, 4, 4); clr(1, 3, 5, 4); clr(-8, 3, 3, 3); clr(-1, -2, 2, 2);
        var a = Math.PI * 0.25; clr(Math.round(Math.cos(a) * R) - 1, Math.round(-Math.sin(a) * R), 3, 3); // gap in the rim
      }
      if (stage >= 4) { // almost gone: only shreds near the rim
        for (var yy = -9; yy <= 9; yy++) { var ww = Math.floor(Math.sqrt(81 - yy * yy)); for (var xx = -ww; xx <= ww; xx++) if (((xx * 7 + yy * 3) & 7) !== 0) clr(xx, yy, 1, 1); }
        clr(-12, -3, 3, 5); clr(10, -1, 3, 4); clr(-4, 10, 5, 3); clr(-2, -12, 4, 3);
      }
    }
    // rim (player colour) with a dashed look when broken, gaps follow the wear
    var gaps = stage >= 4 ? 5 : stage >= 3 ? 2 : stage >= 2 ? 1 : 0;
    for (var s = 0; s < 64; s++) {
      var an = s / 64 * 6.2832, rx = Math.round(Math.cos(an) * R), ry = Math.round(Math.sin(an) * R);
      if (stage === 5 && (s % 8 === 3 || s % 8 === 4 || s % 8 === 5)) continue;
      if (gaps && (s * 7) % 64 < gaps * 3 && stage < 5) continue;
      px(rx, ry, 1, 1, col); if (stage < 5) px(Math.round(Math.cos(an) * (R - 1)), Math.round(Math.sin(an) * (R - 1)), 1, 1, col);
    }
    if (stage === 5) { px(-3, -2, 2, 1, CREAM); px(2, 3, 3, 1, CREAM); px(5, -5, 1, 2, CREAM); px(-6, 4, 2, 1, FIBER); }
    // handle
    for (var k = 0; k < 9; k++) px(R - 3 + k, R - 3 + k, 2, 2, k < 3 ? col : WOOD);
    cache[key] = c; return c;
  }
  window.NetSprite = { get: get, stageOf: stageOf, C: C, SZ: SZ, R: R };
})();
