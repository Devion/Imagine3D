#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Raster bars.
//
// What sells these is that they read as polished metal tubes, not coloured
// stripes. Three things do that, and the previous version had none of them:
//
//  - a specular cross-section: a tight highlight above the centreline and a
//    weaker bounce below it, rather than one flat gradient;
//  - anti-aliased edges measured in pixels, not in a fraction of the bar. The
//    old smoothstep(0, 0.15, k) was fully opaque 15% in from the edge, which at
//    1080p is a hard step;
//  - an additive halo, so a bar sits in the frame instead of being pasted on it.
//
// Bars also carry a depth now, so they weave in front of each other rather than
// later ones simply overwriting earlier ones.

void main() {
  float y = vUv.y;

  // One pixel, in the same units as y. Every edge is softened by this much, so
  // the softness is constant on screen regardless of bar thickness.
  float aa = 2.0 / uResolution.y;

  // --- background -----------------------------------------------------------
  // A smooth ramp with a little noise. The old 12-step palSteps() banded hard
  // and fought with the bars for attention.
  float bg = y * 0.55 + uTime * 0.015;
  vec3 col = palClamp(0.04 + 0.16 * fract(bg)) * 0.5;
  col *= 0.75 + 0.35 * fbm(vec2(vUv.x * 2.0, y * 3.0 + uTime * 0.05), 3, 2.0, 0.5);
  // Gentle horizon glow behind the bars.
  col += palClamp(0.35) * exp(-abs(y - 0.5) * 3.5) * 0.12;

  int count = int(clamp(p_count, 1.0, 16.0));

  vec3 glowAcc = vec3(0.0);
  vec3 bodyCol = vec3(0.0);
  float bodyMask = 0.0;
  float nearest = 1e9;

  for (int i = 0; i < 16; i++) {
    if (i >= count) break;
    float fi = float(i);

    float phase = uTime * p_speed + fi * (TAU / float(count));
    float centre = 0.5 + sin(phase) * p_spread * 0.5 + sin(phase * 0.37) * 0.08;

    // Depth from a slower sine, so bars cross in front of one another.
    float depth = 0.5 + 0.5 * sin(phase * 0.61 + fi * 1.7);

    // Nearer bars are thicker and brighter - a cheap but convincing parallax.
    float half_ = p_thickness * mix(1.25, 0.7, depth);

    float d = y - centre;               // signed: which side of the axis
    float ad = abs(d);

    // Halo reaches well beyond the bar and is additive, so overlapping halos
    // brighten instead of occluding.
    vec3 tint = pal(fract(fi / float(count) + uTime * 0.05));
    glowAcc += tint * exp(-ad / (half_ * 2.2)) * p_glow * 0.20 * mix(1.0, 0.5, depth);

    if (ad > half_ + aa * 2.0) continue;

    // Cross-section, in -1..1 across the bar.
    float u = clamp(d / half_, -1.0, 1.0);

    // Body: falls off toward both edges, like a cylinder turning away. The
    // exponent matters more than it looks - at 0.35 the bar stayed near full
    // brightness right up to the edge, so however well anti-aliased that edge
    // was it still met the background as a hard contrast step.
    float body = pow(max(0.0, 1.0 - u * u), 0.6);

    // Specular: a tight band above the centreline, plus a dimmer bounce below.
    float spec = exp(-pow((u + 0.42) * 3.6, 2.0));
    float bounce = exp(-pow((u - 0.55) * 4.5, 2.0)) * 0.35;

    vec3 metal = tint * (0.18 + 0.62 * body);
    metal += vec3(1.0) * spec * p_metal;
    metal += tint * bounce * p_metal;
    metal *= mix(1.15, 0.72, depth);       // near bars catch more light

    // A sheen travelling along the bar's length. Without it a bar is uniform
    // from edge to edge and reads as a filled band rather than a lit object.
    metal *= 0.82 + 0.30 * sin(vUv.x * 2.4 - phase * 1.6);

    float mask = smoothstep(half_ + aa, half_ - aa, ad);

    // Keep only the nearest bar covering this pixel.
    if (mask > 0.01 && depth < nearest) {
      nearest = depth;
      bodyCol = metal;
      bodyMask = mask;
    }
  }

  col += glowAcc;
  col = mix(col, bodyCol, bodyMask);

  // Raster dots drifting across. Much dimmer than before - at 0.3 + 0.7*beat
  // they read as flashing confetti over the bars.
  vec2 g = vUv * vec2(uAspect, 1.0) * 60.0;
  vec2 cell = floor(g + vec2(uTime * 6.0, 0.0));
  float speck = step(0.992, hash12(cell));
  col += speck * pal(fract(hash12(cell) + 0.3)) * (0.10 + 0.18 * uBeatPulse);

  col *= 0.95 + 0.12 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
