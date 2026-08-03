#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Rising fire. The original ran a cellular decay buffer bottom-up; this gets the
// same silhouette from fBm advected upward, which needs no feedback buffer and
// stays resolution independent.

void main() {
  vec2 uv = vUv;

  // Advect upward and pinch toward the middle so flames lean inward.
  vec2 p = vec2(uv.x * uAspect * 2.2, uv.y);
  p.y -= uTime * p_speed;
  p.x += sin(uv.y * 3.0 + uTime * 0.7) * 0.12;

  int oct = int(clamp(p_detail, 1.0, 8.0));
  float n = fbm(p * p_turbulence, oct, 2.1, 0.55);

  // Fuel falls off with height; the noise eats into it to make tongues.
  float fuel = 1.0 - uv.y / max(0.05, p_height);
  fuel *= 1.0 - pow(abs(uv.x - 0.5) * 2.0, 3.0) * 0.55;   // narrower at the edges

  float heat = clamp(fuel * 1.35 - n * 0.85, 0.0, 1.0);
  heat = pow(heat, 1.35);

  // Map heat through the palette's hot end, with a white core.
  vec3 col = palClamp(0.15 + heat * 0.85);
  col += vec3(1.0, 0.95, 0.85) * smoothstep(0.72, 1.0, heat) * 0.8;
  col *= heat;

  // Embers drifting up out of the flame front.
  vec2 eg = vec2(uv.x * uAspect, uv.y) * 44.0 + vec2(0.0, -uTime * 2.4);
  vec2 ecell = floor(eg);
  float ember = step(0.992, hash12(ecell)) *
                smoothstep(0.6, 0.0, length(fract(eg) - 0.5)) *
                smoothstep(0.9, 0.2, uv.y);
  col += ember * palClamp(0.85) * (0.5 + uBeatPulse);

  fragColor = vec4(col, 1.0);
}
