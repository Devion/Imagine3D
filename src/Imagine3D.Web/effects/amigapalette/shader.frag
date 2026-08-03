#include "common.glsl"

void main() {
  vec3 col = texture(uPrev, vUv).rgb;

  // Push saturation before quantising - a small palette reads as muddy otherwise.
  vec3 hsv = rgb2hsv(col);
  hsv.y = clamp(hsv.y * p_saturate, 0.0, 1.0);
  col = hsv2rgb(hsv);

  vec2 pixel = vUv * uResolution;
  float levels = max(2.0, p_levels);

  // Ordered dither before rounding: this is what turns banding into the
  // characteristic cross-hatch instead of flat posterised blocks.
  float d = (bayer4(pixel) - 0.5) * p_dither / levels;
  vec3 q = floor((col + d) * levels + 0.5) / levels;

  fragColor = vec4(mix(col, q, clamp(uAmount, 0.0, 1.0)), 1.0);
}
