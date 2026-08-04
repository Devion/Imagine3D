#include "common.glsl"
#include "palette.glsl"

// Flight through an infinite lattice of star clusters.
//
// Two folds stacked. The outer one tiles space - abs(tile - mod(p, 2*tile)) maps
// the whole ray into one cell, so the field repeats forever for free. The inner
// one is the inversion p = abs(p)/dot(p,p) - c, and what is accumulated is the
// running total of how much |p| changed at each step. Points where the orbit
// barely moves contribute nothing; points where it jumps contribute a lot, and
// those spikes are the stars.
//
// Nothing here is a distance field, so there is no hit test - the loop is a fixed
// number of equal steps with a fading weight, which is why the clusters pass
// through one another rather than occluding.
//
// Technique reference: Kali's "Star Nest" Shadertoy.

void main() {
  vec2 uv = (vUv - 0.5) * vec2(1.0, 1.0 / uAspect);
  float t = uTime * p_speed * 0.01 + 0.25;

  vec3 dir = vec3(uv * p_zoom, 1.0);
  vec3 from = vec3(1.0, 0.5, 0.5) + vec3(t * 2.0, t, -2.0);

  // The reference steered from the mouse; drifting instead keeps the tunnel from
  // ever running dead straight, which is what makes the fold visible.
  float a1 = 0.5 + sin(uTime * 0.05) * 0.3;
  float a2 = 0.8 + cos(uTime * 0.037) * 0.25;
  mat2 r1 = rot(a1), r2 = rot(a2);
  dir.xz = r1 * dir.xz;  dir.xy = r2 * dir.xy;
  from.xz = r1 * from.xz; from.xy = r2 * from.xy;

  float tile = max(p_tile, 0.05);
  int volsteps = int(clamp(p_steps, 8.0, 32.0));
  int iterations = int(clamp(p_folds, 6.0, 24.0));

  float s = 0.1, fade = 1.0;
  vec3 v = vec3(0.0);

  for (int r = 0; r < 32; r++) {
    if (r >= volsteps) break;

    vec3 p = from + s * dir * 0.5;
    p = abs(vec3(tile) - mod(p, vec3(tile * 2.0)));   // tiling fold

    float pa = 0.0, a = 0.0;
    for (int i = 0; i < 24; i++) {
      if (i >= iterations) break;
      p = abs(p) / max(dot(p, p), 1e-6) - 0.53;
      a += abs(length(p) - pa);
      pa = length(p);
    }

    float dm = max(0.0, p_darkmatter - a * a * 0.001);
    a *= a * a;                       // contrast: the spikes have to dominate
    if (r > 6) fade *= 1.0 - dm;      // only occlude once the ray is well inside

    v += fade;
    // Colour by how far along the ray the sample is, so near clusters and far
    // ones sit at different points on the ramp.
    v += palClamp(sat(s * 0.55)) * a * 0.0015 * fade * p_bright * 3.0;
    fade *= 0.73;
    s += 0.1;
  }

  v = mix(vec3(length(v)), v, 0.85);
  vec3 col = v * 0.01;

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
