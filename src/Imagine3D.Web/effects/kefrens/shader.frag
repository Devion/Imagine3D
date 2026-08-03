#include "common.glsl"
#include "palette.glsl"

// Kefrens bars. The original drew ONE bar into a single-scanline bitmap repeated
// down the screen, so each row lagged the one above by a frame - the column
// appears to snake. Here the lag is expressed directly as a per-row time offset.

void main() {
  vec2 uv = vUv;

  // Row index counts from the top so the trail follows downward.
  //
  // The lag between rows is the whole effect: each scanline shows the bar as it
  // was some frames earlier, so the column snakes. It has to span several radians
  // across the screen or the result is just one slightly-leaning bar.
  float row = 1.0 - uv.y;
  float t = uTime * p_speed - row * p_lag * 110.0;

  // Bar centre: two sines so the path is not a plain oscillation.
  float centre = 0.5 + (sin(t) * 0.62 + sin(t * 0.47 + 1.3) * 0.38) * p_amplitude * 0.5;

  float d = abs(uv.x - centre);
  vec3 col = vec3(0.02, 0.02, 0.035);

  if (d < p_width) {
    float k = 1.0 - d / p_width;
    // Rounded metallic cross-section.
    float shade = sqrt(max(0.0, k));
    vec3 barCol = pal(fract(row * 0.5 + uTime * 0.05));
    col = mix(barCol * 0.35, barCol + vec3(0.3), shade);
  }

  // Scanline pitch, which is the whole point of the effect.
  col *= 0.75 + 0.25 * step(0.5, fract(uv.y * uResolution.y * 0.5));
  col *= 0.9 + 0.35 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
