#include "common.glsl"
#include "image.glsl"

// The rotozoomer, over one of the project's images instead of a generated tile.
//
// This is the effect that let a 1990 intro show you a picture at all: rotate and
// scale the sampling coordinate, tile it, and let the hardware do the rest. It
// is also the one place a photograph can be tiled without looking like wallpaper,
// because it is always turning.
//
// Mirrored at the tile edges rather than repeated, so a picture meets its own
// reflection instead of a hard seam down the middle of it.

vec3 tiled(vec2 p) {
  // Tiles keep the picture's own shape rather than being square - repeat a photo
  // into a square cell and every face in it comes out stretched.
  vec2 q = vec2(p.x / max(0.05, uImageAspect), p.y);
  vec2 f = 1.0 - abs(fract(q * 0.5) * 2.0 - 1.0);

  // Mirroring folds the coordinate back on itself, and the derivative at that
  // fold is enormous: a plain texture() picks the smallest mip along every tile
  // edge and draws a grey seam exactly where the fold was meant to hide one.
  // The gradient of the *unfolded* coordinate is the honest one.
  return textureGrad(uImage, f, dFdx(q), dFdy(q)).rgb;
}

void main() {
  vec2 uv = centered(vUv, uAspect);

  vec2 p = rot(uTime * p_spin) * uv * p_zoom * p_tiles;
  p += vec2(cos(uTime * p_drift), sin(uTime * p_drift * 0.83)) * 2.0;

  vec3 col = uHasImage > 0.5 ? tiled(p) : imageFallback(vUv);
  col = imageTone(col, p_tone);

  // Radial darkening keeps the centre of rotation readable - without it a
  // full-frame photograph spinning has no centre to hold on to.
  col *= 1.0 - 0.35 * length(uv) * 0.5;
  col *= 0.82 + 0.34 * uBeatPulse;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
