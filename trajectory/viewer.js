/* trajectory viewer: two WebGL views with one camera and one slider, for examining the reference a transport call
   generated (left) against what the arm and S0 did (right), or two generated references side by side.
   Source: s2/s2loop/trajectory_viewer.js, copied to s2/reports/dashboard/trajectory/viewer.js by trajectory_page.py.
   Data: window.TRAJ from trajectory/index.js; one call's rows from trajectory/r_<id>.js (loaded when chosen). No library. */
(function () {
  'use strict';
  var T = window.TRAJ, root = document.getElementById('traj');
  if (!root) return;
  var $ = function (sel) { return root.querySelector(sel); };
  function failAll(text) { Array.prototype.forEach.call(root.querySelectorAll('.vmsg'), function (m) { m.textContent = text; m.style.display = 'block'; }); }
  if (!T) { failAll('The data (trajectory/index.js) did not load.'); return; }
  var loaded = {}, waiting = {};
  T.load = function (id, data) { loaded[id] = data; prepareData(data); (waiting[id] || []).forEach(function (cb) { cb(); }); delete waiting[id]; };
  function need(id, cb) {
    if (loaded[id]) { cb(); return; }
    if (waiting[id]) { waiting[id].push(cb); return; }
    waiting[id] = [cb];
    var s = document.createElement('script'); s.src = 'trajectory/r_' + id + '.js';
    s.onerror = function () { failAll('The rows of this call (trajectory/r_' + id + '.js) did not load.'); };
    document.body.appendChild(s);
  }

  // ---------------------------------------------------------------- small maths
  function mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    return o;
  }
  var I3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  function rotOfQuat(q) {
    var w = q[0], x = q[1], y = q[2], z = q[3], n = Math.sqrt(w * w + x * x + y * y + z * z) || 1;
    w /= n; x /= n; y /= n; z /= n;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  }
  function mm(A, B) {
    var o = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) o[i][j] = A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j];
    return o;
  }
  function axisAngle(a, t) {
    var x = a[0], y = a[1], z = a[2], c = Math.cos(t), s = Math.sin(t), C = 1 - c;
    return [[c + x * x * C, x * y * C - z * s, x * z * C + y * s], [y * x * C + z * s, c + y * y * C, y * z * C - x * s], [z * x * C - y * s, z * y * C + x * s, c + z * z * C]];
  }
  function matOf(R, p, s) {
    s = s || [1, 1, 1];
    return new Float32Array([R[0][0] * s[0], R[1][0] * s[0], R[2][0] * s[0], 0, R[0][1] * s[1], R[1][1] * s[1], R[2][1] * s[1], 0,
                             R[0][2] * s[2], R[1][2] * s[2], R[2][2] * s[2], 0, p[0], p[1], p[2], 1]);
  }
  function apply(R, p, v) {
    return [p[0] + R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], p[1] + R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2], p[2] + R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
  }
  function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
  function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
  function norm(a) { var n = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }
  function perspective(fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2), o = new Float32Array(16);
    o[0] = f / aspect; o[5] = f; o[10] = (far + near) / (near - far); o[11] = -1; o[14] = 2 * far * near / (near - far);
    return o;
  }
  function lookAt(eye, target, up) {
    var z = norm(sub(eye, target)), x = norm(cross(up, z)), y = cross(z, x);
    return new Float32Array([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0,
                             -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]), -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]);
  }
  function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }
  function pose(arr, i) {
    return { p: [arr[i * 7] / 1e4, arr[i * 7 + 1] / 1e4, arr[i * 7 + 2] / 1e4], q: [arr[i * 7 + 3], arr[i * 7 + 4], arr[i * 7 + 5], arr[i * 7 + 6]],
             R: rotOfQuat([arr[i * 7 + 3], arr[i * 7 + 4], arr[i * 7 + 5], arr[i * 7 + 6]]) };
  }
  function angleBetween(Ra, Rb) {          // degrees between two rotations
    var tr = 0;
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) tr += Ra[i][j] * Rb[i][j];
    return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) * 180 / Math.PI;
  }

  // ---------------------------------------------------------------- data of one call, once
  var links = T.hand.links;
  links.forEach(function (l) { l.R = rotOfQuat(l.quat); });
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var C = dark ? { bg: [0.105, 0.105, 0.1], table: [0.33, 0.3, 0.27], grid: [0.5, 0.48, 0.45], hand: [0.62, 0.62, 0.6], mark: [0.95, 0.95, 0.93] }
               : { bg: [0.955, 0.953, 0.945], table: [0.86, 0.81, 0.74], grid: [0.62, 0.58, 0.52], hand: [0.2, 0.2, 0.22], mark: [0.08, 0.08, 0.08] };
  var BLOCK = [0.37, 0.77, 0.81];
  function prepareData(d) {
    d.phaseOf = new Array(d.rows); d.segOf = new Uint16Array(d.rows);
    d.segments.forEach(function (s, i) { s.rgb = hex(T.phases[s.phase] || '#888888'); for (var r = s.r0; r <= s.r1; r++) { d.phaseOf[r] = s; d.segOf[r] = i; } });
    function speeds(arr) {              // per row: speed (m/s) and turn rate (deg/s) of a track
      var v = new Float32Array(d.rows), w = new Float32Array(d.rows);
      for (var r = 1; r < d.rows; r++) {
        var a = pose(arr, r - 1), b = pose(arr, r);
        v[r] = Math.hypot(b.p[0] - a.p[0], b.p[1] - a.p[1], b.p[2] - a.p[2]) / d.dt; w[r] = angleBetween(a.R, b.R) / d.dt;
      }
      return { v: v, w: w };
    }
    d.thing = speeds(d.tc); d.wrist = speeds(d.wc);
  }
  function handPoses(P, q) {             // world rotation and position of every link, palm pose P, joint angles q (1e-2 rad)
    var Rs = [P.R], ps = [P.p];
    for (var i = 1; i < links.length; i++) {
      var l = links[i], Rp = Rs[l.parent], R = mm(Rp, l.R);
      if (l.axis) R = mm(R, axisAngle(l.axis, (q[l.qi] || 0) / 100));
      Rs.push(R); ps.push(apply(Rp, ps[l.parent], l.pos));
    }
    return { R: Rs, p: ps };
  }

  // ---------------------------------------------------------------- one view = one canvas with its own GL things
  var cubeTris = [], sphereTris = [];
  (function () {
    var f = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]], [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]],
             [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]], [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]];
    f.forEach(function (q) { [0, 1, 2, 0, 2, 3].forEach(function (i) { cubeTris.push(q[i][0], q[i][1], q[i][2]); }); });
    var nu = 12, nv = 8;
    function pt(i, j) { var u = 2 * Math.PI * i / nu, v = Math.PI * j / nv; return [Math.sin(v) * Math.cos(u), Math.sin(v) * Math.sin(u), Math.cos(v)]; }
    for (var j = 0; j < nv; j++) for (var i = 0; i < nu; i++) [pt(i, j), pt(i, j + 1), pt(i + 1, j + 1), pt(i, j), pt(i + 1, j + 1), pt(i + 1, j)].forEach(function (p) { sphereTris.push(p[0], p[1], p[2]); });
  })();
  function trisOf(v, f) { var o = []; for (var i = 0; i < f.length; i++) o.push(v[f[i] * 3], v[f[i] * 3 + 1], v[f[i] * 3 + 2]); return o; }

  function View(wrap, index) {
    this.index = index; this.canvas = wrap.querySelector('canvas'); this.labels = wrap.querySelector('.vlabels'); this.msg = wrap.querySelector('.vmsg');
    var gl = this.gl = this.canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true }) || this.canvas.getContext('experimental-webgl');
    if (!gl) { this.msg.textContent = 'This browser has no WebGL: the 3D view cannot draw.'; this.msg.style.display = 'block'; return; }
    function program(vs, fs) {
      function sh(type, src) { var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; }
      var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
      return p;
    }
    this.lit = program(
      'attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uVP; uniform mat4 uM; varying vec3 vN; varying vec3 vW;' +
      'void main(){ vec4 w = uM * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uM) * aNor; gl_Position = uVP * w; }',
      'precision mediump float; uniform vec4 uColor; uniform vec3 uEye; varying vec3 vN; varying vec3 vW;' +
      'void main(){ vec3 n = normalize(vN); vec3 v = normalize(uEye - vW); if (dot(n, v) < 0.0) n = -n;' +
      ' float a = max(dot(n, normalize(vec3(0.35, 0.25, 0.9))), 0.0); float b = max(dot(n, v), 0.0);' +
      ' gl_FragColor = vec4(uColor.rgb * (0.42 + 0.45 * a + 0.2 * b), uColor.a); }');
    this.line = program(
      'attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uVP; uniform vec2 uOff; varying vec3 vC;' +
      'void main(){ vC = aCol; gl_Position = uVP * vec4(aPos, 1.0); gl_Position.xy += uOff * gl_Position.w; }',
      'precision mediump float; uniform float uAlpha; varying vec3 vC; void main(){ gl_FragColor = vec4(vC, uAlpha); }');
    var lit = this.lit, line = this.line;
    this.L = { pos: gl.getAttribLocation(lit, 'aPos'), nor: gl.getAttribLocation(lit, 'aNor'), vp: gl.getUniformLocation(lit, 'uVP'), m: gl.getUniformLocation(lit, 'uM'),
               color: gl.getUniformLocation(lit, 'uColor'), eye: gl.getUniformLocation(lit, 'uEye') };
    this.N = { pos: gl.getAttribLocation(line, 'aPos'), col: gl.getAttribLocation(line, 'aCol'), vp: gl.getUniformLocation(line, 'uVP'), off: gl.getUniformLocation(line, 'uOff'),
               alpha: gl.getUniformLocation(line, 'uAlpha') };
    this.cube = this.tris(cubeTris); this.sphere = this.tris(sphereTris);
    var self = this;
    this.hand = links.map(function (l) { return l.f && l.f.length ? self.tris(trisOf(l.v, l.f)) : null; });
    this.res = {}; this.labelEls = []; this.ok = true;
  }
  View.prototype.tris = function (t) {
    var gl = this.gl, out = new Float32Array(t.length * 2);
    for (var i = 0; i < t.length; i += 9) {
      var a = [t[i], t[i + 1], t[i + 2]], b = [t[i + 3], t[i + 4], t[i + 5]], c = [t[i + 6], t[i + 7], t[i + 8]], n = norm(cross(sub(b, a), sub(c, a)));
      for (var k = 0; k < 3; k++) { var o = (i / 3 + k) * 6; out[o] = t[i + k * 3]; out[o + 1] = t[i + k * 3 + 1]; out[o + 2] = t[i + k * 3 + 2]; out[o + 3] = n[0]; out[o + 4] = n[1]; out[o + 5] = n[2]; }
    }
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, out, gl.STATIC_DRAW);
    return { buf: buf, count: t.length / 3 };
  };
  View.prototype.lines = function (d) {
    var gl = this.gl, buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(d.length ? d : [0, 0, 0, 0, 0, 0]), gl.STATIC_DRAW);
    return { buf: buf, count: d.length / 6 };
  };
  View.prototype.resources = function (id) {       // what one call needs in this view, built once
    if (this.res[id]) return this.res[id];
    var d = loaded[id], self = this, r = { mesh: this.tris(trisOf(d.mesh.v, d.mesh.f)) };
    function track(arr, count) {
      var o = [];
      for (var i = 0; i < count; i++) { var c = d.phaseOf[i].rgb; o.push(arr[i * 7] / 1e4, arr[i * 7 + 1] / 1e4, arr[i * 7 + 2] / 1e4, c[0], c[1], c[2]); }
      return self.lines(o);
    }
    function ticks(arr, count, len) {              // a short triad every 12 rows: the rotation along the track
      var o = [], cols = [[0.9, 0.15, 0.15], [0.1, 0.65, 0.15], [0.15, 0.35, 0.95]];
      for (var i = 0; i < count; i += 12) {
        var P = pose(arr, i);
        for (var a = 0; a < 3; a++) o.push(P.p[0], P.p[1], P.p[2], cols[a][0], cols[a][1], cols[a][2], P.p[0] + P.R[0][a] * len, P.p[1] + P.R[1][a] * len, P.p[2] + P.R[2][a] * len, cols[a][0], cols[a][1], cols[a][2]);
      }
      return self.lines(o);
    }
    r.tc = track(d.tc, d.rows); r.wc = track(d.wc, d.rows); r.ta = track(d.ta, d.rows_recorded); r.pa = track(d.pa, d.rows_recorded);
    r.tcTicks = ticks(d.tc, d.rows, 0.022); r.wcTicks = ticks(d.wc, d.rows, 0.03); r.taTicks = ticks(d.ta, d.rows_recorded, 0.022);
    var g = [], t = d.table;
    if (t) {
      var z = t.c[2] + t.h[2] + 0.0006, c = C.grid, step = 0.05;
      for (var x = t.c[0] - t.h[0]; x <= t.c[0] + t.h[0] + 1e-6; x += step) g.push(x, t.c[1] - t.h[1], z, c[0], c[1], c[2], x, t.c[1] + t.h[1], z, c[0], c[1], c[2]);
      for (var y = t.c[1] - t.h[1]; y <= t.c[1] + t.h[1] + 1e-6; y += step) g.push(t.c[0] - t.h[0], y, z, c[0], c[1], c[2], t.c[0] + t.h[0], y, z, c[0], c[1], c[2]);
    }
    r.grid = this.lines(g);
    this.res[id] = r;
    return r;
  };
  View.prototype.setLabels = function (id, withLabels) {
    this.labels.innerHTML = ''; this.labelEls = [];
    if (!withLabels) return;
    var d = loaded[id], self = this;
    d.keypoints.forEach(function (k) {
      var el = document.createElement('span'); el.className = 'vlabel'; el.textContent = k.label + ' (row ' + k.row + ')';
      self.labels.appendChild(el); self.labelEls.push({ el: el, p: k.p });
    });
  };
  View.prototype.draw = function (id, mode, row) {
    if (!this.ok || !loaded[id]) return;
    var gl = this.gl, canvas = this.canvas, d = loaded[id], res = this.resources(id), L = this.L, N = this.N, self = this;
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(canvas.clientWidth, 50), h = Math.max(canvas.clientHeight, 50);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    var eye = [cam.target[0] + cam.dist * Math.cos(cam.el) * Math.cos(cam.az), cam.target[1] + cam.dist * Math.cos(cam.el) * Math.sin(cam.az), cam.target[2] + cam.dist * Math.sin(cam.el)];
    var VP = mul(perspective(40 * Math.PI / 180, canvas.width / canvas.height, 0.02, 30), lookAt(eye, cam.target, [0, 0, 1]));
    gl.viewport(0, 0, canvas.width, canvas.height); gl.clearColor(C.bg[0], C.bg[1], C.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);
    function useLit() { gl.useProgram(self.lit); gl.uniformMatrix4fv(L.vp, false, VP); gl.uniform3fv(L.eye, eye); gl.enableVertexAttribArray(L.pos); gl.enableVertexAttribArray(L.nor); }
    function tri(g, M, rgb, alpha) {
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf); gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(L.nor, 3, gl.FLOAT, false, 24, 12);
      gl.uniformMatrix4fv(L.m, false, M); gl.uniform4f(L.color, rgb[0], rgb[1], rgb[2], alpha === undefined ? 1 : alpha); gl.drawArrays(gl.TRIANGLES, 0, g.count);
    }
    function hand(P, q, rgb, alpha) { var H = handPoses(P, q); for (var i = 0; i < links.length; i++) if (self.hand[i]) tri(self.hand[i], matOf(H.R[i], H.p[i]), rgb, alpha); }
    function useLine() { gl.useProgram(self.line); gl.uniformMatrix4fv(N.vp, false, VP); gl.enableVertexAttribArray(N.pos); gl.enableVertexAttribArray(N.col); }
    var OFFS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
    function ln(g, glmode, first, count, width, alpha) {
      if (count < 2) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, g.buf); gl.vertexAttribPointer(N.pos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(N.col, 3, gl.FLOAT, false, 24, 12);
      gl.uniform1f(N.alpha, alpha);
      var passes = width > 1 ? 5 : 1, px = 2 / w * (width > 2 ? 1.0 : 0.6), py = px * w / h;
      for (var k = 0; k < passes; k++) { gl.uniform2f(N.off, OFFS[k][0] * px, OFFS[k][1] * py); gl.drawArrays(glmode, first, count); }
    }
    var act = mode === 'act', rr = Math.min(row, d.rows - 1), ra = Math.min(rr, d.rows_recorded - 1);
    var thing = act ? (ra >= 0 ? pose(d.ta, ra) : null) : pose(d.tc, rr), wrist = act ? (ra >= 0 ? pose(d.pa, ra) : null) : pose(d.wc, rr);
    var q = act && ra >= 0 ? d.qa.slice(ra * d.qf.length, (ra + 1) * d.qf.length) : d.qf;
    useLit();
    if (d.table) tri(this.cube, matOf(I3, d.table.c, d.table.h), C.table);
    if (thing) tri(res.mesh, matOf(thing.R, thing.p), BLOCK);
    if (wrist) hand(wrist, q, C.hand);
    d.keypoints.forEach(function (k) { tri(self.sphere, matOf(I3, k.p, [0.005, 0.005, 0.005]), C.mark); });
    useLine(); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    ln(res.grid, gl.LINES, 0, res.grid.count, 1, 0.35);
    if (act) {
      ln(res.tc, gl.LINE_STRIP, 0, d.rows, 1, 0.3); ln(res.wc, gl.LINE_STRIP, 0, d.rows, 1, 0.3);            // the generated tracks, faint
      ln(res.ta, gl.LINE_STRIP, 0, d.rows_recorded, 1, 0.8); ln(res.pa, gl.LINE_STRIP, 0, d.rows_recorded, 1, 0.8);
      ln(res.ta, gl.LINE_STRIP, 0, ra + 1, 3, 1); ln(res.pa, gl.LINE_STRIP, 0, ra + 1, 3, 1);
      ln(res.taTicks, gl.LINES, 0, res.taTicks.count, 1, 0.9);
    } else {
      ln(res.tc, gl.LINE_STRIP, 0, d.rows, 1, 0.8); ln(res.wc, gl.LINE_STRIP, 0, d.rows, 1, 0.8);
      ln(res.tc, gl.LINE_STRIP, 0, rr + 1, 3, 1); ln(res.wc, gl.LINE_STRIP, 0, rr + 1, 3, 1);
      ln(res.tcTicks, gl.LINES, 0, res.tcTicks.count, 2, 0.95); ln(res.wcTicks, gl.LINES, 0, res.wcTicks.count, 1, 0.9);
      useLit(); gl.depthMask(false);                                     // onion skins: the thing and the hand at the keypoints
      d.keypoints.forEach(function (k) {
        var a = pose(d.tc, k.row), b = pose(d.wc, k.row);
        tri(res.mesh, matOf(a.R, a.p), BLOCK, 0.22); hand(b, d.qf, C.hand, 0.1);
      });
      gl.depthMask(true);
    }
    gl.disable(gl.BLEND);
    this.labelEls.forEach(function (l) {
      var x = VP[0] * l.p[0] + VP[4] * l.p[1] + VP[8] * l.p[2] + VP[12], y = VP[1] * l.p[0] + VP[5] * l.p[1] + VP[9] * l.p[2] + VP[13], ww = VP[3] * l.p[0] + VP[7] * l.p[1] + VP[11] * l.p[2] + VP[15];
      if (ww <= 0) { l.el.style.display = 'none'; return; }
      l.el.style.display = 'block';
      l.el.style.transform = 'translate(' + ((x / ww * 0.5 + 0.5) * w + 8).toFixed(1) + 'px,' + ((0.5 - y / ww * 0.5) * h - 9).toFixed(1) + 'px)';
    });
  };

  // ---------------------------------------------------------------- state
  var HOME = { target: [-0.42, -0.4, 0.97], az: 60 * Math.PI / 180, el: 28 * Math.PI / 180, dist: 0.7 };
  var cam = JSON.parse(JSON.stringify(HOME));
  var S = { choice: null, left: null, right: null, modes: ['ref', 'act'], row: 0, playing: false, speed: 1 };
  var dirty = true, live = false;
  var wraps = root.querySelectorAll('.tview'), views = [new View(wraps[0], 0), new View(wraps[1], 1)];
  var slider = $('.vslider'), readout = $('.vread'), strip = $('.vstrip'), playBtn = $('.vplay'), sel = $('.vsel');
  var names = root.querySelectorAll('.tname'), subs = root.querySelectorAll('.tsub');
  root.setAttribute('data-webgl', views[0].ok && views[1].ok ? 'yes' : 'no');
  function runInfo(id) { for (var i = 0; i < T.runs.length; i++) if (T.runs[i].id === id) return T.runs[i]; return null; }
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function maxRows() { var a = loaded[S.left], b = loaded[S.right]; return Math.max(a ? a.rows : 1, b ? b.rows : 1); }
  function setRow(r, fromSlider) {
    S.row = Math.max(0, Math.min(maxRows() - 1, Math.round(r)));
    if (!fromSlider) slider.value = S.row;
    updateReadout(); updateHash(); dirty = true;
  }
  function choose(choice, row) {
    var pair = null, i;
    for (i = 0; i < T.pairs.length; i++) if (T.pairs[i].id === choice) pair = T.pairs[i];
    if (!pair && !runInfo(choice)) choice = T.runs.length ? T.runs[0].id : null;
    if (!choice) { failAll('No transport call with a stored reference was found.'); return; }
    S.choice = choice; sel.value = choice;
    S.left = pair ? pair.left : choice; S.right = pair ? pair.right : choice; S.modes = pair ? ['ref', 'ref'] : ['ref', 'act'];
    var todo = S.left === S.right ? 1 : 2, done = 0;
    function ready() {
      if (++done < todo || S.choice !== choice) return;
      var d = loaded[S.left], a = runInfo(S.left), b = runInfo(S.right);
      names[0].textContent = pair ? 'Generated reference: ' + a.title : 'Generated reference (what the skill hands to S0)';
      names[1].textContent = pair ? 'Generated reference: ' + b.title : 'What the arm and S0 did on the same rows';
      slider.max = maxRows() - 1;
      views[0].setLabels(S.left, true); views[1].setLabels(S.right, !!pair);
      var k = d.keypoints.length ? d.keypoints[Math.floor(d.keypoints.length / 2)].p : [d.tc[0] / 1e4, d.tc[1] / 1e4, d.tc[2] / 1e4];
      if (Math.hypot(cam.target[0] - k[0], cam.target[1] - k[1]) > 0.3) cam.target = [k[0], k[1], k[2]];
      var html = '';
      d.segments.forEach(function (s) {
        html += '<button type="button" class="vseg" data-row="' + s.r0 + '" style="flex:' + (s.r1 - s.r0 + 1) + ' 0 0;background:' + (T.phases[s.phase] || '#888') +
                '" title="' + esc(s.phase + ', rows ' + s.r0 + ' to ' + s.r1) + '"></button>';
      });
      d.keypoints.forEach(function (kp) { html += '<span class="vev" style="left:' + (100 * kp.row / Math.max(maxRows() - 1, 1)) + '%" title="' + esc(kp.label + ', row ' + kp.row) + '"></span>'; });
      strip.innerHTML = html;
      setRow(row === undefined ? d.segments.filter(function (s) { return s.phase === 'move'; }).map(function (s) { return s.r0; })[0] || 0 : row);
      root.setAttribute('data-choice', choice);
    }
    need(S.left, ready); if (todo === 2) need(S.right, ready);
  }
  var hashTimer = null;
  function updateHash() {
    if (hashTimer || !live) return;
    hashTimer = setTimeout(function () {
      hashTimer = null;
      try { history.replaceState(null, '', '#' + (S.left === S.right ? 'run=' : 'cmp=') + S.choice + '&row=' + S.row); } catch (e) { /* some browsers refuse this on local files */ }
    }, 120);
  }
  function readHash() {
    var h = window.location.hash || '', r = /(?:run|cmp)=([\w-]+)/.exec(h), t = /row=(\d+)/.exec(h);
    if (!r) return false;
    var az = /az=(-?[\d.]+)/.exec(h), el = /el=(-?[\d.]+)/.exec(h), dd = /d=([\d.]+)/.exec(h);
    if (az) cam.az = parseFloat(az[1]) * Math.PI / 180;
    if (el) cam.el = parseFloat(el[1]) * Math.PI / 180;
    if (dd) cam.dist = parseFloat(dd[1]);
    live = true; choose(r[1], t ? parseInt(t[1], 10) : undefined);
    return true;
  }
  function describe(id, row) {
    var d = loaded[id], r = Math.min(row, d.rows - 1), s = d.phaseOf[r];
    return '<b>row ' + r + '</b> of ' + (d.rows - 1) + ' (tick ' + (d.row0_tick + r) + ') &nbsp;·&nbsp; ' + (r * d.dt).toFixed(2) + ' s &nbsp;·&nbsp; <span class="vchip" style="background:' +
      (T.phases[s.phase] || '#888') + '"></span><b>' + esc(s.phase) + '</b> (rows ' + s.r0 + ' to ' + s.r1 + ') &nbsp;·&nbsp; commanded: thing <b>' + d.thing.v[r].toFixed(3) + ' m/s</b>, wrist <b>' +
      d.wrist.v[r].toFixed(3) + ' m/s</b>, turn rate of the thing <b>' + d.thing.w[r].toFixed(0) + ' deg/s</b> (wrist ' + d.wrist.w[r].toFixed(0) + ')';
  }
  function updateReadout() {
    if (!loaded[S.left] || !loaded[S.right]) return;
    var cmp = S.left !== S.right, d = loaded[S.left];
    readout.innerHTML = '<div class="vr1">' + (cmp ? 'left: ' : '') + describe(S.left, S.row) + '</div>' + (cmp ? '<div class="vr1">right: ' + describe(S.right, S.row) + '</div>' : '');
    var info = runInfo(S.left);
    subs[0].innerHTML = (cmp ? '' : esc(info.title) + '. ') + 'Hand drawn in one fixed finger posture (the record\'s at row ' + d.fixed_posture_row + '): the reference has no finger posture.' +
      (d.interpolation ? ' Interpolation: ' + esc(d.interpolation) + '.' : '') + ' Keypoints: ' + d.keypoints.length + '.';
    if (cmp) {
      var e = loaded[S.right];
      subs[1].innerHTML = 'Hand drawn in one fixed finger posture (the record\'s at row ' + e.fixed_posture_row + ').' + (e.interpolation ? ' Interpolation: ' + esc(e.interpolation) + '.' : '') +
        ' Keypoints: ' + e.keypoints.length + '.';
    } else {
      var r = Math.min(S.row, d.rows - 1);
      if (r < d.rows_recorded) {
        var a = pose(d.tc, r), b = pose(d.ta, r), c = pose(d.wc, r), p = pose(d.pa, r);
        subs[1].innerHTML = 'Commanded against actual thing at this row: <b>' + (Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) * 1000).toFixed(0) + ' mm</b>, <b>' +
          angleBetween(a.R, b.R).toFixed(0) + ' deg</b>. Wrist: ' + (Math.hypot(c.p[0] - p.p[0], c.p[1] - p.p[1], c.p[2] - p.p[2]) * 1000).toFixed(1) + ' mm, ' + angleBetween(c.R, p.R).toFixed(1) +
          ' deg. Fingers: the recorded joint angles. Faint lines: the generated tracks.';
      } else subs[1].innerHTML = 'The record ends before this row (' + d.rows_recorded + ' of ' + d.rows + ' rows were executed).';
    }
  }

  // ---------------------------------------------------------------- loop and controls
  var last = 0, carry = 0;
  function frame(now) {
    if (S.playing) {
      carry += (now - last) / 1000 / 0.02 * S.speed;
      var step = Math.floor(carry);
      if (step > 0) { carry -= step; if (S.row + step >= maxRows() - 1) { setRow(maxRows() - 1); setPlaying(false); } else setRow(S.row + step); }
    }
    last = now;
    if (dirty && loaded[S.left] && loaded[S.right]) {
      dirty = false; views[0].draw(S.left, S.modes[0], S.row); views[1].draw(S.right, S.modes[1], S.row);
      root.setAttribute('data-drawn', S.choice + ':' + S.row);
    }
    window.requestAnimationFrame(frame);
  }
  function setPlaying(p) { S.playing = p; carry = 0; playBtn.textContent = p ? 'pause' : 'play'; if (p && S.row >= maxRows() - 1) setRow(0); }
  (function () {
    var html = '', group = null;
    T.runs.forEach(function (r) {
      if (r.group !== group) { html += (group ? '</optgroup>' : '') + '<optgroup label="' + esc(r.group) + '">'; group = r.group; }
      html += '<option value="' + r.id + '">' + esc(r.title) + '</option>';
    });
    if (group) html += '</optgroup>';
    if (T.pairs.length) { html += '<optgroup label="compare: linear against spline (both generated)">'; T.pairs.forEach(function (p) { html += '<option value="' + p.id + '">' + esc(p.title) + '</option>'; }); html += '</optgroup>'; }
    sel.innerHTML = html;
  })();
  sel.addEventListener('change', function () { live = true; choose(sel.value); });
  slider.addEventListener('input', function () { live = true; setRow(parseInt(slider.value, 10), true); });
  playBtn.addEventListener('click', function () { setPlaying(!S.playing); });
  $('.vspeed').addEventListener('change', function (e) { S.speed = parseFloat(e.target.value); });
  $('.vreset').addEventListener('click', function () { var t = cam.target; cam = JSON.parse(JSON.stringify(HOME)); cam.target = t; dirty = true; });
  root.addEventListener('click', function (e) { var b = e.target.closest ? e.target.closest('[data-row]') : null; if (b) { live = true; setPlaying(false); setRow(parseInt(b.getAttribute('data-row'), 10)); } });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var a = document.activeElement;
    if (a === slider || (a && /^(SELECT|TEXTAREA)$/.test(a.tagName))) return;
    e.preventDefault(); live = true; setPlaying(false); setRow(S.row + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  });
  window.addEventListener('hashchange', readHash);
  window.addEventListener('resize', function () { dirty = true; });
  function panBy(dx, dy) {
    var eye = [cam.target[0] + cam.dist * Math.cos(cam.el) * Math.cos(cam.az), cam.target[1] + cam.dist * Math.cos(cam.el) * Math.sin(cam.az), cam.target[2] + cam.dist * Math.sin(cam.el)];
    var f = norm(sub(cam.target, eye)), right = norm(cross(f, [0, 0, 1])), up = cross(right, f), k = cam.dist * 0.0016;
    for (var i = 0; i < 3; i++) cam.target[i] += (-dx * right[i] + dy * up[i]) * k;
  }
  views.forEach(function (v) {                      // either canvas moves the one camera
    var canvas = v.canvas, pointers = {}, pinch = 0;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
    canvas.addEventListener('pointerdown', function (e) {
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer */ }
      pointers[e.pointerId] = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; pinch = 0; e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      var p = pointers[e.pointerId]; if (!p) return;
      var dx = e.clientX - p.x, dy = e.clientY - p.y, ids = Object.keys(pointers);
      p.x = e.clientX; p.y = e.clientY;
      if (ids.length >= 2) {
        var a = pointers[ids[0]], b = pointers[ids[1]], dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (pinch > 0 && dist > 0) cam.dist = Math.max(0.1, Math.min(5, cam.dist * pinch / dist));
        pinch = dist; panBy(dx * 0.5, dy * 0.5);
      } else if (p.pan || e.shiftKey) panBy(dx, dy);
      else { cam.az -= dx * 0.006; cam.el = Math.max(-1.5, Math.min(1.5, cam.el + dy * 0.006)); }
      dirty = true;
    });
    function release(e) { delete pointers[e.pointerId]; pinch = 0; }
    canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
    canvas.addEventListener('wheel', function (e) { e.preventDefault(); cam.dist = Math.max(0.1, Math.min(5, cam.dist * Math.exp(e.deltaY * 0.0012))); dirty = true; }, { passive: false });
  });

  S.speed = parseFloat($('.vspeed').value) || 1;
  if (!readHash()) choose(T.runs.length ? T.runs[0].id : null);
  if (/play=1/.test(window.location.hash)) setPlaying(true);
  if (/selftest=1/.test(window.location.hash)) {      // developer check: drive each control once with made-up events once the rows are in
    var tries = 0, timer = setInterval(function () {
      if (!(loaded[S.left] && loaded[S.right]) && ++tries < 100) return;
      clearInterval(timer);
      var res = {};
      try {
        var c0 = views[0].canvas, c1 = views[1].canvas, az0 = cam.az, d0 = cam.dist, tg0 = cam.target.slice();
        c1.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: 100, clientY: 100, button: 0, bubbles: true }));
        c1.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 160, clientY: 120, bubbles: true }));
        c1.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }));
        res.orbit_from_right_view = cam.az !== az0;
        c0.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true })); res.zoom_from_left_view = cam.dist > d0;
        c0.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, clientX: 100, clientY: 100, button: 2, bubbles: true }));
        c0.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: 140, clientY: 130, bubbles: true }));
        c0.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, bubbles: true }));
        res.pan = cam.target[0] !== tg0[0] || cam.target[1] !== tg0[1];
        $('.vreset').click(); res.reset = cam.dist === HOME.dist;
        slider.value = 100; slider.dispatchEvent(new Event('input')); res.slider = S.row === 100;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); res.key_right = S.row === 101;
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true })); res.key_shift_left = S.row === 91;
        strip.querySelector('.vseg:nth-child(3)').click(); res.strip = S.row === loaded[S.left].segments[2].r0;
        views[0].draw(S.left, S.modes[0], 0); views[1].draw(S.right, S.modes[1], maxRows() - 1); res.draw_first_and_last_row = true;
        playBtn.click(); res.play = S.playing === true; playBtn.click(); res.pause = S.playing === false;
        res.options = sel.options.length; res.gl_errors = [views[0].gl.getError(), views[1].gl.getError()];
      } catch (err) { res.error = String(err); }
      root.setAttribute('data-selftest', JSON.stringify(res));
    }, 50);
  }
  window.requestAnimationFrame(function (now) { last = now; frame(now); });
})();
