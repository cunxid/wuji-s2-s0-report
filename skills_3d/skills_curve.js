/* skills_curve.js: the skill program's own curve and time law, for the page "Skills (interactive)".
 *
 * A port of three functions of s2/outputs/harness_round/s0skill/v3/s0_skill_v3.py (the same three are in s0_rolls_v3.py and
 * s0_tight_v3.py): spline_through (a centripetal Catmull-Rom curve through the points), curvature, time_law (speed along the
 * curve: up to v_max with +-a, slower where the curve bends, not faster than v_descent in the last descent_zone, at rest at
 * the end), and trapezoid (the push's and the press's law). skills_page.py checks this port against the rows the program
 * stored for each run shown (node skills_curve_check.js) and prints the largest difference on the page.
 * Works in a browser (window.SkillCurve) and in node (module.exports).
 */
(function (root) {
  'use strict';
  var DT = 0.02;
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); }
  function comb(wa, a, wb, b) { return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]]; }
  function linspace(a, b, n) { var o = new Array(n); for (var i = 0; i < n; i++) o[i] = n === 1 ? a : a + (b - a) * i / (n - 1); return o; }
  function interp(x, xp, fp) {            // numpy.interp for increasing xp
    var n = xp.length;
    if (x <= xp[0]) return fp[0];
    if (x >= xp[n - 1]) return fp[n - 1];
    var lo = 0, hi = n - 1;
    while (hi - lo > 1) { var m = (lo + hi) >> 1; if (xp[m] <= x) lo = m; else hi = m; }
    var w = xp[hi] - xp[lo];
    return w > 0 ? fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / w : fp[lo];
  }
  function splineThrough(points, n) {
    n = n || 400;
    var P = [points[0].slice()], i;
    for (i = 1; i < points.length; i++) if (dist(points[i], P[P.length - 1]) > 1e-4) P.push(points[i].slice());
    if (P.length === 1) return { dense: [P[0]], s: [0], marks: [0] };
    var ext = [comb(2, P[0], -1, P[1])].concat(P, [comb(2, P[P.length - 1], -1, P[P.length - 2])]);
    var out = [P[0]], marks = [0];
    for (i = 1; i < ext.length - 2; i++) {
      var p0 = ext[i - 1], p1 = ext[i], p2 = ext[i + 1], p3 = ext[i + 2];
      var t0 = 0, t1 = t0 + Math.sqrt(Math.max(dist(p1, p0), 1e-6)), t2 = t1 + Math.sqrt(Math.max(dist(p2, p1), 1e-6)), t3 = t2 + Math.sqrt(Math.max(dist(p3, p2), 1e-6));
      var ts = linspace(t1, t2, n + 1);
      for (var k = 1; k <= n; k++) {
        var t = ts[k];
        var a1 = comb((t1 - t) / (t1 - t0), p0, (t - t0) / (t1 - t0), p1), a2 = comb((t2 - t) / (t2 - t1), p1, (t - t1) / (t2 - t1), p2), a3 = comb((t3 - t) / (t3 - t2), p2, (t - t2) / (t3 - t2), p3);
        var b1 = comb((t2 - t) / (t2 - t0), a1, (t - t0) / (t2 - t0), a2), b2 = comb((t3 - t) / (t3 - t1), a2, (t - t1) / (t3 - t1), a3);
        out.push(comb((t2 - t) / (t2 - t1), b1, (t - t1) / (t2 - t1), b2));
      }
      marks.push(out.length - 1);
    }
    var s = [0];
    for (i = 1; i < out.length; i++) s.push(s[i - 1] + dist(out[i], out[i - 1]));
    return { dense: out, s: s, marks: marks.map(function (m) { return s[m]; }) };
  }
  function column(dense, k) { return dense.map(function (p) { return p[k]; }); }
  function gradient(f, x) {               // numpy.gradient(f, x) on a uniform grid, first-order ends
    var n = f.length, o = new Array(n);
    o[0] = (f[1] - f[0]) / (x[1] - x[0]); o[n - 1] = (f[n - 1] - f[n - 2]) / (x[n - 1] - x[n - 2]);
    for (var i = 1; i < n - 1; i++) {
      var hd = x[i + 1] - x[i], hs = x[i] - x[i - 1];
      o[i] = (hs * hs * f[i + 1] + (hd * hd - hs * hs) * f[i] - hd * hd * f[i - 1]) / (hs * hd * (hd + hs));
    }
    return o;
  }
  function curvature(dense, s, step) {
    step = step || 0.002;
    var S = s[s.length - 1], n = Math.max(Math.floor(S / step), 4), sk = linspace(0, S, n + 1), d2 = [], k, i;
    for (k = 0; k < 3; k++) {
      var col = column(dense, k), pts = sk.map(function (x) { return interp(x, s, col); });
      d2.push(gradient(gradient(pts, sk), sk));
    }
    var kap = sk.map(function (_, j) { return Math.hypot(d2[0][j], d2[1][j], d2[2][j]); }), m = kap.length, sm = new Array(m);
    for (i = 0; i < m; i++) { var acc = 0; for (k = -2; k <= 2; k++) acc += kap[Math.min(Math.max(i + k, 0), m - 1)]; sm[i] = acc / 5; }
    return { sk: sk, kappa: sm };
  }
  function timeLaw(S, v0, rules, vMax, sk, kappa) {
    vMax = vMax === undefined || vMax === null ? rules.v_carry_m_s : vMax;
    var a = rules.a_carry_m_s2, vd = rules.v_descent_m_s, zone = rules.descent_zone_m;
    var n = Math.max(Math.floor(S / 0.001), 2), sg = linspace(0, S, n + 1), ds = S / n, vl = new Array(n + 1), i;
    for (i = 0; i <= n; i++) {
      vl[i] = vMax;
      if (kappa) vl[i] = Math.min(vl[i], Math.sqrt(rules.a_lat_m_s2 / Math.max(interp(sg[i], sk, kappa), 1e-3)));
      if (sg[i] >= S - zone) vl[i] = Math.min(vl[i], vd);
    }
    vl[n] = 0.004;
    for (i = n - 1; i >= 0; i--) vl[i] = Math.min(vl[i], Math.sqrt(vl[i + 1] * vl[i + 1] + 2 * a * ds));
    var s = 0, v = v0, out = [], speed = [];
    for (i = 0; i < 20000; i++) {
      if (S - s <= 1e-6) break;
      var cap = interp(s + v * DT, sg, vl);
      v = Math.max(Math.min(v + a * DT, Math.max(cap, v - 2.5 * a * DT)), 0.004);
      s = Math.min(S, s + v * DT);
      out.push(s); speed.push(v);
    }
    return { s: out, v: speed, limit: { s: sg, v: vl } };
  }
  function trapezoid(d, vPeak, acc) {
    if (d <= 1e-9) return [];
    var v = Math.min(vPeak, Math.sqrt(d * acc)), ta = v / acc, da = 0.5 * acc * ta * ta, tc = Math.max((d - 2 * da) / v, 0), T = 2 * ta + tc;
    var n = Math.ceil(T / DT - 1e-9), out = [];
    for (var i = 1; i <= n; i++) {
      var t = Math.min(i * DT, T);
      out.push(t < ta ? 0.5 * acc * t * t : (t < ta + tc ? da + v * (t - ta) : d - 0.5 * acc * (T - t) * (T - t)));
    }
    return out;
  }
  /* The carry of a transport: from where the clip's own lift ends (start, leaving along lead when it has one) through the
   * keypoints to the landing. Returns the rows (one every 20 ms), the dense curve, the speed per row and what limits it. */
  function carry(start, lead, mids, land, rules, v0, vMax) {
    var kept = [];                        // the program's rule: a keypoint under a raised landing (in its column, lower than 5 mm above it) is passed by
    mids.forEach(function (k, j) { if (!(Math.hypot(k[0] - land[0], k[1] - land[1]) <= 0.010 && k[2] < land[2] + 0.005)) kept.push(j); });
    var pts = [start].concat(lead ? [lead] : [], kept.map(function (j) { return mids[j]; }), [land]);
    var sp = splineThrough(pts), S = sp.s[sp.s.length - 1];
    if (S < 1e-6) return { rows: [], dense: sp.dense, s: [], length: 0, speed: [], marks: sp.marks, kappa: null, kept: kept };
    var cu = curvature(sp.dense, sp.s), law = timeLaw(S, v0, rules, vMax, cu.sk, cu.kappa);
    var cols = [column(sp.dense, 0), column(sp.dense, 1), column(sp.dense, 2)];
    var rows = law.s.map(function (x) { return [interp(x, sp.s, cols[0]), interp(x, sp.s, cols[1]), interp(x, sp.s, cols[2])]; });
    return { rows: rows, dense: sp.dense, s: law.s, length: S, speed: law.v, marks: sp.marks, kappa: cu, limit: law.limit, kept: kept };
  }
  var api = { DT: DT, splineThrough: splineThrough, curvature: curvature, timeLaw: timeLaw, trapezoid: trapezoid, carry: carry, interp: interp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.SkillCurve = api;
})(typeof window !== 'undefined' ? window : this);
