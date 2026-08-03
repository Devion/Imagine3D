#include "common.glsl"
#include "palette.glsl"

// Nested glowing rings from repeated space folding.
//
// Each pass does fract(uv * zoom) - 0.5, which tiles the plane and re-centres
// every tile; drawing one ring per pass therefore draws a whole grid of them,
// at a finer scale each time. The 1/d falloff turns a distance into a filament
// with a hot core and a wide halo, and summing the layers gives the depth.
//
// Technique reference: the widely-shared "fract space folding" tutorial shader.

void main() {
  vec2 uv = centered(vUv, uAspect);
  vec2 uv0 = uv;
  float t = uTime * p_speed;

  vec3 col = vec3(0.0);
  int layers = int(clamp(p_layers, 1.0, 8.0));

  for (int i = 0; i < 8; i++) {
    if (i >= layers) break;
    float fi = float(i);

    // Fold space: tile it, then re-centre each tile.
    uv = fract(uv * p_zoom) - 0.5;

    // Distance from this tile's centre, attenuated by the distance from the
    // *original* centre - that is what makes the whole thing fall away toward
    // the frame edges instead of tiling flat.
    float d = length(uv) * exp(-length(uv0));

    vec3 layerCol = pal(fract(length(uv0) + fi * 0.4 + t));

    // Concentric rings, then fold to a positive distance so both sides of each
    // ring glow.
    d = abs(sin(d * p_rings + uTime) / p_rings);

    // Inverse falloff: the filament.
    d = pow(0.01 / max(d, 1e-5), p_sharp);

    col += layerCol * d;
  }

  // The sum is unbounded; tone-map rather than clip.
  col = col / (1.0 + col * 0.55);
  col *= 0.9 + 0.4 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
