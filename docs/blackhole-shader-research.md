# Black-hole gravitational-lens pinch on bomb detonation — research & recommendation

> Goal: when a bomberman-style bomb detonates in the tank game, warp the screen
> pixels around the blast inward (a "black hole" pinch) with a dark core, bright
> accretion ring, and a touch of chromatic aberration, for ~0.4–0.6 s, centered
> on the bomb's world position, then snap back.

Canvas 2D cannot sample neighbouring pixels, so a *true* spatial distortion
requires either (a) handing the framebuffer to the GPU as a texture, (b) letting
the browser's filter engine warp the canvas element, or (c) faking it on the CPU
/ with redrawn slices.

**Render-loop facts (from `tank-game/js/main.js`):**
`runLoop()` → `draw(ctx, world, cam)` → `requestAnimationFrame`. Camera is
`{scale, offsetX, offsetY}` with
`screenToWorld(px,py) = ((px-offsetX)/scale, (py-offsetY)/scale)`,
so the inverse (to place the effect on the bomb) is
`screenX = worldX*scale + offsetX`, `screenY = worldY*scale + offsetY`.

---

## 1. WebGL post-process overlay (copy the 2D canvas into a texture, run a pinch shader)

Keep the existing 2D canvas as-is. Add a second, transparent canvas on top (same
CSS box, `position:absolute; pointer-events:none`) with a WebGL context. Each
frame **during the blast only**:

1. `gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas2d)`
   — WebGL accepts an `HTMLCanvasElement` directly as the pixel source, so you
   upload the finished 2D frame as a texture in one call.
2. Draw a full-screen quad with a fragment shader that displaces UVs radially
   toward the blast centre.
3. The WebGL canvas now shows the warped copy. Hide/clear the 2D canvas while the
   overlay is active, or just let the opaque overlay cover it for ~0.5 s. When
   the effect ends, clear+hide the overlay and the untouched 2D canvas shows
   through again.

**Perf of uploading the canvas each frame.** 960×672 RGBA ≈ 2.6 MB/frame;
`texImage2D(...canvas)` at this size is <1 ms on any GPU from the last decade;
the quad + shader is trivial. 60 fps is not in question for a half-second
one-shot. Create the GL context and compile the shader **once at startup**, not
on detonation.

**Sketch GLSL (radial pinch + dark core + ring + chromatic offset):**

```glsl
precision highp float;
uniform sampler2D u_tex;
uniform vec2  u_res;        // canvas px
uniform vec2  u_center;     // blast center, px
uniform float u_radius;     // influence radius, px
uniform float u_strength;   // 0..1 ramp (eased over blast)
varying vec2 v_uv;

void main() {
  vec2 px   = v_uv * u_res;
  vec2 d    = px - u_center;
  float dist= length(d);
  float t   = clamp(dist / u_radius, 0.0, 1.0);

  // Falloff: strong pull near core, fades to 0 at edge. (1-t)^2 is a good lens curve.
  float pull = u_strength * pow(1.0 - t, 2.0);

  // Pinch: pull samples INWARD => screen content sucks toward center.
  vec2 dir = dist > 0.0 ? d / dist : vec2(0.0);
  vec2 uv  = v_uv - dir * pull * 0.35;   // 0.35 = max UV displacement fraction

  // Chromatic aberration: sample R/G/B at slightly different displacements.
  float ca = pull * 0.012;
  vec3 col;
  col.r = texture2D(u_tex, uv + dir*ca).r;
  col.g = texture2D(u_tex, uv         ).g;
  col.b = texture2D(u_tex, uv - dir*ca).b;

  // Dark core + bright accretion ring, both gated by strength.
  float core = smoothstep(0.10, 0.0, t) * u_strength;             // darken center
  float ring = smoothstep(0.16, 0.12, abs(t - 0.14)) * u_strength;// thin bright ring
  col *= (1.0 - 0.95*core);
  col += vec3(1.0, 0.75, 0.45) * ring * 0.8;                      // warm accretion glow

  gl_FragColor = vec4(col, 1.0);
}
```

Same displacement family as the Shadertoy lensing shaders (below): displace UV
along the radial direction by a distance-dependent falloff; chromatic aberration
is just sampling RGB at offset UVs.

**Helpers vs raw WebGL.** For a single full-screen quad + one shader, raw WebGL
is ~60 lines and adds zero dependencies (fits the no-build, ES-modules constraint).
[twgl.js](https://twgljs.org/) collapses the boilerplate and is a single ~30 KB
ES module you can import directly. [regl](https://github.com/regl-project/regl)
is overkill here. → raw WebGL or twgl.js; skip regl.

- **Effort:** Medium (one-time GL setup + shader; per-frame code is tiny).
- **Perf @60fps/960×672:** Excellent. Texture upload <1 ms, fill trivial.
- **Browser support:** Universal (this shader is WebGL1-clean).
- **Bolt-on cleanliness:** Very clean — `draw()` stays untouched; a separate
  module reads the 2D canvas and only activates during the blast. The only option
  giving a *true, controllable* lens with dark core + ring + chromatic aberration
  in one pass.

Refs: [MDN – Using textures in WebGL](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL),
[WebGL2 Fundamentals – Image Processing](https://webgl2fundamentals.org/webgl/lessons/webgl-image-processing.html),
[Opera Dev – WebGL post-processing](https://dev.opera.com/articles/webgl-post-processing/).

---

## 2. SVG filter on the canvas element (`feDisplacementMap` + `feImage` radial map via CSS `filter: url(#blackhole)`)

Possible in principle: `feDisplacementMap` moves each pixel by
`P'(x,y) = P(x + scale*(Xc-0.5), y + scale*(Yc-0.5))`, reading the displacement
from the R/B channels of a map image. A radial pinch needs a map whose channels
encode a radial vector field (a radial gradient built with `feImage` referencing
an inline `data:image/svg+xml`). Apply via `filter: url(#blackhole)` on the
`<canvas>` and animate `scale` to ramp in/out.

**Serious caveats (why it's ranked low):**
- **WebKit/Safari will not render filters whose chain contains `feImage`** — the
  headline radial-map technique is effectively Chromium/Firefox-only.
- **Performance:** SVG filter chains (`feImage` + `feMerge` + `feDisplacementMap`)
  are not reliably GPU-accelerated; per-frame data-URI re-encoding is expensive.
- **Whole-canvas:** applies to the entire element; with the game's camera the
  bomb isn't at canvas centre, so the gradient map must be regenerated/translated
  to the bomb's screen position each blast (more data-URI churn).

- **Effort:** Medium-high. **Perf:** Risky/inconsistent. **Support:** Poor
  (`feImage` variant has no Safari). **Cleanliness:** attaches via one CSS prop,
  but no chromatic aberration, no proper dark core, and the cross-browser story
  kills it.

Refs: [Smashing Magazine – SVG Displacement Filtering](https://www.smashingmagazine.com/2021/09/deep-dive-wonderful-world-svg-displacement-filtering/),
[MDN – feDisplacementMap](https://developer.mozilla.org/en-US/docs/Web/SVG/Reference/Element/feDisplacementMap).

---

## 3. Pure Canvas-2D fakes

**(a) Slice-and-offset rings.** Snapshot the frame to an offscreen, then redraw N
concentric ring slices, each scaled/rotated slightly toward the centre, using
`ctx.drawImage` with clip arcs. A swirl/pinch *illusion* on the accelerated
`drawImage` path — cheap (~10–30 calls/frame). An approximation, but with a dark
core on top it reads convincingly.
- Effort: Medium. Perf: Good. Support: Universal. Cleanliness: Good — pure 2D, drop-in after `draw()`.

**(b) `getImageData`/`putImageData` per-pixel radial remap (true CPU warp).**
Real per-pixel inverse-map on the CPU. But 960×672 = 645k px × per-pixel JS math,
plus `getImageData`/`putImageData` are themselves slow → realistically 30–80
ms/frame, blowing the 16.6 ms budget. Only viable on a small region (e.g.
256×256 around the bomb). Worst perf-per-quality of all options.
- Effort: Medium. Perf: Poor at full canvas. Support: Universal. Cleanliness: janky.

**(c) Cheap non-distortion "black hole" look (no warp at all).** What actually
sells "black hole" and is nearly free: a dark `createRadialGradient` core (opaque
black → transparent), a thin bright warm accretion ring (additive
`globalCompositeOperation='lighter'` stroke), particles/debris spiralling inward
(reuse the existing explosions/smokes systems), a brief desaturate/vignette, plus
the existing screen-shake. No pixel sampling. The eye accepts dark-core +
glowing-ring + inward particles as gravitational collapse even without bending
the background.
- Effort: Low. Perf: Excellent. Support: Universal. Cleanliness: Excellent — additive draws at the end of `draw()`.

Refs: [MDN – getImageData](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/getImageData),
[MDN – putImageData](https://developer.mozilla.org/en-US/docs/Web/API/CanvasRenderingContext2D/putImageData).

---

## 4. References / demos

- Shadertoy gravitational lensing / black hole (GLSL to crib): [3dSyzD](https://www.shadertoy.com/view/3dSyzD), [3fVBDw](https://www.shadertoy.com/view/3fVBDw), [Xt3fWB](https://www.shadertoy.com/view/Xt3fWB), [Wcc3R2](https://www.shadertoy.com/view/Wcc3R2).
- Chromatic aberration screen shader: [Shadertoy llBfzw](https://www.shadertoy.com/view/llBfzw).
- High-quality reference (overkill): [ebruneton black_hole_shader](https://ebruneton.github.io/black_hole_shader/), [Bruno Simon webgl-black-hole](https://deepwiki.com/brunosimon/webgl-black-hole).
- SVG displacement: [Smashing deep-dive](https://www.smashingmagazine.com/2021/09/deep-dive-wonderful-world-svg-displacement-filtering/).
- WebGL canvas-as-texture / post: [MDN textures](https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Using_textures_in_WebGL), [Opera post-processing](https://dev.opera.com/articles/webgl-post-processing/), [twgl.js](https://twgljs.org/).

---

## RANKED RECOMMENDATION

1. **WebGL post-process overlay (approach 1) — best.** Only option giving a true,
   smooth radial lens with dark core + accretion ring + chromatic aberration in
   one cheap pass, at rock-solid 60 fps and universal support, while leaving the
   Canvas-2D game and `draw()` completely untouched. Use raw WebGL (~60 lines) or
   twgl.js. **This is the recommendation.**
2. **Canvas-2D fake look (3c), optionally + slice-rings (3a) — best low-effort
   fallback.** Zero new tech/dependencies; ships today; can't drop frames.
3. **SVG `feDisplacementMap` (approach 2) — not recommended.** No Safari,
   inconsistent perf, no chromatic aberration/proper core.
4. **`getImageData` CPU remap (3b) — avoid** except as a tiny-region last resort.

### Integration sketch for approach 1 (tied to our code)

**One-time setup** (bootstrap in `main.js`, after `const ctx = canvas.getContext("2d")`):
create overlay canvas (`position:absolute`, same box, `pointer-events:none`,
`display:none`); get its `webgl` context, compile the pinch shader, create the
unit quad, allocate one texture. Expose a small `blackhole` module:
`blackhole.trigger(worldX, worldY)` and `blackhole.render(...)`.

**Trigger on detonation** (in `bombs.js` where the explosion spawns):
`blackhole.trigger(bomb.x, bomb.y)`, recording `t0`, `duration = 0.5`.

**Per frame**, at the very end of `runLoop`'s `frame()` (after `draw(ctx, world, cam)`):
```js
if (blackhole.active) {
  const age = (now - blackhole.t0) / blackhole.duration;      // 0..1
  // ramp: punch in fast, ease back out. Peak ~25% through.
  const strength = age < 0.25 ? (age/0.25) : (1 - (age-0.25)/0.75);
  // world -> screen using the camera (inverse of screenToWorld):
  const cx = blackhole.wx * cam.scale + cam.offsetX;
  const cy = blackhole.wy * cam.scale + cam.offsetY;
  blackhole.render(ctx.canvas, cx, cy, 180 /*radius px*/, easeOut(strength));
  overlay.style.display = "block";
  if (age >= 1) { blackhole.active = false; overlay.style.display = "none"; }
}
```
`blackhole.render` uploads `ctx.canvas` via `texImage2D`, sets `u_center=(cx,cy)`,
`u_radius`, `u_strength`, draws the quad. Centre tracks the bomb even with camera
shake (since `cam` carries the live offsets); ramp is the eased `strength`
envelope over the 0.5 s `duration`.

**Key files:** `tank-game/js/main.js` (`draw`, `runLoop`, bootstrap,
`Camera.screenToWorld`) and `tank-game/js/bombs.js` (detonation/explosion spawn —
where to call `blackhole.trigger`).
