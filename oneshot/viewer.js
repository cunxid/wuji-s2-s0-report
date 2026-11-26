/* oneshot viewer: a small self-contained WebGL viewer for the one-shot runs (no library, no network).
   Source: s2/s2loop/oneshot_viewer.js, copied to s2/reports/dashboard/oneshot/viewer.js by oneshot_page.py.
   Data: window.ONESHOT_VIEWER from oneshot/viewer_data.js (written by oneshot_film.viewer_payload). */
(function () {
  'use strict';
  var D = window.ONESHOT_VIEWER, root = document.getElementById('viewer');
  if (!root) return;
  var $ = function (sel) { return root.querySelector(sel); };
  var canvas = $('canvas'), msg = $('.vmsg');
  function fail(text) { msg.textContent = text; msg.style.display = 'block'; }
  if (!D) { fail('The viewer data (oneshot/viewer_data.js) did not load.'); return; }
  var gl = canvas.getContext('webgl', { antialias: true, alpha: false, preserveDrawingBuffer: true }) ||
           canvas.getContext('experimental-webgl');
  if (!gl) { fail('This browser has no WebGL: the 3D viewer cannot draw. The films below show the same runs.'); return; }
  root.setAttribute('data-webgl', 'yes');

  // ---------------------------------------------------------------- small maths (column-major 4x4)
  function mul(a, b) {
    var o = new Float32Array(16);
    for (var c = 0; c < 4; c++) for (var r = 0; r < 4; r++) {
      o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
    return o;
  }
  function ident() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); }
  function rotOfQuat(q) {          // q = [w, x, y, z] -> 3x3 as rows
    var w = q[0], x = q[1], y = q[2], z = q[3], n = Math.sqrt(w * w + x * x + y * y + z * z) || 1;
    w /= n; x /= n; y /= n; z /= n;
    return [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
  }
  function matOf(R, p, s) {        // rotation rows R, position p, per-axis scale s
    s = s || [1, 1, 1];
    return new Float32Array([R[0][0] * s[0], R[1][0] * s[0], R[2][0] * s[0], 0, R[0][1] * s[1], R[1][1] * s[1], R[2][1] * s[1], 0,
                             R[0][2] * s[2], R[1][2] * s[2], R[2][2] * s[2], 0, p[0], p[1], p[2], 1]);
  }
  function rotX(a) { var c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]]; }
  function rotZ(a) { var c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]]; }
  function apply(R, p, v) {
    return [p[0] + R[0][0] * v[0] + R[0][1] * v[1] + R[0][2] * v[2], p[1] + R[1][0] * v[0] + R[1][1] * v[1] + R[1][2] * v[2],
            p[2] + R[2][0] * v[0] + R[2][1] * v[1] + R[2][2] * v[2]];
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
                             -(x[0] * eye[0] + x[1] * eye[1] + x[2] * eye[2]), -(y[0] * eye[0] + y[1] * eye[1] + y[2] * eye[2]),
                             -(z[0] * eye[0] + z[1] * eye[1] + z[2] * eye[2]), 1]);
  }
  function hex(h) { h = h.replace('#', ''); return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]; }

  // ---------------------------------------------------------------- GL programs
  function program(vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram(); gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    return p;
  }
  var lit, line;
  try {
    lit = program(
      'attribute vec3 aPos; attribute vec3 aNor; uniform mat4 uVP; uniform mat4 uM; varying vec3 vN; varying vec3 vW;' +
      'void main(){ vec4 w = uM * vec4(aPos, 1.0); vW = w.xyz; vN = mat3(uM) * aNor; gl_Position = uVP * w; }',
      'precision mediump float; uniform vec4 uColor; uniform vec3 uEye; varying vec3 vN; varying vec3 vW;' +
      'void main(){ vec3 n = normalize(vN); vec3 v = normalize(uEye - vW); if (dot(n, v) < 0.0) n = -n;' +
      ' float a = max(dot(n, normalize(vec3(0.35, 0.25, 0.9))), 0.0); float b = max(dot(n, v), 0.0);' +
      ' gl_FragColor = vec4(uColor.rgb * (0.42 + 0.45 * a + 0.2 * b), uColor.a); }');
    line = program(
      'attribute vec3 aPos; attribute vec3 aCol; uniform mat4 uVP; uniform vec2 uOff; varying vec3 vC;' +
      'void main(){ vC = aCol; gl_Position = uVP * vec4(aPos, 1.0); gl_Position.xy += uOff * gl_Position.w; }',
      'precision mediump float; uniform vec4 uTint; uniform float uAlpha; varying vec3 vC;' +
      'void main(){ gl_FragColor = vec4(mix(vC, uTint.rgb, uTint.a), uAlpha); }');
  } catch (err) { fail('The 3D viewer could not start: ' + err.message); return; }
  var L = { pos: gl.getAttribLocation(lit, 'aPos'), nor: gl.getAttribLocation(lit, 'aNor'), vp: gl.getUniformLocation(lit, 'uVP'),
            m: gl.getUniformLocation(lit, 'uM'), color: gl.getUniformLocation(lit, 'uColor'), eye: gl.getUniformLocation(lit, 'uEye') };
  var N = { pos: gl.getAttribLocation(line, 'aPos'), col: gl.getAttribLocation(line, 'aCol'), vp: gl.getUniformLocation(line, 'uVP'),
            off: gl.getUniformLocation(line, 'uOff'), tint: gl.getUniformLocation(line, 'uTint'), alpha: gl.getUniformLocation(line, 'uAlpha') };

  function triBuffer(tris) {       // flat list of triangle corners [x,y,z, ...] -> interleaved position + face normal
    var out = new Float32Array(tris.length * 2);
    for (var i = 0; i < tris.length; i += 9) {
      var a = [tris[i], tris[i + 1], tris[i + 2]], b = [tris[i + 3], tris[i + 4], tris[i + 5]], c = [tris[i + 6], tris[i + 7], tris[i + 8]];
      var n = norm(cross(sub(b, a), sub(c, a)));
      for (var k = 0; k < 3; k++) {
        var o = (i / 3 + k) * 6;
        out[o] = tris[i + k * 3]; out[o + 1] = tris[i + k * 3 + 1]; out[o + 2] = tris[i + k * 3 + 2];
        out[o + 3] = n[0]; out[o + 4] = n[1]; out[o + 5] = n[2];
      }
    }
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, out, gl.DYNAMIC_DRAW);
    return { buf: buf, count: tris.length / 3 };
  }
  function lineBuffer(data) {
    var buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.DYNAMIC_DRAW);
    return { buf: buf, count: data.length / 6 };
  }
  // unit cube, unit sphere, the block's mesh
  var cubeTris = [];
  (function () {
    var f = [[[-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1]], [[-1, 1, -1], [1, 1, -1], [1, -1, -1], [-1, -1, -1]],
             [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]], [[-1, -1, 1], [-1, 1, 1], [-1, 1, -1], [-1, -1, -1]],
             [[-1, 1, 1], [1, 1, 1], [1, 1, -1], [-1, 1, -1]], [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]]];
    f.forEach(function (q) { [0, 1, 2, 0, 2, 3].forEach(function (i) { cubeTris.push(q[i][0], q[i][1], q[i][2]); }); });
  })();
  var sphereTris = [];
  (function () {
    var nu = 12, nv = 8;
    function pt(i, j) { var u = 2 * Math.PI * i / nu, v = Math.PI * j / nv; return [Math.sin(v) * Math.cos(u), Math.sin(v) * Math.sin(u), Math.cos(v)]; }
    for (var j = 0; j < nv; j++) for (var i = 0; i < nu; i++) {
      var a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), d = pt(i, j + 1);
      [a, d, c, a, c, b].forEach(function (p) { sphereTris.push(p[0], p[1], p[2]); });
    }
  })();
  var G = { cube: triBuffer(cubeTris), sphere: triBuffer(sphereTris), palm: triBuffer(new Array(4 * 9).fill(0)),
            dyn: lineBuffer(new Array(6 * 64).fill(0)), grid: null };

  // ---------------------------------------------------------------- theme
  var dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  var C = dark ? { bg: [0.105, 0.105, 0.1], table: [0.33, 0.3, 0.27], grid: [0.5, 0.48, 0.45], actObj: [0.92, 0.92, 0.9], actPalm: [0.62, 0.62, 0.6], hand: [0.75, 0.75, 0.73], mark: [0.95, 0.95, 0.93] }
               : { bg: [0.955, 0.953, 0.945], table: [0.86, 0.81, 0.74], grid: [0.62, 0.58, 0.52], actObj: [0.1, 0.1, 0.1], actPalm: [0.5, 0.5, 0.48], hand: [0.17, 0.17, 0.18], mark: [0.08, 0.08, 0.08] };
  var BLOCK = [0.37, 0.77, 0.81], GHOST = hex(D.ghost), LOST = hex(D.lost), POSTER = [0.25, 0.27, 0.55], CURL = [0.36, 0.4, 0.72], BOOK = [0.42, 0.29, 0.21];
  var phaseRGB = D.phases.map(function (p) { return hex(p.color); });

  // ---------------------------------------------------------------- per-run data
  function prepare(run) {
    var n = run.ticks, kind = new Uint8Array(n), seg = new Uint16Array(n);
    run.segments.forEach(function (s, i) { for (var t = s.t0; t <= s.t1; t++) { kind[t] = s.k; seg[t] = i; } });
    run.kind = kind; run.seg = seg;
    function pos(arr, i, scale) { return [arr[i * 7] / scale, arr[i * 7 + 1] / scale, arr[i * 7 + 2] / scale]; }
    function path(arr, count, first, coloured) {
      var d = [];
      for (var i = 0; i < count; i++) {
        var p = pos(arr, i, 1e4), c = coloured ? phaseRGB[kind[first + i]] : [0.5, 0.5, 0.5];
        d.push(p[0], p[1], p[2], c[0], c[1], c[2]);
      }
      return lineBuffer(d);
    }
    var meshTris = [];
    for (var fi = 0; fi < run.mesh.f.length; fi++) { var vi = run.mesh.f[fi] * 3; meshTris.push(run.mesh.v[vi], run.mesh.v[vi + 1], run.mesh.v[vi + 2]); }
    run.meshBuf = triBuffer(meshTris);
    var tb = run.context.table, gd = [];
    if (tb) {                      // the table's grid, 5 cm
      var gz = tb.c[2] + tb.h[2] + 0.0006, g = C.grid, step = 0.05;
      for (var x = tb.c[0] - tb.h[0]; x <= tb.c[0] + tb.h[0] + 1e-6; x += step) gd.push(x, tb.c[1] - tb.h[1], gz, g[0], g[1], g[2], x, tb.c[1] + tb.h[1], gz, g[0], g[1], g[2]);
      for (var y = tb.c[1] - tb.h[1]; y <= tb.c[1] + tb.h[1] + 1e-6; y += step) gd.push(tb.c[0] - tb.h[0], y, gz, g[0], g[1], g[2], tb.c[0] + tb.h[0], y, gz, g[0], g[1], g[2]);
    }
    run.grid = lineBuffer(gd.length ? gd : [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    run.buf = { wc: path(run.wc, n, 0, true), oc: path(run.oc, run.open - run.attach, run.attach, true),
                oa: path(run.oa, n, 0, false), pa: path(run.pa, n, 0, false) };
  }
  D.runs.forEach(prepare);
  function pose(arr, i) {
    return { p: [arr[i * 7] / 1e4, arr[i * 7 + 1] / 1e4, arr[i * 7 + 2] / 1e4],
             R: rotOfQuat([arr[i * 7 + 3], arr[i * 7 + 4], arr[i * 7 + 5], arr[i * 7 + 6]]) };
  }

  // ---------------------------------------------------------------- state
  var HOME = { target: [-0.37, -0.31, 0.99], az: 32 * Math.PI / 180, el: 30 * Math.PI / 180, dist: 0.82 };
  var cam = JSON.parse(JSON.stringify(HOME));
  var S = { run: 0, tick: 0, playing: false, speed: 1, layers: {} };
  var dirty = true, VP = ident(), eye = [0, 0, 0], viewW = 1, viewH = 1;
  var slider = $('.vslider'), readout = $('.vread'), strip = $('.vstrip'), labels = $('.vlabels'), playBtn = $('.vplay');
  var labelEls = [];

  function run() { return D.runs[S.run]; }
  function setTick(t, fromSlider) {
    var r = run();
    S.tick = Math.max(0, Math.min(r.ticks - 1, Math.round(t)));
    if (!fromSlider) slider.value = S.tick;
    updateReadout(); updateHash(); dirty = true;
  }
  function setRun(i, tick) {
    S.run = Math.max(0, Math.min(D.runs.length - 1, i));
    var r = run();
    slider.max = r.ticks - 1;
    Array.prototype.forEach.call(root.querySelectorAll('.vrun'), function (b, k) { b.classList.toggle('on', k === S.run); });
    var o0 = [r.oa[0] / 1e4, r.oa[1] / 1e4, r.oa[2] / 1e4], far = Math.hypot(cam.target[0] - o0[0], cam.target[1] - o0[1]);
    if (far > 0.45) cam.target = [o0[0], o0[1], o0[2] + 0.06];      // another scene: look at this run's block
    buildStrip(); buildLegend(); buildLabels();
    setTick(tick === undefined ? Math.min(S.tick, r.ticks - 1) : tick);
  }
  var hashTimer = null;
  var live = false;                // the address is only rewritten once the viewer has been used or was opened with a state
  function updateHash() {
    if (hashTimer || !live) return;
    hashTimer = setTimeout(function () {
      hashTimer = null;
      try { history.replaceState(null, '', '#run=' + (S.run + 1) + '&tick=' + S.tick); } catch (e) { /* file:// in some browsers */ }
    }, 120);
  }
  function readHash() {
    var h = window.location.hash || '', r = /run=(\d+)/.exec(h), t = /tick=(\d+)/.exec(h);
    if (!r && !t) return false;
    var az = /az=(-?[\d.]+)/.exec(h), el = /el=(-?[\d.]+)/.exec(h), dd = /d=([\d.]+)/.exec(h);      // optional: the camera, in degrees and metres
    if (az) cam.az = parseFloat(az[1]) * Math.PI / 180;
    if (el) cam.el = Math.max(-1.5, Math.min(1.5, parseFloat(el[1]) * Math.PI / 180));
    if (dd) cam.dist = Math.max(0.12, Math.min(5, parseFloat(dd[1])));
    setRun(r ? parseInt(r[1], 10) - 1 : S.run, t ? parseInt(t[1], 10) : 0);
    live = true;
    return true;
  }

  // ---------------------------------------------------------------- the page parts around the canvas
  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function buildStrip() {
    var r = run(), html = '';
    r.segments.forEach(function (s) {
      html += '<button type="button" class="vseg" data-tick="' + s.t0 + '" style="flex:' + (s.t1 - s.t0 + 1) + ' 0 0;background:' + D.phases[s.k].color +
              '" title="' + esc(s.skill + ': ' + D.phases[s.k].label + ', ticks ' + s.t0 + ' to ' + s.t1) + '"></button>';
    });
    r.events.forEach(function (e) {
      html += '<span class="vev' + (e.lost ? ' lost' : '') + '" style="left:' + (100 * e.tick / (r.ticks - 1)) + '%" title="' + esc(e.label + ', tick ' + e.tick) + '"></span>';
    });
    strip.innerHTML = html;
  }
  function buildLegend() {
    var r = run(), box = $('.vphases'), seen = {}, html = '<span class="vlt">jump to a phase:</span>', skills = [], sk = {};
    r.segments.forEach(function (s) {
      if (!seen[s.k]) { seen[s.k] = { t0: s.t0, skills: [] }; }
      if (seen[s.k].skills.indexOf(s.skill) < 0) seen[s.k].skills.push(s.skill);
      if (sk[s.skill] === undefined) { sk[s.skill] = s.t0; skills.push(s.skill); }
    });
    D.phases.forEach(function (p, k) {
      if (!seen[k]) return;
      html += '<button type="button" class="vjump" data-tick="' + seen[k].t0 + '"><span class="sw" style="background:' + p.color + '"></span>' +
              esc(p.label) + ' <span class="na">(' + esc(seen[k].skills.join(', ')) + ')</span></button>';
    });
    html += '<span class="vlt">jump to a skill call:</span>';
    skills.forEach(function (name) { html += '<button type="button" class="vjump" data-tick="' + sk[name] + '">' + esc(name) + '</button>'; });
    html += '<span class="vlt">jump to an event:</span>';
    r.events.forEach(function (e) { html += '<button type="button" class="vjump" data-tick="' + e.tick + '">' + esc(e.label) + ' (' + e.tick + ')</button>'; });
    box.innerHTML = html;
  }
  function buildLabels() {
    labels.innerHTML = ''; labelEls = [];
    var r = run();
    r.events.forEach(function (e) {
      var arr = e.on === 'object' ? r.oa : r.wc, el = document.createElement('span');
      el.className = 'vlabel' + (e.lost ? ' lost' : ''); el.textContent = e.label + ' (tick ' + e.tick + ')';
      labels.appendChild(el);
      labelEls.push({ el: el, p: [arr[e.tick * 7] / 1e4, arr[e.tick * 7 + 1] / 1e4, arr[e.tick * 7 + 2] / 1e4], lost: !!e.lost });
    });
    if (r.aim) {
      var a = document.createElement('span'); a.className = 'vlabel aim'; a.textContent = r.aim_label || 'aim';
      labels.appendChild(a); labelEls.push({ el: a, p: r.aim, aim: true });
    }
  }
  function updateReadout() {
    var r = run(), t = S.tick, s = r.segments[r.seg[t]], p = D.phases[s.k], extra = '';
    if (t >= r.attach && t < r.open) {
      var j = t - r.attach, dx = r.oc[j * 7] - r.oa[t * 7], dy = r.oc[j * 7 + 1] - r.oa[t * 7 + 1], dz = r.oc[j * 7 + 2] - r.oa[t * 7 + 2];
      extra = ' &nbsp;·&nbsp; ghost to block: <b>' + (Math.sqrt(dx * dx + dy * dy + dz * dz) / 10).toFixed(0) + ' mm</b>';
    } else if (t >= r.open) {
      var k = r.open - r.attach - 1, ex = r.oc[k * 7] - r.oa[t * 7], ey = r.oc[k * 7 + 1] - r.oa[t * 7 + 1], ez = r.oc[k * 7 + 2] - r.oa[t * 7 + 2];
      extra = ' &nbsp;·&nbsp; block to where the reference let go: <b>' + (Math.sqrt(ex * ex + ey * ey + ez * ez) / 10).toFixed(0) + ' mm</b>';
    }
    readout.innerHTML = '<div class="vr1"><b>tick ' + t + '</b> of ' + (r.ticks - 1) + ' &nbsp;·&nbsp; ' + (t * D.dt).toFixed(2) + ' s &nbsp;·&nbsp; skill <b>' +
      esc(s.skill) + '</b> &nbsp;·&nbsp; <span class="vchip" style="background:' + p.color + '"></span><b>' + esc(p.label) + '</b> (ticks ' + s.t0 + ' to ' + s.t1 + ')' + extra +
      '</div><div class="vr2">S0 was asked: ' + esc(s.asked) + '</div><div class="vr2' + (s.state === 'lost' ? ' bad' : '') + '">outcome: ' + esc(s.outcome) + '</div>';
  }

  // ---------------------------------------------------------------- drawing
  function resize() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2), w = Math.max(canvas.clientWidth, 50), h = Math.max(canvas.clientHeight, 50);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    viewW = w; viewH = h;
  }
  function useLit() {
    gl.useProgram(lit); gl.uniformMatrix4fv(L.vp, false, VP); gl.uniform3fv(L.eye, eye);
    gl.enableVertexAttribArray(L.pos); gl.enableVertexAttribArray(L.nor);
  }
  function drawTris(g, M, rgb, alpha) {
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
    gl.vertexAttribPointer(L.pos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(L.nor, 3, gl.FLOAT, false, 24, 12);
    gl.uniformMatrix4fv(L.m, false, M); gl.uniform4f(L.color, rgb[0], rgb[1], rgb[2], alpha === undefined ? 1 : alpha);
    gl.drawArrays(gl.TRIANGLES, 0, g.count);
  }
  function box(c, h, R, rgb) { drawTris(G.cube, matOf(R || [[1, 0, 0], [0, 1, 0], [0, 0, 1]], c, h), rgb); }
  function ball(p, radius, rgb) { drawTris(G.sphere, matOf([[1, 0, 0], [0, 1, 0], [0, 0, 1]], p, [radius, radius, radius]), rgb); }
  function useLine() {
    gl.useProgram(line); gl.uniformMatrix4fv(N.vp, false, VP);
    gl.enableVertexAttribArray(N.pos); gl.enableVertexAttribArray(N.col);
  }
  var OFFS = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]];
  function drawLine(g, mode, first, count, width, alpha, tint) {
    if (count < 2) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, g.buf);
    gl.vertexAttribPointer(N.pos, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(N.col, 3, gl.FLOAT, false, 24, 12);
    gl.uniform1f(N.alpha, alpha);
    if (tint) gl.uniform4f(N.tint, tint[0], tint[1], tint[2], 1); else gl.uniform4f(N.tint, 0, 0, 0, 0);
    var passes = width > 1 ? 5 : 1, px = 2 * (canvas.width / viewW) / canvas.width * (width > 2 ? 1.0 : 0.6), py = px * canvas.width / canvas.height;
    for (var k = 0; k < passes; k++) { gl.uniform2f(N.off, OFFS[k][0] * px, OFFS[k][1] * py); gl.drawArrays(mode, first, count); }
  }
  function on(name) { var el = root.querySelector('input[data-layer="' + name + '"]'); return !el || el.checked; }
  function axesInto(d, P, len, shade) {
    var cols = [[0.9, 0.15, 0.15], [0.1, 0.65, 0.15], [0.15, 0.35, 0.95]];
    for (var a = 0; a < 3; a++) {
      var tip = [P.p[0] + P.R[0][a] * len, P.p[1] + P.R[1][a] * len, P.p[2] + P.R[2][a] * len], c = cols[a];
      d.push(P.p[0], P.p[1], P.p[2], c[0] * shade, c[1] * shade, c[2] * shade, tip[0], tip[1], tip[2], c[0] * shade, c[1] * shade, c[2] * shade);
    }
  }
  function draw() {
    resize();
    var r = run(), t = S.tick, ctx = r.context;
    eye = [cam.target[0] + cam.dist * Math.cos(cam.el) * Math.cos(cam.az), cam.target[1] + cam.dist * Math.cos(cam.el) * Math.sin(cam.az),
           cam.target[2] + cam.dist * Math.sin(cam.el)];
    VP = mul(perspective(40 * Math.PI / 180, canvas.width / canvas.height, 0.02, 30), lookAt(eye, cam.target, [0, 0, 1]));
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(C.bg[0], C.bg[1], C.bg[2], 1); gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST); gl.depthMask(true); gl.disable(gl.BLEND);

    var objA = pose(r.oa, t), palmA = pose(r.pa, t), wristC = pose(r.wc, t);
    useLit();
    if (on('context')) {
      var top = ctx.table ? ctx.table.c[2] + ctx.table.h[2] : 0;
      if (ctx.table) box(ctx.table.c, ctx.table.h, null, C.table);
      if (ctx.poster) box([ctx.poster.c[0], ctx.poster.c[1], top + 0.0008], [ctx.poster.h[0], ctx.poster.h[1], 0.0008], null, POSTER);
      if (ctx.book) box(ctx.book.c, ctx.book.h, rotZ(ctx.book.yaw), BOOK);
      for (var i = 0; ctx.curl && r.curl && i < ctx.curl.n; i++) {
        var o = (t * ctx.curl.n + i) * 3, R = rotX(r.curl[o + 2] / 1e4), p = [ctx.curl.x, r.curl[o] / 1e4, r.curl[o + 1] / 1e4];
        box(apply(R, p, ctx.curl.off), ctx.curl.h, R, CURL);
      }
      if (r.aim) ball(r.aim, 0.006, [1, 1, 1]);
    }
    drawTris(r.meshBuf, matOf(objA.R, objA.p), BLOCK);
    var hand = [];
    if (on('hand')) {
      var kn = r.knuckles.map(function (k) { return apply(palmA.R, palmA.p, k); }), tris = [];
      for (var f = 0; f < 4; f++) tris.push(palmA.p[0], palmA.p[1], palmA.p[2], kn[f][0], kn[f][1], kn[f][2], kn[f + 1][0], kn[f + 1][1], kn[f + 1][2]);
      gl.deleteBuffer(G.palm.buf); G.palm = triBuffer(tris);
      drawTris(G.palm, ident(), C.hand);
      for (var q = 0; q < 5; q++) {
        var mid = [r.mid[(t * 5 + q) * 3] / 1e3, r.mid[(t * 5 + q) * 3 + 1] / 1e3, r.mid[(t * 5 + q) * 3 + 2] / 1e3];
        var tip = [r.tip[(t * 5 + q) * 3] / 1e3, r.tip[(t * 5 + q) * 3 + 1] / 1e3, r.tip[(t * 5 + q) * 3 + 2] / 1e3];
        ball(tip, 0.0075, C.hand); ball(mid, 0.006, C.hand); ball(kn[q], 0.006, C.hand);
        hand.push(kn[q][0], kn[q][1], kn[q][2], C.hand[0], C.hand[1], C.hand[2], mid[0], mid[1], mid[2], C.hand[0], C.hand[1], C.hand[2],
                  mid[0], mid[1], mid[2], C.hand[0], C.hand[1], C.hand[2], tip[0], tip[1], tip[2], C.hand[0], C.hand[1], C.hand[2]);
      }
    }
    if (on('labels')) {
      labelEls.forEach(function (l) { if (!l.aim) ball(l.p, 0.0065, l.lost ? LOST : C.mark); });
    }

    useLine();
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (on('context')) drawLine(r.grid, gl.LINES, 0, r.grid.count, 1, 0.35);
    if (on('palm_act')) { drawLine(r.buf.pa, gl.LINE_STRIP, t, r.ticks - t, 1, 0.3, C.actPalm); drawLine(r.buf.pa, gl.LINE_STRIP, 0, t + 1, 1, 1, C.actPalm); }
    if (on('obj_act')) { drawLine(r.buf.oa, gl.LINE_STRIP, t, r.ticks - t, 1, 0.3, C.actObj); drawLine(r.buf.oa, gl.LINE_STRIP, 0, t + 1, 2, 1, C.actObj); }
    if (on('wrist_cmd')) { drawLine(r.buf.wc, gl.LINE_STRIP, t, r.ticks - t, 1, 0.38); drawLine(r.buf.wc, gl.LINE_STRIP, 0, t + 1, 3, 1); }
    if (on('obj_cmd')) {          // dashed: every other piece of the commanded object path
      var nOc = r.open - r.attach, done = Math.max(0, Math.min(nOc, t - r.attach + 1)); done -= done % 2;
      drawLine(r.buf.oc, gl.LINES, done, nOc - done - ((nOc - done) % 2), 1, 0.45);
      drawLine(r.buf.oc, gl.LINES, 0, done, 3, 1);
    }
    var d = [];
    axesInto(d, wristC, 0.075, 1.0);
    var nStrong = d.length / 6;
    if (on('hand')) { axesInto(d, palmA, 0.04, 0.55); d = d.concat(hand); }
    gl.deleteBuffer(G.dyn.buf); G.dyn = lineBuffer(d);
    drawLine(G.dyn, gl.LINES, 0, nStrong, 3, 1);
    if (on('hand')) {
      drawLine(G.dyn, gl.LINES, nStrong, 6, 1, 1);
      drawLine(G.dyn, gl.LINES, nStrong + 6, G.dyn.count - nStrong - 6, 3, 1);
    }

    if (on('ghost') && t >= r.attach) {      // the ghost: commanded pose from the attach on; after the command to open it stays where the reference let go
      var gp = pose(r.oc, Math.min(t, r.open - 1) - r.attach);
      useLit(); gl.depthMask(false);
      drawTris(r.meshBuf, matOf(gp.R, gp.p), GHOST, t < r.open ? 0.5 : 0.28);
      gl.depthMask(true);
    }
    gl.disable(gl.BLEND);

    var show = on('labels');
    labelEls.forEach(function (l) {
      var x = VP[0] * l.p[0] + VP[4] * l.p[1] + VP[8] * l.p[2] + VP[12], y = VP[1] * l.p[0] + VP[5] * l.p[1] + VP[9] * l.p[2] + VP[13],
          w = VP[3] * l.p[0] + VP[7] * l.p[1] + VP[11] * l.p[2] + VP[15];
      if (!show || w <= 0) { l.el.style.display = 'none'; return; }
      l.el.style.display = 'block';
      l.el.style.transform = 'translate(' + ((x / w * 0.5 + 0.5) * viewW + 9).toFixed(1) + 'px,' + ((0.5 - y / w * 0.5) * viewH + (l.aim ? 8 : -9)).toFixed(1) + 'px)';
    });
  }

  // ---------------------------------------------------------------- the loop, play
  var last = 0, carry = 0;
  function frame(now) {
    if (S.playing) {
      carry += (now - last) / 1000 / D.dt * S.speed;
      var step = Math.floor(carry);
      if (step > 0) {
        carry -= step;
        if (S.tick + step >= run().ticks - 1) { setTick(run().ticks - 1); setPlaying(false); } else setTick(S.tick + step);
      }
    }
    last = now;
    if (dirty) { dirty = false; draw(); root.setAttribute('data-drawn', S.run + 1 + ':' + S.tick); }
    window.requestAnimationFrame(frame);
  }
  function setPlaying(p) {
    S.playing = p; carry = 0; playBtn.textContent = p ? 'pause' : 'play';
    if (p && S.tick >= run().ticks - 1) setTick(0);
  }

  // ---------------------------------------------------------------- controls
  slider.addEventListener('input', function () { setTick(parseInt(slider.value, 10), true); });
  playBtn.addEventListener('click', function () { setPlaying(!S.playing); });
  $('.vspeed').addEventListener('change', function (e) { S.speed = parseFloat(e.target.value); });
  $('.vreset').addEventListener('click', function () { cam = JSON.parse(JSON.stringify(HOME)); dirty = true; });
  Array.prototype.forEach.call(root.querySelectorAll('.vrun'), function (b, k) { b.addEventListener('click', function () { setRun(k); }); });
  Array.prototype.forEach.call(root.querySelectorAll('input[data-layer]'), function (c) { c.addEventListener('change', function () { dirty = true; }); });
  root.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-tick]') : null;
    if (b) { setPlaying(false); setTick(parseInt(b.getAttribute('data-tick'), 10)); }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    var a = document.activeElement;
    if (a === slider) return;                                             // the slider steps by itself
    if (a && a !== document.body && !root.contains(a)) return;            // a film or another control has the keys
    if (a && /^(SELECT|TEXTAREA)$/.test(a.tagName)) return;
    e.preventDefault(); setPlaying(false);
    setTick(S.tick + (e.key === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 10 : 1));
  });
  window.addEventListener('hashchange', readHash);
  window.addEventListener('resize', function () { dirty = true; });

  var pointers = {}, pinch = 0;
  function panBy(dx, dy) {
    var f = norm(sub(cam.target, eye)), right = norm(cross(f, [0, 0, 1])), up = cross(right, f), k = cam.dist * 0.0016;
    for (var i = 0; i < 3; i++) cam.target[i] += (-dx * right[i] + dy * up[i]) * k;
  }
  canvas.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  canvas.addEventListener('pointerdown', function (e) {
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* a synthetic pointer */ }
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey };
    pinch = 0; e.preventDefault();
  });
  canvas.addEventListener('pointermove', function (e) {
    var p = pointers[e.pointerId]; if (!p) return;
    var dx = e.clientX - p.x, dy = e.clientY - p.y, ids = Object.keys(pointers);
    p.x = e.clientX; p.y = e.clientY;
    if (ids.length >= 2) {                                               // two fingers: pinch to zoom, move to pan
      var a = pointers[ids[0]], b = pointers[ids[1]], dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch > 0 && dist > 0) cam.dist = Math.max(0.12, Math.min(5, cam.dist * pinch / dist));
      pinch = dist; panBy(dx * 0.5, dy * 0.5);
    } else if (p.pan || e.shiftKey) panBy(dx, dy);
    else { cam.az -= dx * 0.006; cam.el = Math.max(-1.5, Math.min(1.5, cam.el + dy * 0.006)); }
    dirty = true;
  });
  function release(e) { delete pointers[e.pointerId]; pinch = 0; }
  canvas.addEventListener('pointerup', release); canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('wheel', function (e) {
    e.preventDefault(); cam.dist = Math.max(0.12, Math.min(5, cam.dist * Math.exp(e.deltaY * 0.0012))); dirty = true;
  }, { passive: false });

  // ---------------------------------------------------------------- start
  S.speed = parseFloat($('.vspeed').value) || 1;
  if (!readHash()) { S.tick = D.runs[0].attach; setRun(0, D.runs[0].attach); }
  else if (root.scrollIntoView && !/noscroll=1/.test(window.location.hash)) root.scrollIntoView();       // opened with a linked view: show the viewer
  root.addEventListener('pointerdown', function () { live = true; }, true);
  root.addEventListener('keydown', function () { live = true; }, true);
  if (/play=1/.test(window.location.hash)) setPlaying(true);
  if (/selftest=1/.test(window.location.hash)) {       // developer check: drive every control once with made-up events, write what happened into the page
    var res = {};
    try {
      var az0 = cam.az, d0 = cam.dist, tg0 = cam.target.slice();
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 7, clientX: 100, clientY: 100, button: 0, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 7, clientX: 160, clientY: 120, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7, bubbles: true }));
      res.orbit = cam.az !== az0 && cam.target[0] === tg0[0];
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 200, cancelable: true })); res.zoom = cam.dist > d0;
      canvas.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 8, clientX: 100, clientY: 100, button: 2, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointermove', { pointerId: 8, clientX: 140, clientY: 130, bubbles: true }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { pointerId: 8, bubbles: true }));
      res.pan = cam.target[0] !== tg0[0] || cam.target[1] !== tg0[1];
      $('.vreset').click(); res.reset = cam.dist === HOME.dist && cam.target[0] === HOME.target[0];
      slider.value = 100; slider.dispatchEvent(new Event('input')); res.slider = S.tick === 100;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); res.key_right = S.tick === 101;
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', shiftKey: true })); res.key_shift_left = S.tick === 91;
      var jumps = root.querySelectorAll('.vjump'); jumps[1].click(); res.jump = S.tick === parseInt(jumps[1].getAttribute('data-tick'), 10);
      root.querySelector('.vseg:nth-child(4)').click(); res.strip = S.tick === run().segments[3].t0;
      root.querySelectorAll('.vrun')[1].click(); res.run_switch = S.run === 1 && parseInt(slider.max, 10) === D.runs[1].ticks - 1;
      Array.prototype.forEach.call(root.querySelectorAll('input[data-layer]'), function (c) { c.checked = false; });
      draw(); res.draw_all_layers_off = true;
      Array.prototype.forEach.call(root.querySelectorAll('input[data-layer]'), function (c) { c.checked = true; });
      setTick(D.runs[1].ticks - 1); draw(); setTick(0); draw(); res.draw_first_and_last_tick = true;
      playBtn.click(); res.play = S.playing === true; playBtn.click(); res.pause = S.playing === false;
      res.gl_error = gl.getError();
    } catch (err) { res.error = String(err); }
    root.setAttribute('data-selftest', JSON.stringify(res));
  }
  window.requestAnimationFrame(function (now) { last = now; frame(now); });
})();
