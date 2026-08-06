#include "common.glsl"
#include "blend.glsl"

// uPrev   = the outgoing scene
// uNext   = the incoming scene
// uAmount = how much of the blended result shows, already enveloped by the
//           renderer so it ramps in and out rather than popping.
// p_reveal = which of the two the frame settles on once the layer is gone.
//
// The reveal is what makes a blended boundary a *flow* rather than a cut with a
// decoration on it. A blend replaces the transition entirely - the director sets
// transitionDuration to 0 when it picks one - so if this pass only ever mixed a
// layer over the incoming scene, the first frame of the scene would be the
// incoming shot at full strength and the layer would then swell up over it: a
// hard cut, followed by a ghost. Crossfading the base underneath the layer means
// frame one of a blended scene is exactly the last frame of the one before it,
// and the picture arrives by being blended into rather than by being switched to.

void main() {
  vec3 outgoing = texture(uPrev, vUv).rgb;
  vec3 incoming = texture(uNext, vUv).rgb;

  // 0 at the cut, 1 once the incoming scene has taken over.
  vec3 base = mix(outgoing, incoming, clamp(p_reveal, 0.0, 1.0));

  // The layer itself always mixes the two, whichever way the base is leaning.
  vec3 mixed = blendMode(uBlendMode, outgoing, incoming);

  fragColor = vec4(mix(base, mixed, clamp(uAmount, 0.0, 1.0)), 1.0);
}
