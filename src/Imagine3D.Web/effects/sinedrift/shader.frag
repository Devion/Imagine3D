#include "common.glsl"
#include "palette.glsl"

// Iterated sine warp. Each pass displaces y by the product of two sines - one
// reading x, one reading y - at a frequency that grows as i*i, so a flat vertical
// gradient folds into soft contour bands that never quite repeat.
//
// The original mapped the folded height straight onto fixed r/g/b offsets, which
// is where its blue-teal look came from. Here the height drives the project
// palette instead, so the effect sits in the same colour world as everything else
// in the video rather than importing its own.

void main() {
  // The source normalised by the *shorter* axis, so the pattern keeps its
  // proportions in 9:16 instead of stretching.
  vec2 uv = centered(vUv, uAspect);

  float t = uTime * p_speed;

  int passes = int(clamp(p_folds, 1.0, 12.0));
  for (int i = 1; i <= 12; i++) {
    if (i > passes) break;
    float fi = float(i);
    float freq = fi * fi;
    uv.y += p_warp * sin(uv.x * freq + t) * sin(uv.y * freq + t);
  }

  // The fold height is the whole image. Centre it so the palette is sampled
  // around its middle rather than running off one end into a flat block.
  float h = uv.y * p_spread + 0.5;

  vec3 col = palClamp(h);

  // Gentle lift toward the top of the ramp, which is all the shaping this wants -
  // an edge-detect term here (fwidth on the folded coordinate) turns the highest
  // fold frequencies into aliased spikes and the effect stops being a calm one.
  col *= 0.75 + 0.45 * smoothstep(0.0, 1.0, h);

  col *= 0.94 + 0.10 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
