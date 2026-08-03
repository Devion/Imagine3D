#include "common.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// A kaleidoscopic IFS lattice flown through as a volume.
//
// Three ideas stack up: polar folding repeats the geometry around the tunnel
// axis; an iterated abs-fold turns one box into a self-similar cluster; and the
// march accumulates exp(-distance) instead of stopping at a surface, which is
// what gives the soft neon depth rather than hard plastic edges.
//
// Technique reference: the "Phantom Mode" family of Shadertoys.

float gFolds, gSectors;

/// Fold the plane into `r` mirrored sectors around the origin.
vec2 pmod(vec2 p, float r) {
  float a = atan(p.x, p.y) + PI / r;
  float n = TAU / r;
  a = floor(a / n) * n;
  return rot(-a) * p;
}

float ifsBox(vec3 p) {
  int folds = int(clamp(gFolds, 1.0, 8.0));
  for (int i = 0; i < 8; i++) {
    if (i >= folds) break;
    p = abs(p) - 1.0;
    p.xy = rot(uTime * 0.3) * p.xy;
    p.xz = rot(uTime * 0.1) * p.xz;
  }
  p.xz = rot(uTime) * p.xz;
  return sdBox(p, vec3(0.4, 0.8, 0.3));
}

float map(vec3 p) {
  // Repeat the cluster through space so the tunnel never ends.
  vec3 q = p;
  q.x = mod(q.x - 5.0, 10.0) - 5.0;
  q.y = mod(q.y - 5.0, 10.0) - 5.0;
  q.z = mod(q.z, 16.0) - 8.0;
  q.xy = pmod(q.xy, max(2.0, gSectors));
  return ifsBox(q);
}

void main() {
  gFolds = p_folds;
  gSectors = p_sectors;

  vec2 uv = centered(vUv, uAspect);

  vec3 ro = vec3(0.0, 0.0, -p_speed * uTime);
  vec3 fwd = vec3(0.0, 0.0, -1.0);
  vec3 up = normalize(vec3(sin(uTime * 0.5) * 0.4, 1.0, 0.0));
  vec3 side = cross(fwd, up);
  vec3 rd = normalize(side * uv.x + up * uv.y + fwd);

  float acc = 0.0;     // total density
  float bright = 0.0;  // density inside a travelling pulse
  float t = 0.0;

  for (int i = 0; i < 99; i++) {
    vec3 pos = ro + rd * t;
    float dist = max(abs(map(pos)), 0.02);

    float a = exp(-dist * 3.0);

    // Bands of extra brightness sweeping down the tunnel, so the structure
    // breathes rather than sitting at a constant glow.
    if (mod(length(pos) + 24.0 * uTime, 30.0) < 3.0) {
      a *= 2.0;
      bright += a;
    }

    acc += a;
    t += dist * 0.5;
  }

  // Shape the accumulator before it hits the palette. Feeding the raw sum in
  // and tone-mapping afterwards flattened everything to one bright tone,
  // because almost every ray accumulates a similar total across 99 steps - the
  // structure lives in the *differences*, so it needs a curve, not a clamp.
  float density = smoothstep(0.15, 0.95, acc * 0.012);
  float hot = smoothstep(0.0, 0.6, bright * 0.02);

  vec3 col = palClamp(0.10 + density * 0.7) * density * p_glow * 1.25;
  col += palClamp(0.95) * hot * p_pulse * 0.5;

  col *= 0.9 + 0.35 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
