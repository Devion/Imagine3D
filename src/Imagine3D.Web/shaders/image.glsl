#include "common.glsl"
#include "palette.glsl"

// Working one of the project's own images.
//
// Any effect may use these - the uniforms are in the preamble like every other -
// but four things have to be got right every time, so they live here instead of
// in each effect:
//
//   * The picture is whatever shape the camera was and the frame is 16:9 or 9:16.
//     Cover, never contain: fill the frame and crop the long axis. A photograph
//     letterboxed into a demo reads as a mistake, and a stretched one reads as a
//     worse mistake.
//   * uHasImage. An effect built around a picture draws a black frame when it is
//     rendered with none - in the gallery, on the contact sheet, in the probe -
//     and a black frame is the failure nobody notices until it is in a video.
//   * A photograph does not belong to the run's palette until it is put there.
//   * A photograph that is merely faded in and out is a photograph pasted into
//     the video. It has to be *worked*: see imageWarp.

// ---------------------------------------------------------------- framing

/// Cover-fitted texture coordinates. `zoom` above 1 pushes in; `offset` shifts
/// the framing, in image widths.
vec2 imageUv(vec2 uv, float zoom, vec2 offset) {
  vec2 c = uv - 0.5;
  if (uImageAspect > uAspect) c.x *= uAspect / uImageAspect;   // wider than the frame: crop the sides
  else                        c.y *= uImageAspect / uAspect;   // taller: crop top and bottom
  return c / max(0.05, zoom) + 0.5 + offset;
}

/// A slow wander of the framing. Seeded per run, so two videos built from the
/// same picture are not the same move across it.
vec2 imageDrift(float amount) {
  return amount * vec2(sin(uTime * 0.047 + uSeed * 3.1),
                       cos(uTime * 0.031 + uSeed * 1.7));
}

// ---------------------------------------------------------------- treatments

// What is being *done* to the picture. Each of these is a different thing, not a
// different amount of the same thing, and each one runs continuously rather than
// only on the hit - a distortion that appears for two frames on a beat and is
// otherwise absent leaves a still photograph on screen for the other 28 frames a
// second, which is exactly what "pasted in" looks like.
//
// The index order is the contract with IMAGE_TREATMENTS in engine/renderer.js.
// `amt` is 0..1 and is expected to breathe with the music; `T` is time already
// scaled by the cue's speed.

const int IMG_RIPPLE  = 0;   // concentric waves running out of the centre
const int IMG_WAVE    = 1;   // the Amiga sine distortion, both axes
const int IMG_SWIRL   = 2;   // a twist that falls off with radius, breathing
const int IMG_KALEIDO = 3;   // folded into rotating segments
const int IMG_TUNNEL  = 4;   // polar-mapped and running away from the viewer
const int IMG_SLICE   = 5;   // bands torn sideways
const int IMG_MOSAIC  = 6;   // quantised into blocks
const int IMG_BULGE   = 7;   // a lens breathing in and out of the middle

/// Warp the sampling coordinate. In and out in frame space, 0..1.
vec2 imageWarp(int mode, vec2 uv, float amt, float T) {
  vec2 c = centered(uv, uAspect);          // (0,0) centre, y spans -1..1
  float r = length(c) + 1e-4;
  vec2 dir = c / r;

  if (mode == IMG_RIPPLE) {
    // Two rates so the pattern never settles into one visible frequency.
    c += dir * (sin(r * 9.0 - T * 2.2) * 0.7 + sin(r * 21.0 - T * 3.7) * 0.3) * 0.10 * amt;

  } else if (mode == IMG_WAVE) {
    c.x += sin(c.y * 4.3 + T * 1.30) * 0.15 * amt;
    c.y += sin(c.x * 3.1 - T * 0.95) * 0.09 * amt;

  } else if (mode == IMG_SWIRL) {
    // Strongest at the centre and gone by the edge, or the whole frame simply
    // rotates and the picture reads as a turntable rather than as a twist.
    c = rot(amt * 2.1 * exp(-r * 1.3) * sin(T * 0.55)) * c;

  } else if (mode == IMG_KALEIDO) {
    // A whole number of segments, drifting slowly between counts. The fold stays
    // in its own angular wedge rather than being stretched across a half-turn,
    // so what you see is a real slice of the picture mirrored, not a smear.
    float seg = TAU / floor(mix(4.0, 9.0, 0.5 + 0.5 * sin(T * 0.11)));
    float a = mod(atan(c.y, c.x) + T * 0.22, seg);
    vec2 folded = vec2(cos(abs(a - seg * 0.5)), sin(abs(a - seg * 0.5))) * r;
    c = mix(c, folded, clamp(amt, 0.0, 1.0));

  } else if (mode == IMG_TUNNEL) {
    // Angle across the picture's width, depth down its height. Scaled by the
    // aspect so the whole width is used rather than a strip out of the middle.
    float a = atan(c.y, c.x) / PI * uAspect;
    float d = fract(0.32 / r - T * 0.24) * 2.0 - 1.0;   // repeating, receding
    c = mix(c, vec2(a, d), clamp(amt, 0.0, 1.0));

  } else if (mode == IMG_SLICE) {
    // Bands of a height that changes a few times a second, each thrown sideways
    // by its own amount. The picture stays readable; the tear is the event.
    float rows = mix(9.0, 24.0, hash11(floor(T * 0.9) + uSeed));
    float row = floor(uv.y * rows);
    c.x += (hash12(vec2(row, floor(T * 3.0) + uSeed)) - 0.5) * 1.1 * amt;

  } else if (mode == IMG_MOSAIC) {
    float n = mix(120.0, 11.0, clamp(amt, 0.0, 1.0));
    c = (floor(c * n) + 0.5) / n;

  } else if (mode == IMG_BULGE) {
    // A radial power below 1: the middle swells and the corners come in. Only
    // ever inward - an exponent above 1 pushes the corners past the edge of the
    // picture, and CLAMP_TO_EDGE turns that into a smear of one border pixel.
    c = dir * pow(r, 1.0 - amt * 0.45 * (0.5 + 0.5 * sin(T * 0.65)));
  }

  return c / vec2(uAspect, 1.0) * 0.5 + 0.5;
}

/// How much the scene already on screen pushes the picture around.
///
/// This is the difference between two layers stacked and two layers mixed: the
/// demo's own edges become a displacement map, so a raster bar sweeping past
/// drags the photograph with it instead of merely lying on top of it.
///
/// Only meaningful in a pass that has something in uPrev - a post pass over a
/// drawn scene. A scene effect calling this gets the blank texture and no push.
vec2 imageSceneDisplace(vec2 uv, float amount) {
  if (amount <= 0.0) return vec2(0.0);
  vec2 e = 2.0 / uResolution;
  float lx = luma(texture(uPrev, uv + vec2(e.x, 0.0)).rgb)
           - luma(texture(uPrev, uv - vec2(e.x, 0.0)).rgb);
  float ly = luma(texture(uPrev, uv + vec2(0.0, e.y)).rgb)
           - luma(texture(uPrev, uv - vec2(0.0, e.y)).rgb);
  return vec2(lx, ly) * 0.14 * amount;
}

// ---------------------------------------------------------------- sampling

/// Sample the image at already-warped coordinates.
///
/// textureGrad with a clamped gradient rather than a plain texture(): several of
/// the treatments fold the coordinate back on itself - the kaleidoscope seam, the
/// tunnel's repeat - and the derivative at a fold is enormous, so the hardware
/// picks the smallest mip and draws a grey line exactly where the fold was meant
/// to hide one. Clamping keeps honest minification everywhere else, which is what
/// stops a 4000-pixel photograph crawling under a slow push.
vec3 imageFetchAt(vec2 uv, float zoom, vec2 offset, float split) {
  vec2 t = imageUv(uv, zoom, offset);
  vec2 lim = vec2(0.02);
  vec2 dx = clamp(dFdx(t), -lim, lim);
  vec2 dy = clamp(dFdy(t), -lim, lim);

  if (split <= 0.0) return textureGrad(uImage, t, dx, dy).rgb;

  // Channels pulled apart along the radius, so a hard hit reads as the picture
  // being struck rather than merely moved.
  vec2 s = normalize(uv - 0.5 + 1e-5) * split;
  return vec3(
    textureGrad(uImage, t + s, dx, dy).r,
    textureGrad(uImage, t, dx, dy).g,
    textureGrad(uImage, t - s, dx, dy).b);
}

/// The whole treatment in one call: warp, the scene's own push, then the sample.
vec3 imageWorked(int mode, vec2 uv, float amt, float T, float zoom, vec2 offset,
                 float displace, float split) {
  vec2 w = imageWarp(mode, uv, amt, T) + imageSceneDisplace(uv, displace);
  return imageFetchAt(w, zoom, offset, split);
}

/// Plain cover-fitted sample, for effects doing their own displacement.
vec3 imageAt(vec2 uv) { return imageFetchAt(uv, 1.0, vec2(0.0), 0.0); }

/// The older single-purpose sampler: a beat ripple and a channel split, no
/// treatment. Kept for effects whose own motion is the point - the rotozoomer
/// and the shatter both already do far more to the picture than this would.
vec3 imageSample(vec2 uv, float zoom, vec2 offset, float warp) {
  vec2 d = uv - 0.5;
  float r = length(d) + 1e-5;
  vec2 dir = d / r;
  return imageFetchAt(uv + dir * sin(r * 22.0 - uTime * 5.0) * 0.018 * warp,
                      zoom, offset, 0.006 * warp);
}

// ---------------------------------------------------------------- grading

/// Pull the picture towards the run's palette by mapping its luminance through
/// the five stops. This is what makes a photograph belong to the video rather
/// than sit in front of it, and it is the same trick the era played with a
/// copper list.
vec3 imageTone(vec3 c, float amount) {
  return mix(c, palClamp(clamp(luma(c) * 1.05, 0.0, 0.9999)), clamp(amount, 0.0, 1.0));
}

/// Something to draw when no image is bound: the palette, moving, so an effect
/// that needs a picture is still legible in the gallery and still measures a
/// sane coverage on the probe. Never seen in a render - the director only gives
/// an image-using effect a scene when the project has images for it.
vec3 imageFallback(vec2 uv) {
  vec2 p = centered(uv, uAspect);
  float v = 0.5 + 0.5 * sin(p.x * 2.4 + uTime * 0.5) * cos(p.y * 2.1 - uTime * 0.37);
  return palClamp(clamp(v, 0.0, 0.9999)) * (0.55 + 0.45 * v);
}
