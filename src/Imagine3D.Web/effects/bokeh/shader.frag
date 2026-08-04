#include "common.glsl"
#include "palette.glsl"

// Defocus on a golden-angle spiral.
//
// The sample ring is advanced by a fixed 2.399 rad rotation and a radius that
// grows as rad += 1/rad. Both together are what make it work: the golden angle
// never repeats a bearing, and the reciprocal growth spaces the samples by equal
// *area*, so the disc is covered evenly rather than piling up in the middle. A
// naive concentric-ring kernel at this tap count shows its rings immediately.
//
// Highlights are weighted above their luminance before averaging. Without that
// a bright point spreads its energy over the whole disc and simply goes dim -
// weighting it is what makes it hold together as a disc, which is the whole
// look.
//
// Technique reference: Dave Hoskins' spiral blur, via the simplified Shadertoy.

const int TAPS = 40;
const float GOLDEN = 2.39996323;

void main() {
  vec2 uv = vUv;
  vec3 src = texture(uPrev, uv).rgb;
  float amount = clamp(uAmount, 0.0, 1.0);

  // Circle of confusion: zero on the focal band, growing away from it.
  float band = abs(uv.y - clamp(p_focus, 0.0, 1.0));
  float coc = sat((band - p_depth * 0.5) / max(p_depth, 1e-3));
  float radius = coc * p_radius * 0.045 * amount;

  if (radius < 0.0008) { fragColor = vec4(src, 1.0); return; }

  mat2 step = rot(GOLDEN);
  vec2 angle = vec2(0.0, 1.0);
  float rad = 1.0;

  vec3 acc = vec3(0.0);
  float wsum = 0.0;

  for (int i = 0; i < TAPS; i++) {
    rad += 1.0 / rad;
    angle = step * angle;
    // Divide x by aspect so the aperture stays round in pixels, not in uv.
    vec2 o = angle * (rad - 1.0) / float(TAPS) * radius * vec2(1.0 / uAspect, 1.0);
    vec3 c = texture(uPrev, uv + o).rgb;
    float w = 1.0 + p_bloom * sat(luma(c) - 0.5) * 4.0;
    acc += c * w;
    wsum += w;
  }

  vec3 col = acc / max(wsum, 1e-4);
  fragColor = vec4(mix(src, col, amount), 1.0);
}
