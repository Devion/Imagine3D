#include "common.glsl"
#include "blend.glsl"

// Mixes the LTX clip into the demo. uAmount is the storyboard's opacity
// expression (already faded in/out), uBlendMode selects the operator.

void main() {
  vec3 base = texture(uPrev, vUv).rgb;

  // Clips are generated at half resolution and letterboxed differently from the
  // demo; cover-fit rather than stretch so shapes stay honest.
  vec2 uv = vUv;
  vec3 src = texture(uVideo, uv).rgb;

  vec3 mixed = blendMode(uBlendMode, base, src);

  // Push a little extra energy through the blend on transients so the clip feels
  // driven by the track rather than pasted on top of it.
  float boost = 1.0 + 0.35 * uBeatPulse * uEnergy;
  fragColor = vec4(mix(base, mixed * boost, clamp(uAmount, 0.0, 1.0)), 1.0);
}
