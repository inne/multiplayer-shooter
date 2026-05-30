// blackhole.js — transient WebGL "black hole" gravitational-lens pinch effect.
//
// The game renders in plain Canvas 2D, which can't sample neighbouring pixels,
// so a TRUE screen distortion needs the GPU. This module keeps the 2D game
// untouched: it owns a second, transparent WebGL canvas layered directly on top
// of the game canvas. ONLY while a blast is active does it:
//   1. upload the finished 2D frame as a texture (texImage2D accepts a canvas),
//   2. draw one full-screen quad through a fragment shader that displaces UVs
//      radially toward the blast centre (a pinch), with a dark core, a bright
//      warm accretion ring, and a touch of chromatic aberration,
//   3. show the (opaque) overlay so it covers the 2D canvas for the ~0.5 s blast.
// When the effect ends the overlay is hidden and the untouched 2D canvas shows
// through again. No permanent post-processing stack, no dependency, no build.
//
// Degrades gracefully: if WebGL is unavailable, every method is a safe no-op and
// the game simply shows its normal 2D explosion FX.
//
// Public API:
//   const bh = createBlackHole(gameCanvas);   // builds + attaches the overlay
//   bh.trigger(screenX, screenY, opts?);      // start a blast (canvas px, y-down)
//   bh.update(dtSeconds, gameCanvas);          // call every frame; renders if active
//   bh.active                                  // bool — currently distorting
//
// The caller converts the bomb's WORLD position to canvas pixels via the camera
// (screenX = worldX*cam.scale + cam.offsetX, screenY = worldY*cam.scale + cam.offsetY)
// and passes that in. See main.js for the wiring.

const VERT_SRC = `
attribute vec2 a_pos;
varying vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;     // identity mapping (FLIP_Y handled on upload)
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `
precision highp float;
uniform sampler2D u_tex;
uniform vec2  u_res;        // canvas px
uniform vec2  u_center;     // blast center, px (bottom-left origin to match v_uv)
uniform float u_radius;     // influence radius, px
uniform float u_strength;   // 0..1 eased ramp over the blast
varying vec2 v_uv;

void main() {
  vec2 px    = v_uv * u_res;
  vec2 d     = px - u_center;
  float dist = length(d);
  float t    = clamp(dist / u_radius, 0.0, 1.0);

  // Falloff: strong pull near the core, fading to 0 at the edge. (1-t)^2 lens curve.
  float pull = u_strength * pow(1.0 - t, 2.0);

  // Outward radial direction (from centre to this pixel).
  vec2 dir = dist > 0.0 ? d / dist : vec2(0.0);

  // SWIRL: rotate the sampling direction more strongly toward the centre, so
  // content spirals INWARD — the signature "sucked into a black hole" feel.
  float ang = pull * 2.4;            // radians of twist, peaking at the core
  float cs = cos(ang), sn = sin(ang);
  vec2 sdir = vec2(dir.x * cs - dir.y * sn, dir.x * sn + dir.y * cs);

  // Pinch: displace sampling INWARD along the swirled direction.
  vec2 uv = v_uv - sdir * pull * 0.5;   // 0.5 = max UV displacement fraction

  // Chromatic aberration: sample R/G/B at slightly different displacements.
  float ca = pull * 0.018;
  vec3 col;
  col.r = texture2D(u_tex, uv + sdir * ca).r;
  col.g = texture2D(u_tex, uv            ).g;
  col.b = texture2D(u_tex, uv - sdir * ca).b;

  // Dark event-horizon core + bright warm accretion ring, gated by strength.
  float core = smoothstep(0.26, 0.0, t) * u_strength;             // wide dark centre
  float ring = smoothstep(0.16, 0.10, abs(t - 0.30)) * u_strength;// bright ring
  col *= (1.0 - 0.97 * core);
  col += vec3(1.0, 0.72, 0.40) * ring * 1.1;                      // warm glow

  gl_FragColor = vec4(col, 1.0);
}`;

function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("blackhole shader compile failed: " + log);
  }
  return sh;
}

class BlackHole {
  constructor(gameCanvas) {
    this.active = false;
    this.gl = null;
    this.canvas = null;
    this._game = gameCanvas;

    // Blast envelope state.
    this._age = 0;          // seconds since trigger
    this._duration = 0.5;   // total blast length (s)
    this._cx = 0;           // centre, canvas px (top-left origin)
    this._cy = 0;
    this._radius = 180;     // influence radius, canvas px
    this._peak = 1;         // max strength

    try {
      this._init(gameCanvas);
    } catch (err) {
      // WebGL unavailable / shader failure -> permanent no-op, game still fine.
      if (typeof console !== "undefined") {
        console.warn("[blackhole] disabled (no WebGL):", err && err.message);
      }
      this.gl = null;
    }
  }

  get supported() { return !!this.gl; }

  _init(gameCanvas) {
    if (typeof document === "undefined") throw new Error("no DOM");

    const overlay = document.createElement("canvas");
    // Match the 2D canvas's internal resolution 1:1 so the texture + quad align.
    overlay.width = gameCanvas.width;
    overlay.height = gameCanvas.height;
    overlay.id = "blackhole-overlay";
    // Lay it exactly over the game canvas's displayed box. The game canvas is
    // full-viewport (CSS width/height 100vw/100vh), so mirror that and let it
    // stretch identically. pointer-events:none keeps mouse aim/fire working.
    overlay.style.position = "fixed";
    overlay.style.left = "0";
    overlay.style.top = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.pointerEvents = "none";
    overlay.style.display = "none";
    overlay.style.zIndex = "5";
    // Insert right after the game canvas.
    if (gameCanvas.parentNode) {
      gameCanvas.parentNode.insertBefore(overlay, gameCanvas.nextSibling);
    } else {
      document.body.appendChild(overlay);
    }

    const gl = overlay.getContext("webgl", { premultipliedAlpha: false, alpha: true })
            || overlay.getContext("experimental-webgl");
    if (!gl) throw new Error("webgl context unavailable");

    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VERT_SRC));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FRAG_SRC));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error("link failed: " + gl.getProgramInfoLog(prog));
    }
    gl.useProgram(prog);

    // Full-screen quad (two triangles) in clip space.
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW
    );
    const aPos = gl.getAttribLocation(prog, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

    // One texture, reused every frame (uploaded from the game canvas).
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    // Flip Y on upload so canvas top maps to v_uv.y=1 (GL bottom-up convention).
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);

    gl.viewport(0, 0, overlay.width, overlay.height);
    gl.clearColor(0, 0, 0, 0);

    this.gl = gl;
    this.canvas = overlay;
    this._prog = prog;
    this._tex = tex;
    this._u = {
      tex: gl.getUniformLocation(prog, "u_tex"),
      res: gl.getUniformLocation(prog, "u_res"),
      center: gl.getUniformLocation(prog, "u_center"),
      radius: gl.getUniformLocation(prog, "u_radius"),
      strength: gl.getUniformLocation(prog, "u_strength"),
    };
  }

  // Start a blast centred at (screenX, screenY) in canvas px (top-left origin).
  // opts: { duration, radius, strength }. No-op if WebGL is unavailable.
  trigger(screenX, screenY, opts = {}) {
    if (!this.gl) return;
    this._cx = screenX;
    this._cy = screenY;
    this._duration = opts.duration ?? 0.5;
    this._radius = opts.radius ?? 200;
    this._peak = opts.strength ?? 1.0;
    this._age = 0;
    this.active = true;
  }

  // Advance the envelope and, if active, render the warped frame. Call once per
  // frame AFTER the 2D draw, passing the game canvas as the texture source.
  update(dt, sourceCanvas) {
    if (!this.active || !this.gl) return;
    this._age += dt > 0 ? dt : 0;
    const a = this._age / this._duration; // 0..1
    if (a >= 1) {
      this.active = false;
      if (this.canvas) this.canvas.style.display = "none";
      return;
    }
    // Envelope: punch in fast (first 25%), then ease back out. Peak ~25% through.
    const ramp = a < 0.25 ? (a / 0.25) : (1 - (a - 0.25) / 0.75);
    const strength = this._peak * (ramp * ramp * (3 - 2 * ramp)); // smoothstep ease
    this._render(sourceCanvas || this._game, strength);
  }

  _render(src, strength) {
    const gl = this.gl;
    const w = this.canvas.width;
    const h = this.canvas.height;

    gl.useProgram(this._prog);
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    // Upload the finished 2D frame as the texture (cheap at 960x672).
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);

    gl.uniform1i(this._u.tex, 0);
    gl.uniform2f(this._u.res, w, h);
    // v_uv has a bottom-left origin (clip space), so flip the y of the centre.
    gl.uniform2f(this._u.center, this._cx, h - this._cy);
    gl.uniform1f(this._u.radius, this._radius);
    gl.uniform1f(this._u.strength, strength);

    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    this.canvas.style.display = "block";
  }
}

export function createBlackHole(gameCanvas) {
  return new BlackHole(gameCanvas);
}

export default { createBlackHole, BlackHole };
