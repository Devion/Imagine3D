// Minimal column-major 4x4 matrix and vec3 helpers.
//
// The mesh effects need perspective, look-at and normal matrices and nothing else,
// so this exists instead of a 600 KB dependency that would also have to be
// vendored to satisfy the offline/CSP constraint.

export const mat4 = {
  create: () => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),

  perspective(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2);
    const nf = 1 / (near - far);
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1;
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0;
    return out;
  },

  lookAt(out, eye, center, up) {
    let z0 = eye[0] - center[0], z1 = eye[1] - center[1], z2 = eye[2] - center[2];
    let len = Math.hypot(z0, z1, z2) || 1;
    z0 /= len; z1 /= len; z2 /= len;

    let x0 = up[1] * z2 - up[2] * z1;
    let x1 = up[2] * z0 - up[0] * z2;
    let x2 = up[0] * z1 - up[1] * z0;
    len = Math.hypot(x0, x1, x2);
    if (len < 1e-6) { x0 = 1; x1 = 0; x2 = 0; } else { x0 /= len; x1 /= len; x2 /= len; }

    const y0 = z1 * x2 - z2 * x1;
    const y1 = z2 * x0 - z0 * x2;
    const y2 = z0 * x1 - z1 * x0;

    out[0] = x0; out[1] = y0; out[2] = z0; out[3] = 0;
    out[4] = x1; out[5] = y1; out[6] = z1; out[7] = 0;
    out[8] = x2; out[9] = y2; out[10] = z2; out[11] = 0;
    out[12] = -(x0 * eye[0] + x1 * eye[1] + x2 * eye[2]);
    out[13] = -(y0 * eye[0] + y1 * eye[1] + y2 * eye[2]);
    out[14] = -(z0 * eye[0] + z1 * eye[1] + z2 * eye[2]);
    out[15] = 1;
    return out;
  },

  multiply(out, a, b) {
    for (let c = 0; c < 4; c++) {
      const b0 = b[c * 4], b1 = b[c * 4 + 1], b2 = b[c * 4 + 2], b3 = b[c * 4 + 3];
      out[c * 4] = a[0] * b0 + a[4] * b1 + a[8] * b2 + a[12] * b3;
      out[c * 4 + 1] = a[1] * b0 + a[5] * b1 + a[9] * b2 + a[13] * b3;
      out[c * 4 + 2] = a[2] * b0 + a[6] * b1 + a[10] * b2 + a[14] * b3;
      out[c * 4 + 3] = a[3] * b0 + a[7] * b1 + a[11] * b2 + a[15] * b3;
    }
    return out;
  },

  identity(out) {
    out.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    return out;
  },

  translate(out, x, y, z) {
    mat4.identity(out);
    out[12] = x; out[13] = y; out[14] = z;
    return out;
  },

  scale(out, s) {
    mat4.identity(out);
    out[0] = out[5] = out[10] = s;
    return out;
  },

  rotateY(out, a) {
    const c = Math.cos(a), s = Math.sin(a);
    mat4.identity(out);
    out[0] = c; out[2] = -s; out[8] = s; out[10] = c;
    return out;
  },

  rotateX(out, a) {
    const c = Math.cos(a), s = Math.sin(a);
    mat4.identity(out);
    out[5] = c; out[6] = s; out[9] = -s; out[10] = c;
    return out;
  },

  /**
   * Inverse-transpose of the upper 3x3, as a mat3 laid out for GLSL.
   * Needed so normals survive non-uniform scaling.
   */
  normalMatrix(out9, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2];
    const a10 = m[4], a11 = m[5], a12 = m[6];
    const a20 = m[8], a21 = m[9], a22 = m[10];

    const b01 = a22 * a11 - a12 * a21;
    const b11 = -a22 * a10 + a12 * a20;
    const b21 = a21 * a10 - a11 * a20;

    let det = a00 * b01 + a01 * b11 + a02 * b21;
    if (Math.abs(det) < 1e-12) { out9.set([1, 0, 0, 0, 1, 0, 0, 0, 1]); return out9; }
    det = 1 / det;

    out9[0] = b01 * det;
    out9[1] = (-a22 * a01 + a02 * a21) * det;
    out9[2] = (a12 * a01 - a02 * a11) * det;
    out9[3] = b11 * det;
    out9[4] = (a22 * a00 - a02 * a20) * det;
    out9[5] = (-a12 * a00 + a02 * a10) * det;
    out9[6] = b21 * det;
    out9[7] = (-a21 * a00 + a01 * a20) * det;
    out9[8] = (a11 * a00 - a01 * a10) * det;
    return out9;
  },
};
