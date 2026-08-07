#include "common.glsl"
#include "blend.glsl"
#include "image.glsl"

// Works one of the project's images into the shot.
//
// The picture is never simply faded in. Every cue names a *treatment* - a ripple,
// the Amiga sine wave, a swirl, a kaleidoscope fold, a tunnel, torn bands, a
// mosaic, a breathing lens - which runs continuously and breathes with the track,
// and the scene already on screen pushes the picture around through its own
// luminance gradient. Without that it is a photograph laid over a demo, which is
// what this looked like before: a slow push and a beat-only ripple leaves a still
// image on screen for twenty-eight frames out of every thirty.
//
// Two placements, and they are not variations on each other - they answer
// different questions about the frame the effect has already drawn:
//
//   behind  The effect leaves most of the picture dark, so there is room for a
//           photograph underneath it. These shaders draw on black, which means
//           what they light up *is* their alpha: the image is dimmed by the
//           scene's own luminance and the scene added back on top, so the demo
//           reads as glowing in front of the picture rather than as a hole cut
//           out of it.
//
//   over    The effect already fills the frame. Nothing put behind it would ever
//           be seen, so the image goes on top through the storyboard's blend
//           operator - screen and add over hot sections, multiply and softlight
//           over cool ones. That is interference, not a backdrop, and it is
//           meant to be a few seconds long.
//
// uAmount is the cue's opacity expression, already faded in and out.

void main() {
  vec3 base = texture(uPrev, vUv).rgb;

  // Nothing bound - a cue naming an image that would not load. Leave the shot
  // exactly as it was rather than multiplying it by black.
  if (uHasImage < 0.5 || uAmount <= 0.0) {
    fragColor = vec4(base, 1.0);
    return;
  }

  vec3 img = imageWorked(
    int(p_treatment + 0.5), vUv,
    clamp(p_warp, 0.0, 1.0), uTime * max(0.05, p_speed),
    p_zoom, imageDrift(p_drift),
    p_displace,
    // Channels pulled apart on the hit, on top of whatever the treatment does.
    0.004 * uBeatPulse * (0.5 + p_warp));

  img = imageTone(img, p_tone);

  vec3 result;
  if (p_behind > 0.5) {
    // A vignette so the backdrop sits behind the shot rather than competing
    // with it at the edges, where a demo has least going on.
    float r = length(centered(vUv, uAspect)) * 0.62;
    img *= 1.0 - 0.38 * smoothstep(0.35, 1.15, r);

    // How much of the photograph the scene displaces. p_key at 0 lets the image
    // through almost everywhere; at 1 anything the effect lights up wins.
    float k = clamp(luma(base) * (0.6 + 2.4 * clamp(p_key, 0.0, 1.0)), 0.0, 1.0);
    result = min(vec3(1.0), img * (1.0 - k) + base);
  } else {
    result = blendMode(uBlendMode, base, img);

    // A little extra push through the operator on transients, the same as the
    // LTX blend does, so the layer is driven by the track rather than sitting
    // at one level for its whole run.
    result *= 1.0 + 0.3 * uBeatPulse * uEnergy;
  }

  fragColor = vec4(mix(base, clamp(result, 0.0, 1.0), clamp(uAmount, 0.0, 1.0)), 1.0);
}
