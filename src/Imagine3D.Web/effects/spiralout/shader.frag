#include "common.glsl"
#include "palette.glsl"

// The mirror of spiralin: the new scene opens from the middle and pushes the old
// one outward, with a matching zoom so it reads as being thrown at the viewer.

void main() {
  float k = smoothstep(0.0, 1.0, clamp(uAmount, 0.0, 1.0));
  vec2 p = centered(vUv, uAspect);

  float r = length(p) / 1.45;
  float a = atan(p.y, p.x) / TAU + 0.5;

  float spiral = fract(a - r * p_turns);
  float edge = k;
  float mask = smoothstep(edge - 0.06, edge + 0.06, r + spiral * 0.12);

  float twist = p_swirl * (1.0 - abs(r - edge) * 2.0) * (1.0 - k);

  // Outgoing scene is pushed out and away; incoming settles back from a zoom-in.
  vec2 uvA = (rot(twist * 0.5) * p * (1.0 + p_zoom * k)) / vec2(uAspect, 1.0) * 0.5 + 0.5;
  vec2 uvB = (rot(-twist * 0.35) * p * (1.0 - p_zoom * 0.5 * (1.0 - k))) / vec2(uAspect, 1.0) * 0.5 + 0.5;

  vec3 prev = texture(uPrev, clamp(uvA, 0.0, 1.0)).rgb;
  vec3 next = texture(uNext, clamp(uvB, 0.0, 1.0)).rgb;

  // mask is 1 outside the boundary, so the incoming scene lives inside it.
  vec3 col = mix(next, prev, mask);

  float rim = smoothstep(0.05, 0.0, abs(r + spiral * 0.12 - edge));
  col += pal(fract(a - uTime * 0.1)) * rim * 0.85 * sin(k * PI);

  fragColor = vec4(col, 1.0);
}
