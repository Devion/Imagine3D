#include "common.glsl"

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));

  float axis = p_vertical > 0.5 ? vUv.y : vUv.x;
  float side = axis < 0.5 ? -1.0 : 1.0;

  // Distance from the split, 0 at the centre line, 0.5 at the frame edge.
  float fromCentre = abs(axis - 0.5);

  vec3 next = texture(uNext, vUv).rgb;

  // The doors travel outward; a pixel shows the old scene until its door passes.
  float doorEdge = k * 0.5;
  if (fromCentre < doorEdge) {
    fragColor = vec4(next, 1.0);
    return;
  }

  // Sample the outgoing scene from where that part of the door came from, so the
  // halves genuinely slide rather than being wiped away in place.
  vec2 uv = vUv;
  float shift = doorEdge * p_slide * side;
  if (p_vertical > 0.5) uv.y -= shift; else uv.x -= shift;

  vec3 prev = texture(uPrev, clamp(uv, 0.0, 1.0)).rgb;

  // Shade the inner edge of each door so they read as solid panels.
  float edge = smoothstep(0.05, 0.0, fromCentre - doorEdge);
  prev *= 1.0 - 0.45 * edge;

  fragColor = vec4(prev, 1.0);
}
