#include "common.glsl"
#include "image.glsl"

// One of the project's images, torn apart on the transients.
//
// Bands rather than per-pixel noise. A photograph broken into horizontal strips
// and pushed sideways is still recognisably that photograph - the tear is the
// thing the eye follows - where a per-pixel scramble is just static, and static
// is not a picture of anything.
//
// It fires on the hit and settles between hits. A tear that runs continuously
// stops being an event within about four seconds and the scene becomes noise.

void main() {
  float hit = clamp(p_shatter, 0.0, 1.5);

  // The band height changes a few times a second, so a long scene never settles
  // into a fixed grid the eye can start reading as the subject.
  float era = floor(uTime * 2.7) + uSeed;
  float rows = mix(7.0, 26.0, hash11(era));

  float row = floor(vUv.y * rows);
  float r = hash12(vec2(row, floor(uTime * 5.0) + uSeed));

  vec2 uv = vUv;
  uv.x += (r - 0.5) * 2.0 * hit * p_tear;

  vec3 col = uHasImage > 0.5
    ? imageSample(uv, p_zoom, imageDrift(p_drift), p_warp)
    : imageFallback(uv);
  col = imageTone(col, p_tone);

  // Every few bands drops out of the picture entirely and shows the palette
  // instead - the signal missing rather than the picture being wrong.
  float drop = step(0.87, r) * smoothstep(0.15, 0.6, hit);
  col = mix(col, palClamp(fract(r * 1.7 + uTime * 0.08)) * (0.35 + 0.65 * uRms), drop * 0.8);

  // A lift along the band boundary, so a tear is legible as an edit rather than
  // as the whole frame wobbling. Anti-aliased in pixel units - a band edge is a
  // full-width horizontal line, which is the one thing in this library that has
  // to be measured in pixels rather than in fractions of the shape - falling off
  // towards the sides so it never meets the frame edge as a contrast step, and
  // modulating what is already there rather than drawing over it.
  float band = fract(vUv.y * rows);
  float px = rows * 1.5 / uResolution.y;
  float edge = smoothstep(px, 0.0, min(band, 1.0 - band));
  float sides = smoothstep(0.0, 0.22, min(vUv.x, 1.0 - vUv.x));
  col *= 1.0 + edge * sides * hit * abs(r - 0.5) * 1.6;

  col *= 0.88 + 0.3 * uBeatPulse;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}
