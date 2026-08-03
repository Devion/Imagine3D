#include "common.glsl"
#include "blend.glsl"

// uPrev  = the scene underneath (the one being blended out of)
// uNext  = the scene on top
// uAmount = how much of the blended result shows, already enveloped by the
//           renderer so it ramps in and out rather than popping.

void main() {
  vec3 base = texture(uPrev, vUv).rgb;
  vec3 over = texture(uNext, vUv).rgb;

  vec3 mixed = blendMode(uBlendMode, base, over);

  // At amount 0 you see only the underlying scene, at 1 only the blended result.
  // The incoming scene is never shown raw, which is the point: the two coexist.
  fragColor = vec4(mix(base, mixed, clamp(uAmount, 0.0, 1.0)), 1.0);
}
