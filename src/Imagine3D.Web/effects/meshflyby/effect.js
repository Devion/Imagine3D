// Camera flight through a large library model.
//
// Shares the mesh shaders with meshshowcase; the difference is entirely in the
// camera - here it orbits low and inside the model's bounds rather than framing it
// from outside.

import { createProgram, VERTEX_SHADER, UNIFORM_PREAMBLE } from '../../engine/gl.js';
import { loadMesh, loadCatalog, pickAsset, uploadMesh } from '../../engine/mesh.js';
import { mat4 } from '../../engine/mat4.js';

/** A procedural block city, for when the asset catalogue has not been built. */
function proceduralCity(blocks = 220) {
  const positions = [];

  // Deterministic PRNG so the fallback city is the same every run.
  let s = 12345;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };

  const box = (cx, cz, w, d, h) => {
    const x0 = cx - w, x1 = cx + w, z0 = cz - d, z1 = cz + d, y0 = 0, y1 = h;
    const v = [
      [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
      [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ];
    // Four walls and a roof; the underside is never seen.
    const faces = [
      [0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7],
    ];
    for (const f of faces) {
      positions.push(...v[f[0]], ...v[f[1]], ...v[f[2]]);
      positions.push(...v[f[0]], ...v[f[2]], ...v[f[3]]);
    }
  };

  const grid = Math.ceil(Math.sqrt(blocks));
  for (let i = 0; i < blocks; i++) {
    const gx = (i % grid) - grid / 2;
    const gz = Math.floor(i / grid) - grid / 2;
    // Leave streets: skip a block occasionally.
    if (rnd() < 0.15) continue;
    const h = 0.4 + Math.pow(rnd(), 2.2) * 5.5;
    box(gx * 2.4 + (rnd() - 0.5) * 0.3, gz * 2.4 + (rnd() - 0.5) * 0.3,
        0.5 + rnd() * 0.4, 0.5 + rnd() * 0.4, h);
  }

  const half = (grid / 2) * 2.4;
  return {
    positions: new Float32Array(positions),
    normals: new Float32Array(positions.length),
    min: [-half, 0, -half],
    max: [half, 6, half],
    triangles: positions.length / 9,
  };
}

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

export default class MeshFlyby {
  constructor(gl, manifest) {
    this.gl = gl;
    this.manifest = manifest;
    this.id = manifest.id;
    this.kind = manifest.kind;
    this.ready = false;
  }

  async init(ctx) {
    const gl = this.gl;

    const [vertSrc, fragSrc] = await Promise.all([
      fetch(`shaders/mesh.vert?v=${this.manifest.rev ?? 0}`).then((r) => r.text()),
      fetch(`shaders/mesh.frag?v=${this.manifest.rev ?? 0}`).then((r) => r.text()),
    ]);
    this.prog = createProgram(gl, vertSrc, fragSrc, `effect "${this.id}" mesh`);

    // Sky/ground gradient with a horizon, drawn behind the geometry.
    this.bg = createProgram(gl, VERTEX_SHADER, `${UNIFORM_PREAMBLE}
vec3 palC(float t) {
  t = clamp(t, 0.0, 0.9999);
  float f = t * 4.0; int i = int(floor(f)); float k = smoothstep(0.0, 1.0, fract(f));
  if (i == 0) return mix(uPal0, uPal1, k);
  if (i == 1) return mix(uPal1, uPal2, k);
  if (i == 2) return mix(uPal2, uPal3, k);
  return mix(uPal3, uPal4, k);
}
void main() {
  float h = vUv.y;
  vec3 col = mix(palC(0.55), palC(0.04), smoothstep(0.35, 1.0, h));
  col += palC(0.9) * exp(-abs(h - 0.42) * 22.0) * 0.5;   // horizon glow
  col *= 0.85 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}`, 'flyby background');

    await this.loadModel(ctx);

    this.model = mat4.create();
    this.view = mat4.create();
    this.proj = mat4.create();
    this.nrm = new Float32Array(9);
    this.tmp = mat4.create();
    this.tmp2 = mat4.create();
    this.ready = true;
  }

  async loadModel(ctx) {
    const gl = this.gl;
    try {
      const catalog = await loadCatalog();
      // Prefer the biggest tagged asset - a flyby wants a world, not a prop.
      const wanted = ['city', 'urban', 'structure', 'vast'];
      const big = (catalog ?? []).filter((a) => (a.tags ?? []).some((t) => wanted.includes(t)));
      const asset = pickAsset(big.length ? big : catalog, wanted, ctx?.seed ?? 0);
      if (asset) {
        this.mesh = await loadMesh(gl, `assets/meshes/${asset.file}`);
        this.assetName = asset.name;
        return;
      }
    } catch (err) {
      console.warn(`[${this.id}] falling back to a procedural city:`, err.message);
    }
    this.mesh = uploadMesh(gl, flatNormals(proceduralCity()));
    this.assetName = 'procedural city';
  }

  render(state, params, textures, quad) {
    const gl = this.gl;
    const m = state.mod;
    const pal = state.palette;

    gl.disable(gl.DEPTH_TEST);
    gl.useProgram(this.bg.program);
    const bu = this.bg.uniforms;
    if (bu.uResolution) gl.uniform2f(bu.uResolution, state.width, state.height);
    if (bu.uAspect) gl.uniform1f(bu.uAspect, state.width / state.height);
    if (bu.uBeatPulse) gl.uniform1f(bu.uBeatPulse, m.beatPulse);
    for (let i = 0; i < 5; i++) {
      const loc = bu[`uPal${i}`];
      if (loc) gl.uniform3f(loc, pal[i][0], pal[i][1], pal[i][2]);
    }
    quad.draw();

    if (!this.ready || !this.mesh) return;

    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clear(gl.DEPTH_BUFFER_BIT);

    // Library models come from every possible authoring convention, so back-face
    // culling is off here - a model with inverted winding would otherwise vanish.
    gl.disable(gl.CULL_FACE);

    // Normalise to a unit-ish world so one camera path works for every asset.
    const s = 1 / this.mesh.extent;
    const c = this.mesh.centre;
    mat4.scale(this.tmp, s);
    mat4.translate(this.tmp2, -c[0], -c[1], -c[2]);
    mat4.multiply(this.model, this.tmp, this.tmp2);

    // Camera path in *model-relative* units.
    //
    // After normalising, the asset spans about 1 unit on its largest axis, so a
    // fixed orbit radius sits outside it and the flyby becomes a turntable. The
    // radius and altitude are therefore fractions of the model's own footprint and
    // height, which makes one path work for a city, a station or a terrain.
    const e = this.mesh.extent;
    const footprint = Math.max(
      (this.mesh.max[0] - this.mesh.min[0]) / e,
      (this.mesh.max[2] - this.mesh.min[2]) / e) * 0.5;
    const heightRange = Math.max(1e-3, (this.mesh.max[1] - this.mesh.min[1]) / e);

    const t = m.t * (params.speed ?? 0.1);
    const r = footprint * (params.radius ?? 0.35);

    // Sit just above the tallest geometry: low enough to fly between things.
    const groundY = (this.mesh.min[1] - this.mesh.centre[1]) / e;
    const alt = groundY + heightRange * (params.altitude ?? 0.75);

    const eye = [Math.cos(t) * r, alt, Math.sin(t) * r];
    const ahead = t + 0.7;
    const target = [
      Math.cos(ahead) * r * 0.35,
      groundY + heightRange * 0.35,
      Math.sin(ahead) * r * 0.35,
    ];

    mat4.lookAt(this.view, eye, target, [0, 1, 0]);
    mat4.perspective(this.proj, params.fov ?? 1.0, state.width / state.height, 0.005, 40);
    mat4.normalMatrix(this.nrm, this.model);

    gl.useProgram(this.prog.program);
    const u = this.prog.uniforms;
    if (u.uModel) gl.uniformMatrix4fv(u.uModel, false, this.model);
    if (u.uView) gl.uniformMatrix4fv(u.uView, false, this.view);
    if (u.uProj) gl.uniformMatrix4fv(u.uProj, false, this.proj);
    if (u.uNormalMat) gl.uniformMatrix3fv(u.uNormalMat, false, this.nrm);
    if (u.uEye) gl.uniform3f(u.uEye, eye[0], eye[1], eye[2]);
    if (u.uBeatPulse) gl.uniform1f(u.uBeatPulse, m.beatPulse);
    if (u.uEnergy) gl.uniform1f(u.uEnergy, m.energy);
    if (u.uTime) gl.uniform1f(u.uTime, m.t);
    if (u.uRim) gl.uniform1f(u.uRim, params.rim ?? 0.6);
    if (u.uWire) gl.uniform1f(u.uWire, params.wire ?? 0);
    if (u.uFogNear) gl.uniform1f(u.uFogNear, r * 0.6);
    if (u.uFogFar) gl.uniform1f(u.uFogFar, r * 4.5 + 0.4);
    for (let i = 0; i < 5; i++) {
      const loc = u[`uPal${i}`];
      if (loc) gl.uniform3f(loc, pal[i][0], pal[i][1], pal[i][2]);
    }

    this.mesh.draw();
    gl.disable(gl.DEPTH_TEST);
  }

  dispose() {
    this.gl.deleteProgram(this.prog?.program);
    this.gl.deleteProgram(this.bg?.program);
  }
}
