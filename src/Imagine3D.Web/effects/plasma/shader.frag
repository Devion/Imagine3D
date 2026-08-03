#include "common.glsl"
#include "palette.glsl"

// Summed sines in x, y and radius - the same construction the Amiga demos used,
// just evaluated per pixel instead of per copper line.

void main() {
  vec2 p = centered(vUv, uAspect) * p_scale;
  float t = uTime * p_speed;

  float v = 0.0;
  v += sin(p.x + t);
  v += sin((p.y + t) * 0.9);
  v += sin((p.x + p.y + t) * 0.7);
  v += sin(length(p * 1.2) - t * 1.3);
  // A slow rotating term stops the pattern from ever looking like a static grid.
  vec2 q = rot(t * 0.15) * p;
  v += sin(q.x * 1.4 - t * 0.6) * 1.2;

  v = v * 0.125 + 0.5;

  float shifted = v + uTime * p_cycle;
  vec3 col = p_steps > 2.0 ? palSteps(shifted, p_steps) : pal(shifted);

  // Radial falloff keeps the frame from reading as flat wallpaper, and the beat
  // opens it up briefly.
  float vig = 1.0 - 0.35 * length(centered(vUv, uAspect)) * (1.0 - 0.4 * uBeatPulse);
  fragColor = vec4(col * vig, 1.0);
}
