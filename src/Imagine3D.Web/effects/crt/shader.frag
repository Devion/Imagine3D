#include "common.glsl"

void main() {
  vec2 uv = vUv;

  // Barrel distortion around the centre.
  vec2 c = uv - 0.5;
  float r2 = dot(c, c);
  uv = 0.5 + c * (1.0 + p_curve * r2);

  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Chroma bleed: the channels land on slightly different phosphors.
  float sep = p_bleed / uResolution.x;
  vec3 col = vec3(
    texture(uPrev, uv + vec2(sep, 0.0)).r,
    texture(uPrev, uv).g,
    texture(uPrev, uv - vec2(sep, 0.0)).b);

  // Scanlines at native pixel pitch.
  float line = sin(uv.y * uResolution.y * PI);
  col *= 1.0 - p_scanline * 0.5 * (1.0 - line * line);

  // Aperture grille: RGB stripes every three columns.
  float stripe = mod(floor(uv.x * uResolution.x), 3.0);
  vec3 mask = vec3(
    stripe == 0.0 ? 1.0 : 0.75,
    stripe == 1.0 ? 1.0 : 0.75,
    stripe == 2.0 ? 1.0 : 0.75);
  col *= mix(vec3(1.0), mask, p_grille);

  // Slight bloom back so the mask does not just darken the image.
  col *= 1.12;

  float vig = 1.0 - 0.8 * r2;
  col *= vig;

  vec3 base = texture(uPrev, vUv).rgb;
  fragColor = vec4(mix(base, col, clamp(uAmount, 0.0, 1.0)), 1.0);
}
