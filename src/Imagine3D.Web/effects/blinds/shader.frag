#include "common.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);

  float axis = p_vertical > 0.5 ? vUv.x : vUv.y;
  float slats = max(2.0, p_slats);

  float idx = floor(axis * slats);
  float within = fract(axis * slats);

  // Each slat starts a little after the one before it.
  float delay = (idx / slats) * p_stagger;
  float local = clamp((k - delay) / max(0.02, 1.0 - p_stagger), 0.0, 1.0);
  local = smoothstep(0.0, 1.0, local);

  // A slat opens from its centre outward.
  float openness = abs(within - 0.5) * 2.0;
  float mask = step(openness, local);

  vec3 prev = texture(uPrev, vUv).rgb;
  vec3 next = texture(uNext, vUv).rgb;
  vec3 col = mix(prev, next, mask);

  // Shade the still-closed part of each slat toward its edges, so the slats look
  // like physical louvres catching light rather than a flat stripe mask.
  if (mask < 0.5) {
    float shade = 0.55 + 0.45 * cos((within - 0.5) * PI);
    col *= shade;
  } else {
    // Thin highlight along the opening edge.
    col += vec3(0.35) * smoothstep(0.06, 0.0, local - openness) * sin(k * PI);
  }

  fragColor = vec4(col, 1.0);
}
