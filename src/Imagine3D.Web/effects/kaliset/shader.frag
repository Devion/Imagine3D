#include "common.glsl"
#include "palette.glsl"

// The Kali set: repeatedly reflect into the positive octant, scale by 1/|p|^2 and
// offset. Cheap per iteration and produces the dense lattice look that a
// full raymarched fractal costs ten times as much to approximate.

void main() {
  vec2 uv = centered(vUv, uAspect) * p_zoom;
  uv = rot(uTime * p_spin) * uv;

  vec3 p = vec3(uv, sin(uTime * 0.13) * 0.4 + 0.5);
  vec3 fold = vec3(p_fold, p_fold * 0.94 + 0.04, p_fold * 1.02);

  float accum = 0.0;
  float minDist = 1e9;

  int iter = int(clamp(p_iterations, 4.0, 24.0));
  for (int i = 0; i < 24; i++) {
    if (i >= iter) break;
    p = abs(p) / max(dot(p, p), 1e-4) - fold;
    float l = length(p);
    accum += exp(-l * 1.4);
    minDist = min(minDist, l);
  }

  accum /= float(iter);

  // The raw accumulator saturates almost everywhere, which washed the lattice
  // out to flat white. Remapping through a narrow window puts the interesting
  // range of the fractal across the palette instead of clipping past its top.
  float shade = smoothstep(0.12, 0.62, accum);

  vec3 col = palClamp(shade * 0.9);

  // Orbit trap picks out the lattice filaments over that base.
  float trap = smoothstep(0.9, 0.0, minDist);
  col += pal(fract(minDist * 0.6 + uTime * 0.05)) * trap * 0.7;

  // Darken the empty regions so the structure reads instead of glowing evenly.
  col *= 0.25 + 0.85 * shade;

  col *= 0.85 + 0.4 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
