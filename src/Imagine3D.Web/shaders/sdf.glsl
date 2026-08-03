#include "common.glsl"

// Signed distance functions and the raymarch helpers the fullscreen 3D effects
// share (tunnels, fractals, sphere fields, terrain).
//
// Forward declaration: the helpers below call map(), but each effect supplies its
// own definition *after* including this file. GLSL requires the prototype first.
float map(vec3 p);

float sdSphere(vec3 p, float r) { return length(p) - r; }

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

float sdTorus(vec3 p, vec2 t) {
  vec2 q = vec2(length(p.xz) - t.x, p.y);
  return length(q) - t.y;
}

float sdPlane(vec3 p, vec3 n, float h) { return dot(p, n) + h; }

float sdCylinder(vec3 p, float r, float h) {
  vec2 d = abs(vec2(length(p.xz), p.y)) - vec2(r, h);
  return min(max(d.x, d.y), 0.0) + length(max(d, 0.0));
}

float sdOctahedron(vec3 p, float s) {
  p = abs(p);
  return (p.x + p.y + p.z - s) * 0.57735027;
}

// Smooth minimum - the operator that makes SDF shapes melt into each other.
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

float opUnion(float a, float b)        { return min(a, b); }
float opSubtract(float a, float b)     { return max(-a, b); }
float opIntersect(float a, float b)    { return max(a, b); }

// Infinite repetition - one primitive becomes an endless lattice.
vec3 opRepeat(vec3 p, vec3 period) {
  return mod(p + 0.5 * period, period) - 0.5 * period;
}

/// Central-difference normal. eps must be larger than the marcher's hit epsilon
/// or the normal comes out as noise.
vec3 calcNormal(vec3 p, float eps) {
  vec2 e = vec2(eps, 0.0);
  return normalize(vec3(
    map(p + e.xyy) - map(p - e.xyy),
    map(p + e.yxy) - map(p - e.yxy),
    map(p + e.yyx) - map(p - e.yyx)));
}

/// Standard sphere-tracing loop. Effects define `float map(vec3 p)` before
/// including this and get marching for free.
float raymarch(vec3 ro, vec3 rd, float maxDist, int maxSteps, out int steps) {
  float t = 0.0;
  steps = 0;
  for (int i = 0; i < 256; i++) {
    if (i >= maxSteps) break;
    steps = i;
    vec3 p = ro + rd * t;
    float d = map(p);
    if (d < 0.0008 * t || t > maxDist) break;
    // Slight under-relaxation keeps thin/grazing geometry from being stepped over.
    t += d * 0.9;
  }
  return t;
}

/// Soft shadow by marching toward the light and tracking the closest approach.
float softShadow(vec3 ro, vec3 rd, float mint, float maxt, float k) {
  float res = 1.0, t = mint;
  for (int i = 0; i < 48; i++) {
    if (t >= maxt) break;
    float h = map(ro + rd * t);
    if (h < 0.001) return 0.0;
    res = min(res, k * h / t);
    t += clamp(h, 0.01, 0.3);
  }
  return clamp(res, 0.0, 1.0);
}

/// Cheap ambient occlusion from how fast the field falls away.
float ambientOcclusion(vec3 p, vec3 n) {
  float occ = 0.0, sca = 1.0;
  for (int i = 0; i < 5; i++) {
    float h = 0.01 + 0.12 * float(i) / 4.0;
    float d = map(p + n * h);
    occ += (h - d) * sca;
    sca *= 0.95;
  }
  return clamp(1.0 - 3.0 * occ, 0.0, 1.0);
}

/// Camera basis from an eye position and a target.
mat3 lookAt(vec3 eye, vec3 target, float roll) {
  vec3 f = normalize(target - eye);
  vec3 up = vec3(sin(roll), cos(roll), 0.0);
  vec3 r = normalize(cross(f, up));
  vec3 u = cross(r, f);
  return mat3(r, u, f);
}
