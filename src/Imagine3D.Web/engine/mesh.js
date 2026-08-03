// OBJ loading and GPU upload.
//
// The asset pipeline normalises every model in the library - .blend, .fbx, huge
// .obj - down to one decimated, triangulated OBJ with normals, so this parser only
// has to handle that one shape. Meshes are cached per URL because a city is tens
// of megabytes and several scenes may want the same one.

// Keyed by GL context as well as URL: buffers belong to the context that created
// them, and the contact-sheet tool builds a fresh context on every run.
const cache = new WeakMap();

/**
 * Parse a triangulated OBJ into flat interleaved arrays.
 * Handles v/vt/vn, f with any of the v, v/vt, v//vn, v/vt/vn forms, and polygons
 * with more than three vertices (fan-triangulated).
 */
export function parseObj(text) {
  const positions = [];
  const normals = [];
  const outPos = [];
  const outNorm = [];

  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];

  // Split once; per-line regex over a 40 MB file is far too slow.
  const lines = text.split('\n');

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.length < 2) continue;
    const c0 = line.charCodeAt(0);

    // 'v' = 118, 'f' = 102
    if (c0 === 118) {
      const c1 = line.charCodeAt(1);
      if (c1 === 32) {
        const p = line.split(/\s+/);
        const x = +p[1], y = +p[2], z = +p[3];
        positions.push(x, y, z);
        if (x < min[0]) min[0] = x; if (x > max[0]) max[0] = x;
        if (y < min[1]) min[1] = y; if (y > max[1]) max[1] = y;
        if (z < min[2]) min[2] = z; if (z > max[2]) max[2] = z;
      } else if (c1 === 110) { // 'n'
        const p = line.split(/\s+/);
        normals.push(+p[1], +p[2], +p[3]);
      }
    } else if (c0 === 102) {
      const p = line.split(/\s+/);
      const n = p.length - 1;
      if (n < 3) continue;

      // Fan-triangulate: (0,1,2), (0,2,3), ...
      for (let t = 1; t < n - 1; t++) {
        emit(p[1]); emit(p[t + 1]); emit(p[t + 2]);
      }
    }
  }

  function emit(token) {
    const slash = token.indexOf('/');
    let vi, ni = 0;
    if (slash < 0) {
      vi = parseInt(token, 10);
    } else {
      vi = parseInt(token.slice(0, slash), 10);
      const rest = token.slice(slash + 1);
      const slash2 = rest.indexOf('/');
      if (slash2 >= 0) ni = parseInt(rest.slice(slash2 + 1), 10) || 0;
    }

    // OBJ indices are 1-based, and negative means "counted back from the end".
    const pi = (vi > 0 ? vi - 1 : positions.length / 3 + vi) * 3;
    outPos.push(positions[pi], positions[pi + 1], positions[pi + 2]);

    if (ni !== 0 && normals.length) {
      const nn = (ni > 0 ? ni - 1 : normals.length / 3 + ni) * 3;
      outNorm.push(normals[nn], normals[nn + 1], normals[nn + 2]);
    } else {
      outNorm.push(0, 0, 0);   // filled in below
    }
  }

  const pos = new Float32Array(outPos);
  const nrm = new Float32Array(outNorm);

  // Any triangle whose normals came out zero gets a flat face normal, so a model
  // exported without normals still shades instead of rendering black.
  for (let i = 0; i < nrm.length; i += 9) {
    if (nrm[i] !== 0 || nrm[i + 1] !== 0 || nrm[i + 2] !== 0) continue;
    const ax = pos[i + 3] - pos[i], ay = pos[i + 4] - pos[i + 1], az = pos[i + 5] - pos[i + 2];
    const bx = pos[i + 6] - pos[i], by = pos[i + 7] - pos[i + 1], bz = pos[i + 8] - pos[i + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (let k = 0; k < 9; k += 3) { nrm[i + k] = nx; nrm[i + k + 1] = ny; nrm[i + k + 2] = nz; }
  }

  if (!isFinite(min[0])) { min.fill(-1); max.fill(1); }

  const core = coreBounds(pos);

  return { positions: pos, normals: nrm, min, max, core, triangles: pos.length / 9 };
}

/**
 * Robust bounds: the 2nd-98th percentile of vertex positions per axis.
 *
 * Author scenes routinely ship a studio backdrop or ground plane around the
 * subject - the McLaren .blend has a cyclorama that triples its bounding box.
 * Framing on the bbox then shows the backdrop and hides the car. Those props are
 * a handful of huge triangles while the subject is hundreds of thousands of small
 * ones, so percentiles over vertices land on the subject and ignore the set.
 */
function coreBounds(pos) {
  const n = pos.length / 3;
  if (n === 0) return { min: [-1, -1, -1], max: [1, 1, 1] };

  // Sample rather than sort every vertex - a city is millions of them.
  const stride = Math.max(1, Math.floor(n / 20000));
  const count = Math.floor((n - 1) / stride) + 1;

  const axes = [new Float32Array(count), new Float32Array(count), new Float32Array(count)];
  let w = 0;
  for (let i = 0; i < n; i += stride) {
    axes[0][w] = pos[i * 3];
    axes[1][w] = pos[i * 3 + 1];
    axes[2][w] = pos[i * 3 + 2];
    w++;
  }

  const min = [0, 0, 0], max = [0, 0, 0];
  for (let a = 0; a < 3; a++) {
    const arr = axes[a].subarray(0, w);
    arr.sort();
    min[a] = arr[Math.floor(w * 0.02)];
    max[a] = arr[Math.min(w - 1, Math.floor(w * 0.98))];
    if (!(max[a] > min[a])) { min[a] -= 0.5; max[a] += 0.5; }
  }
  return { min, max };
}

function makeVao(gl, positions, normals) {
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);

  const posBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
  gl.bufferData(gl.ARRAY_BUFFER, positions, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);

  const nrmBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
  gl.bufferData(gl.ARRAY_BUFFER, normals, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 0, 0);

  gl.bindVertexArray(null);
  return { vao, posBuf, nrmBuf, count: positions.length / 3 };
}

/**
 * Keep only triangles whose centroid lies inside `box` (grown by `margin`).
 *
 * Reframing on the subject is not enough on its own: scaling the subject up to
 * fill the frame scales the studio backdrop with it, and the camera ends up
 * inside the cyclorama. The backdrop has to actually go.
 */
function filterToBox(positions, normals, box, margin = 0.35) {
  const c = [0, 1, 2].map((a) => (box.min[a] + box.max[a]) / 2);
  const h = [0, 1, 2].map((a) => ((box.max[a] - box.min[a]) / 2) * (1 + margin) + 1e-6);

  const outP = [];
  const outN = [];
  for (let i = 0; i < positions.length; i += 9) {
    const cx = (positions[i] + positions[i + 3] + positions[i + 6]) / 3;
    const cy = (positions[i + 1] + positions[i + 4] + positions[i + 7]) / 3;
    const cz = (positions[i + 2] + positions[i + 5] + positions[i + 8]) / 3;
    if (Math.abs(cx - c[0]) > h[0]) continue;
    if (Math.abs(cy - c[1]) > h[1]) continue;
    if (Math.abs(cz - c[2]) > h[2]) continue;
    for (let k = 0; k < 9; k++) { outP.push(positions[i + k]); outN.push(normals[i + k]); }
  }

  return { positions: new Float32Array(outP), normals: new Float32Array(outN) };
}

/** Upload a parsed mesh into a VAO. */
export function uploadMesh(gl, data) {
  const full = makeVao(gl, data.positions, data.normals);

  const centre = [
    (data.min[0] + data.max[0]) / 2,
    (data.min[1] + data.max[1]) / 2,
    (data.min[2] + data.max[2]) / 2,
  ];
  const extent = Math.max(
    data.max[0] - data.min[0],
    data.max[1] - data.min[1],
    data.max[2] - data.min[2]) || 1;

  // Backdrop-resistant framing, used by the showcase scene. Falls back to the
  // full bounds for geometry built in-engine, which has no core computed.
  const core = data.core ?? { min: data.min, max: data.max };
  const coreCentre = [
    (core.min[0] + core.max[0]) / 2,
    (core.min[1] + core.max[1]) / 2,
    (core.min[2] + core.max[2]) / 2,
  ];
  const coreExtent = Math.max(
    core.max[0] - core.min[0],
    core.max[1] - core.min[1],
    core.max[2] - core.min[2]) || 1;

  // A second buffer holding just the subject, built only when the core is
  // meaningfully smaller than the whole model - i.e. when there is a backdrop.
  let subject = null;
  if (coreExtent < extent * 0.75) {
    const filtered = filterToBox(data.positions, data.normals, core);
    // Guard against a pathological core that would leave nothing to draw.
    if (filtered.positions.length > data.positions.length * 0.02)
      subject = makeVao(gl, filtered.positions, filtered.normals);
  }

  return {
    triangles: data.triangles,
    min: data.min,
    max: data.max,
    centre,
    extent,
    coreCentre,
    coreExtent,
    hasSubject: subject !== null,

    /** Draw everything. */
    draw() {
      gl.bindVertexArray(full.vao);
      gl.drawArrays(gl.TRIANGLES, 0, full.count);
      gl.bindVertexArray(null);
    },

    /** Draw just the subject, falling back to everything when there is no split. */
    drawSubject() {
      const v = subject ?? full;
      gl.bindVertexArray(v.vao);
      gl.drawArrays(gl.TRIANGLES, 0, v.count);
      gl.bindVertexArray(null);
    },

    dispose() {
      for (const v of [full, subject]) {
        if (!v) continue;
        gl.deleteVertexArray(v.vao);
        gl.deleteBuffer(v.posBuf);
        gl.deleteBuffer(v.nrmBuf);
      }
    },
  };
}

/** Fetch, parse and upload a mesh, caching by URL. */
export async function loadMesh(gl, url) {
  let byUrl = cache.get(gl);
  if (!byUrl) { byUrl = new Map(); cache.set(gl, byUrl); }
  if (byUrl.has(url)) return byUrl.get(url);

  const promise = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`mesh not found: ${url} (${res.status})`);
    return uploadMesh(gl, parseObj(await res.text()));
  })();

  // Cache the promise, not the result, so two scenes asking at once share one fetch.
  byUrl.set(url, promise);
  return promise;
}

/** The asset catalogue, fetched once. */
let catalogPromise = null;
export function loadCatalog() {
  catalogPromise ??= fetch('api/assets')
    .then((r) => (r.ok ? r.json() : []))
    .catch(() => []);
  return catalogPromise;
}

/**
 * Choose an asset by tag preference, deterministically for a given seed.
 * Returns null when the catalogue is empty, which lets a scene fall back to
 * procedural geometry rather than failing.
 */
export function pickAsset(catalog, wantedTags, seed = 0) {
  if (!catalog?.length) return null;

  const scored = catalog.map((a, i) => {
    const overlap = (a.tags ?? []).filter((t) => wantedTags.includes(t)).length;
    // Deterministic jitter so different scenes in one video pick different models.
    const jitter = ((Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453) % 1 + 1) % 1;
    return { asset: a, score: overlap * 2 + jitter };
  });

  scored.sort((x, y) => y.score - x.score);
  return scored[0].asset;
}
