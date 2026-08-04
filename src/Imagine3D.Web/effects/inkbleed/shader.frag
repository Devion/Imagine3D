#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Wet ink on paper.
//
// Three things have to happen together or it just looks like a smear filter.
// Colour is dragged *along a run* rather than blurred isotropically; the run
// wanders, because its direction is the gradient of a noise field and not
// straight down; and the front is darker than what is behind it, because solute
// piles up where the paper is still drying. The frame-to-frame creep through
// uFeedback is what makes it accumulate instead of resetting every frame.

// Direction the ink runs at this point. Gravity sets the bias; the noise
// gradient makes it split into veins on the way down.
vec2 runDirection(vec2 uv, float t) {
  const vec2 e = vec2(0.0035, 0.0);
  vec2 s = vec2(0.0, -t * 0.2);
  float n0 = fbm(uv * 7.0 + s, 4, 2.1, 0.55);
  float nx = fbm((uv + e.xy) * 7.0 + s, 4, 2.1, 0.55);
  float ny = fbm((uv + e.yx) * 7.0 + s, 4, 2.1, 0.55);
  vec2 grad = vec2(nx - n0, ny - n0) / e.x;
  return normalize(vec2(grad.x * 0.9, grad.y * 0.5 - 1.6) + 1e-5);
}

void main() {
  vec2 uv = vUv;
  float t = uTime * p_speed;
  float amount = clamp(uAmount, 0.0, 1.0);

  vec3 src = texture(uPrev, uv).rgb;

  // Where the paper is wet. Low frequency and slow: bleeding happens to
  // regions, not to pixels, and a fast field here reads as boiling noise.
  float raw = fbm(vec2(uv.x * 3.0, uv.y * 2.2 - t * 0.10), 4, 2.2, 0.55);
  float wet = sat((raw - 0.40) * 2.6) * p_wet;
  if (wet * amount < 0.004) { fragColor = vec4(src, 1.0); return; }

  vec2 flow = runDirection(uv, t);
  float reach = p_bleed * 0.05 * wet * amount;

  // Gather back along the run, so colour arrives here from where it came rather
  // than leaving. Weighted toward the near end - the far end of a run is thin.
  vec3 run = vec3(0.0);
  float wsum = 0.0;
  for (int i = 1; i <= 6; i++) {
    float f = float(i) / 6.0;
    float w = 1.0 - f * 0.62;
    run += texture(uPrev, uv - flow * reach * f).rgb * w;
    wsum += w;
  }
  run /= wsum;

  // Frame-to-frame creep: sample the finished previous frame from *up* the run,
  // so ink keeps travelling across frames and long streaks build up.
  vec3 crept = texture(uFeedback, uv - flow * p_drip * 0.006).rgb;

  vec3 col = mix(src, run, wet * amount);
  col = mix(col, max(col, crept * 0.94), sat(p_drip) * wet * amount * 0.55);

  // The drying front: a band either side of the wet threshold. Ink piles up
  // there, so it darkens and takes on the deepest stop of the palette.
  float front = smoothstep(0.0, 0.16, raw - 0.40) * smoothstep(0.42, 0.16, raw - 0.40);
  float f = front * p_stain * amount;
  col *= 1.0 - 0.32 * f;
  col = mix(col, col * palClamp(0.55) * 1.6, 0.35 * f);

  // Paper tooth, only where it is wet - dry paper has no visible grain here.
  col *= 1.0 - 0.06 * wet * amount * valueNoise(uv * vec2(uResolution.x, uResolution.y) * 0.35);

  fragColor = vec4(col, 1.0);
}
