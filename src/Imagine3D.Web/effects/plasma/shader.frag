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

  // Depth, rather than a vignette.
  //
  // The frame used to be darkened by radius alone, which on 16:9 took the
  // corners down by a third for no reason other than to stop the plasma reading
  // as flat wallpaper. It does stop that, and it also throws away the outer
  // sixth of every frame. A second copy of the field sampled further out - a
  // parallax layer, moving slower and dimmer - answers the same objection by
  // giving the picture a behind instead of an edge.
  vec2 far = rot(-t * 0.08) * p * 0.45;
  float w = sin(far.x * 1.3 - t * 0.6) + sin(far.y * 1.1 + t * 0.5)
          + sin(length(far) * 1.7 + t * 0.4);
  w = w * 0.1667 + 0.5;
  col = mix(palClamp(w) * 0.55, col, 0.72 + 0.16 * uBeatPulse);

  // What is left of the falloff: a shade at the corners, not a hole.
  float vig = 1.0 - 0.16 * pow(length(centered(vUv, uAspect)) * 0.55, 2.0)
                    * (1.0 - 0.4 * uBeatPulse);
  fragColor = vec4(max(col * vig, 0.0), 1.0);
}
