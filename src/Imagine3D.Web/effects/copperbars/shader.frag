#include "common.glsl"
#include "palette.glsl"

// Raster bars. Each bar is a horizontal band whose centre follows its own sine;
// the shading across a bar is the rounded highlight the copper list produced by
// stepping the background colour register per scanline.

void main() {
  float y = vUv.y;

  // Background: a hard-stepped vertical gradient, like a copper list.
  vec3 col = palSteps(y * 0.5 + uTime * 0.02, 12.0) * 0.35;

  int count = int(clamp(p_count, 1.0, 16.0));
  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    float fi = float(i);

    float phase = uTime * p_speed + fi * (TAU / float(count));
    float centre = 0.5 + sin(phase) * p_spread * 0.5 + sin(phase * 0.37) * 0.08;

    float d = abs(y - centre);
    if (d > p_thickness) continue;

    // Rounded cross-section: bright core, dark edges.
    float k = 1.0 - d / p_thickness;
    float shade = sqrt(max(0.0, k));

    vec3 barCol = pal(fract(fi / float(count) + uTime * 0.05));
    barCol = mix(barCol * 0.4, barCol + vec3(0.25), shade);

    // Later bars draw over earlier ones - no depth sorting, exactly as on metal.
    col = mix(col, barCol, smoothstep(0.0, 0.15, k));
  }

  // Raster dots drifting across, punched by the beat.
  vec2 g = vUv * vec2(uAspect, 1.0) * 60.0;
  vec2 cell = floor(g + vec2(uTime * 6.0, 0.0));
  float dot_ = step(0.985, hash12(cell));
  col += dot_ * pal(fract(hash12(cell) + 0.3)) * (0.3 + 0.7 * uBeatPulse);

  fragColor = vec4(col, 1.0);
}
