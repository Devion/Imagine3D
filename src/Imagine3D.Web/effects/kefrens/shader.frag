#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Kefrens bars, several deep.
//
// The original drew ONE bar into a single-scanline bitmap that the hardware
// repeated down the whole screen, so every row showed the bar as it had been a
// frame or two earlier and the column appeared to snake. That lag is the whole
// effect and it is written here directly, as a per-row time offset, rather than
// emulated with a buffer.
//
// One bar was the hardware limit, not the idea. This draws up to eight at
// different depths, and the depth is carried by everything at once: a nearer bar
// is wider, brighter, faster, swings further and lags harder, so the bars cross
// in front of one another at different rates and the frame reads as a space with
// bars in it rather than as a curve on a wall. Only the nearest bar covering a
// pixel is shaded, but every bar's halo is additive, so a crossing brightens.
//
// Each bar also drags a train of ghosts behind it — the afterimage a long-
// persistence CRT gave this effect for free and a flat panel does not.

/// Where a bar's centre sits at time t, as a fraction of half the frame width.
/// Two sines of unrelated period, so the path never settles into a plain
/// oscillation and the bars never all reach the edge together.
float barCentre(float t, float amp, float phase) {
  return (sin(t + phase) * 0.62 + sin(t * 0.47 + 1.3 + phase) * 0.38) * amp;
}

void main() {
  // Breathing zoom, on top of whatever the storyboard asks for. Two slow sines
  // rather than one, so it never reaches the same size at the same phase twice.
  float breathe = 1.0 + 0.22 * sin(uTime * 0.21) + 0.10 * sin(uTime * 0.37);
  float zoom = max(0.15, p_zoom * breathe);

  vec2 p = centered(vUv, uAspect) / zoom;
  p = rot(sin(uTime * 0.09) * 0.13) * p;

  float aa = pixel() / zoom;
  float row = (1.0 - p.y) * 0.5;      // counts downward, as the raster does

  // --- the field the bars are drawn into ----------------------------------
  vec3 col = palClamp(0.03) * (0.45 + 0.55 * exp(-length(p) * 0.7));
  col += palClamp(0.22) * fbm(vec2(p.x * 0.7, p.y * 0.7 + uTime * 0.05), 4, 2.0, 0.5) * 0.055;
  col += palClamp(0.45) * exp(-abs(p.y) * 2.0) * 0.045;

  int n = int(clamp(p_bars, 1.0, 8.0));
  float nearest = 1e9;
  vec3 bodyCol = vec3(0.0);
  float bodyMask = 0.0;
  vec3 glow = vec3(0.0);

  for (int i = 0; i < 8; i++) {
    if (i >= n) break;
    float fi = float(i);
    float seed = hash11(fi * 7.31 + 3.0);
    float depth = n > 1 ? fi / float(n - 1) : 0.0;      // 0 nearest, 1 furthest

    float rate  = mix(1.30, 0.55, depth) * (0.85 + 0.30 * seed);
    float lag   = p_lag * mix(1.40, 0.55, depth) * (0.80 + 0.40 * seed);
    float halfW = p_width * mix(1.55, 0.45, depth) * uAspect;
    float amp   = p_amplitude * mix(1.00, 0.55, depth);
    float phase = seed * TAU;

    float t = uTime * p_speed * rate - row * lag * 110.0;
    vec3 tint = pal(fract(row * 0.4 + fi * 0.17 + uTime * 0.05));

    // Ghost train. Additive only - a ghost is light that has not faded yet, not
    // an object, so it must never occlude the bar that cast it.
    for (int g = 1; g <= 4; g++) {
      float cg = barCentre(t - float(g) * 0.085 * p_ghost, amp, phase) * uAspect;
      glow += tint * exp(-abs(p.x - cg) / (halfW * 1.25))
              * exp(-float(g) * 0.7) * 0.16 * p_ghost * mix(1.0, 0.40, depth);
    }

    float c = barCentre(t, amp, phase) * uAspect;
    float d = abs(p.x - c);

    // Halo. Reaches well past the bar and is additive, so where two bars cross
    // they brighten instead of one simply covering the other.
    glow += tint * exp(-d / (halfW * 1.8)) * 0.32 * mix(1.20, 0.45, depth);

    if (d > halfW + aa * 2.0) continue;

    // Cross-section, in -1..1 across the bar. The exponent matters more than it
    // looks: too high and the bar stays at full brightness right to its edge, so
    // however well anti-aliased that edge is it still meets the background as a
    // contrast step.
    float u = clamp((p.x - c) / halfW, -1.0, 1.0);
    float body = pow(max(0.0, 1.0 - u * u), 0.6);
    float spec = exp(-pow((u + 0.42) * 3.6, 2.0));
    float bounce = exp(-pow((u - 0.55) * 4.5, 2.0)) * 0.35;

    vec3 metal = tint * (0.18 + 0.62 * body);
    metal += vec3(1.0) * spec * 0.65;
    metal += tint * bounce * 0.65;
    metal *= mix(1.20, 0.55, depth);
    // A sheen travelling down its length, so it reads as a lit tube rather than
    // as a filled stripe.
    metal *= 0.82 + 0.30 * sin(row * 9.0 - t * 0.6);
    metal = mix(metal, palClamp(0.06), depth * 0.45);      // haze with distance

    float mask = smoothstep(halfW + aa, halfW - aa, d);
    if (mask > 0.01 && depth < nearest) {
      nearest = depth;
      bodyCol = metal;
      bodyMask = mask;
    }
  }

  col += glow * p_glow;
  col = mix(col, bodyCol, bodyMask);

  // Scanline pitch, which is the whole point of the effect. Measured in screen
  // rows, not in the zoomed frame: it belongs to the tube, not to the picture.
  col *= 0.78 + 0.22 * step(0.5, fract(vUv.y * uResolution.y * 0.5));

  col *= 0.90 + 0.35 * uBeatPulse;
  col *= 1.0 - 0.28 * pow(clamp(length(centered(vUv, uAspect) * vec2(0.5, 0.8)), 0.0, 1.0), 2.4);
  fragColor = vec4(max(col, 0.0), 1.0);
}
