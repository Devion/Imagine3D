// A swarm of one model from the asset library, flown through.
//
// It used to draw a single copy on a plinth, framed dead centre. That is the
// right shot for a product page and the wrong one for a video: a prop with its
// longest axis normalised to one unit, seen from two units away, occupies a
// small disc in the middle of a 1080p frame and leaves the rest to a background
// gradient. Roughly a fifth of the screen was ever the subject.
//
// Same model, instanced down a corridor. Copies sit on a helix around the view
// axis and the camera flies along it, so one of them is always close enough to
// overrun the frame while the rest recede to a vanishing point. Each has its own
// spin and its own place on the helix, so the formation reads as a flock rather
// than as a repeated sprite.
//
// One draw call per copy rather than hardware instancing: this is a dozen draws
// of a mesh that is already resident, and adding an instanced attribute buffer
// would mean a second vertex shader for the sake of eleven draw calls.
//
// This is a `module` effect rather than a fragment shader because it draws real
// geometry - it needs its own vertex stage, a depth buffer and matrices.

import { createProgram, bindTexture, VERTEX_SHADER, UNIFORM_PREAMBLE } from '../../engine/gl.js';
import { loadMesh, loadCatalog, pickAsset, uploadMesh } from '../../engine/mesh.js';
import { mat4 } from '../../engine/mat4.js';

/** A chunky icosahedron, used when the asset catalogue has not been built yet. */
function fallbackGeometry() {
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ];
  const f = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ];

  const positions = [];
  for (const tri of f) for (const i of tri) positions.push(...v[i]);

  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),   // filled by flat-normal pass
    min: [-t, -t, -t],
    max: [t, t, t],
    triangles: f.length,
  };
}

export default class MeshShowcase {
  constructor(gl, manifest, ctx) {
    this.gl = gl;
    this.manifest = manifest;
    this.id = manifest.id;
    this.kind = manifest.kind;
    this.mesh = null;
    this.ready = false;
  }

  async init(ctx) {
    const gl = this.gl;

    const [vertSrc, fragSrc] = await Promise.all([
      fetch(`shaders/mesh.vert?v=${this.manifest.rev ?? 0}`).then((r) => r.text()),
      fetch(`shaders/mesh.frag?v=${this.manifest.rev ?? 0}`).then((r) => r.text()),
    ]);
    this.prog = createProgram(gl, vertSrc, fragSrc, `effect "${this.id}" mesh`);

    // Fullscreen background pass. It is a corridor rather than a backdrop: the
    // swarm is travelling, and a static radial gradient behind moving geometry
    // reads as a sticker over a photograph.
    this.bg = createProgram(gl, VERTEX_SHADER, `${UNIFORM_PREAMBLE}
uniform float uTravel;
vec3 palC(float t) {
  t = clamp(t, 0.0, 0.9999);
  float f = t * 4.0; int i = int(floor(f)); float k = smoothstep(0.0, 1.0, fract(f));
  if (i == 0) return mix(uPal0, uPal1, k);
  if (i == 1) return mix(uPal1, uPal2, k);
  if (i == 2) return mix(uPal2, uPal3, k);
  return mix(uPal3, uPal4, k);
}
float h12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(uAspect, 1.0);
  float r = max(length(p), 1e-4);
  float a = atan(p.y, p.x);

  vec3 col = mix(palC(0.30), palC(0.01), smoothstep(0.0, 0.9, r));
  col += palC(0.92) * exp(-r * 5.0) * 0.30 * (0.5 + uBeatPulse);

  // Streaks converging on the vanishing point, so the corridor has a direction
  // even where there is no geometry in it.
  float lane = floor(a / 6.28318530718 * 48.0 + 0.5);
  float across = abs(fract(a / 6.28318530718 * 48.0 + 0.5) - 0.5) * r * 2.0;
  float depth = fract(1.0 / r * 0.35 + uTravel * 0.20 + h12(vec2(lane, 3.0)) * 7.0);
  col += palC(0.6 + 0.35 * h12(vec2(lane, 9.0)))
         * exp(-across * 26.0) * (1.0 - depth) * 0.28 * step(0.55, h12(vec2(lane, 1.0)));

  fragColor = vec4(col, 1.0);
}`, 'showcase corridor');

    await this.loadModel(ctx);

    this.model = mat4.create();
    this.view = mat4.create();
    this.proj = mat4.create();
    this.nrm = new Float32Array(9);
    this.tmp = mat4.create();
    this.tmp2 = mat4.create();
    this.base = mat4.create();
    this.ready = true;
  }

  async loadModel(ctx) {
    const gl = this.gl;
    try {
      const catalog = await loadCatalog();

      // A showcase wants a prop, not a world. Without this filter it happily
      // picks a city map and frames it as a postage stamp on an empty plane,
      // because normalising by the largest axis shrinks everything interesting.
      const isProp = (a) => {
        const tags = a.tags ?? [];
        return !tags.includes('vast') && !tags.includes('city');
      };
      const props = (catalog ?? []).filter(isProp);

      const asset = pickAsset(props.length ? props : catalog, this.manifest.tags, ctx?.seed ?? 0);
      if (asset) {
        this.mesh = await loadMesh(gl, `assets/meshes/${asset.file}`);
        this.assetName = asset.name;
        return;
      }
    } catch (err) {
      console.warn(`[${this.id}] falling back to procedural geometry:`, err.message);
    }
    // No catalogue (or a broken asset): still render something rather than fail.
    this.mesh = uploadMesh(gl, flatNormals(fallbackGeometry()));
    this.assetName = 'procedural';
  }

  render(state, params, textures, quad) {
    const gl = this.gl;
    const m = state.mod;
    const pal = state.palette;

    const count = Math.max(1, Math.min(24, Math.round(params.count ?? 12)));
    const pitch = Math.max(0.4, params.pitch ?? 2.2);
    const travel = m.t * (params.flow ?? 1.2);

    // ---- background ----
    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.bg.program);
    const bu = this.bg.uniforms;
    if (bu.uResolution) gl.uniform2f(bu.uResolution, state.width, state.height);
    if (bu.uAspect) gl.uniform1f(bu.uAspect, state.width / state.height);
    if (bu.uBeatPulse) gl.uniform1f(bu.uBeatPulse, m.beatPulse);
    if (bu.uTime) gl.uniform1f(bu.uTime, m.t);
    if (bu.uTravel) gl.uniform1f(bu.uTravel, travel);
    for (let i = 0; i < 5; i++) {
      const loc = bu[`uPal${i}`];
      if (loc) gl.uniform3f(loc, pal[i][0], pal[i][1], pal[i][2]);
    }
    quad.draw();

    if (!this.ready || !this.mesh) return;

    // ---- the swarm ----
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.DEPTH_BUFFER_BIT);
    // No culling: see the note in shaders/mesh.frag about inconsistent winding.
    gl.disable(gl.CULL_FACE);

    // Normalise the model to unit size and centre it, whatever scale it was
    // authored at - library assets range from centimetres to city blocks.
    //
    // Framing uses the *core* bounds rather than the bounding box, so a studio
    // backdrop or ground plane packaged with the model does not push the subject
    // into the distance. See coreBounds() in engine/mesh.js.
    const s = 1 / this.mesh.coreExtent;
    const c = this.mesh.coreCentre;
    mat4.scale(this.tmp, s);
    mat4.translate(this.tmp2, -c[0], -c[1], -c[2]);
    mat4.multiply(this.base, this.tmp, this.tmp2);

    // The camera sits still and the swarm comes to it, which keeps the fog
    // distances - and so the whole depth read - fixed in screen terms rather
    // than sliding as the scene runs.
    const eye = [Math.sin(m.t * 0.11) * 0.30, Math.sin(m.t * 0.08) * 0.22, 0];
    mat4.lookAt(this.view, eye,
      [eye[0] + Math.sin(m.t * 0.06) * 0.2, eye[1] * 0.5, eye[2] + 1], [0, 1, 0]);
    mat4.perspective(this.proj, 0.95, state.width / state.height, 0.05, 120);

    const far = count * pitch;
    const radius = Math.max(0, params.radius ?? 1.5);
    const spin = params.spin ?? 0.4;
    const tilt = params.tilt ?? 0.25;

    gl.useProgram(this.prog.program);
    const u = this.prog.uniforms;
    if (u.uView) gl.uniformMatrix4fv(u.uView, false, this.view);
    if (u.uProj) gl.uniformMatrix4fv(u.uProj, false, this.proj);
    if (u.uEye) gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
    if (u.uBeatPulse) gl.uniform1f(u.uBeatPulse, m.beatPulse);
    if (u.uEnergy) gl.uniform1f(u.uEnergy, m.energy);
    if (u.uTime) gl.uniform1f(u.uTime, m.t);
    if (u.uRim) gl.uniform1f(u.uRim, params.rim ?? 1);
    if (u.uWire) gl.uniform1f(u.uWire, params.wire ?? 0);
    // Fog spans the whole corridor, so a copy fades out at the far end instead
    // of being clipped away by the near plane the moment it is born.
    if (u.uFogNear) gl.uniform1f(u.uFogNear, far * 0.30);
    if (u.uFogFar) gl.uniform1f(u.uFogFar, far * 0.98);
    for (let i = 0; i < 5; i++) {
      const loc = u[`uPal${i}`];
      if (loc) gl.uniform3f(loc, pal[i][0], pal[i][1], pal[i][2]);
    }

    // Golden-angle spacing round the helix: any rational fraction of a turn puts
    // the copies into visible spokes, and this is the one that never repeats.
    const GOLDEN = Math.PI * (3 - Math.sqrt(5));
    const wrap = ((travel % pitch) + pitch) % pitch;

    for (let i = 0; i < count; i++) {
      // Depth recycles, so a copy is never seen being born: it appears at the
      // far end of the fog, where it is already invisible.
      const z = 0.9 + i * pitch - wrap;
      const idx = i + Math.floor(travel / pitch);

      const a = idx * GOLDEN + m.t * (params.swirl ?? 0.25);
      const rr = radius * (0.55 + 0.75 * fract01(idx * 0.7548776662));
      const px = Math.cos(a) * rr;
      const py = Math.sin(a) * rr * 0.7;

      mat4.rotateY(this.tmp, m.t * spin * (0.6 + 0.9 * fract01(idx * 0.3247179572)) + idx);
      mat4.multiply(this.model, this.tmp, this.base);

      mat4.rotateX(this.tmp, tilt + Math.sin(m.t * 0.3 + idx) * 0.35);
      mat4.multiply(this.model, this.tmp, this.model);

      mat4.translate(this.tmp, px, py, z);
      mat4.multiply(this.model, this.tmp, this.model);

      mat4.normalMatrix(this.nrm, this.model);
      if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, this.model);
      if (u.uNormalMat) gl.uniformMatrix3fv(u.uNormalMat, false, this.nrm);

      // Subject only: any studio backdrop shipped with the model is left out.
      this.mesh.drawSubject();
    }

    gl.disable(gl.DEPTH_TEST);
  }

  dispose() {
    this.gl.deleteProgram(this.prog?.program);
    this.gl.deleteProgram(this.bg?.program);
    // Meshes are shared through the module-level cache, so they are not freed here.
  }
}

/** Deterministic 0..1 from an integer index — the per-copy variation source. */
function fract01(x) {
  const v = Math.sin(x * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

/** Compute flat normals for geometry that has none. */
function flatNormals(data) {
  const p = data.positions;
  const n = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i + 3] - p[i], ay = p[i + 4] - p[i + 1], az = p[i + 5] - p[i + 2];
    const bx = p[i + 6] - p[i], by = p[i + 7] - p[i + 1], bz = p[i + 8] - p[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 9; k += 3) { n[i + k] = nx; n[i + k + 1] = ny; n[i + k + 2] = nz; }
  }
  return { ...data, normals: n };
}
