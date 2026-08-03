#include "common.glsl"
#include "palette.glsl"

// Distinct from `fade`, which crossfades. Here the outgoing scene goes fully to
// a colour and the incoming one rises out of it, so the cut has a real beat of
// nothing in between - which is what makes it read as a scene break.

void main() {
  float k = clamp(uAmount, 0.0, 1.0);
  float hold = clamp(p_hold, 0.0, 0.6);

  // Split the window: fade out, hold, fade in. ("half" is a GLSL reserved word.)
  float leg = (1.0 - hold) * 0.5;
  vec3 through = mix(vec3(0.0), vec3(1.0), clamp(p_through, 0.0, 1.0));

  // A hint of the palette keeps a black dip from looking like dropped frames.
  through = mix(through, palClamp(p_through > 0.5 ? 0.95 : 0.06), 0.4);

  vec3 col;
  if (k < leg) {
    float f = smoothstep(0.0, 1.0, k / max(1e-4, leg));
    col = mix(texture(uPrev, vUv).rgb, through, f);
  } else if (k < leg + hold) {
    col = through;
  } else {
    float f = smoothstep(0.0, 1.0, (k - leg - hold) / max(1e-4, leg));
    col = mix(through, texture(uNext, vUv).rgb, f);
  }

  fragColor = vec4(col, 1.0);
}
