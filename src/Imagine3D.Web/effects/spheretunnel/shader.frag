#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Rings of tubes in a polar field, viewed through a spherical inversion.
//
// The trick is in the march, not the SDF: before evaluating, each sample's xy is
// divided by |1 - r^2|, which sends the plane through a sphere. Inside the unit
// radius the sign flips and the same geometry unwraps the other way, so the
// horizon is a hard edge with a convex world outside and a concave one within -
// and the colour is inverted across it to make the boundary read.

#define STEPS 70

// Tube field. The polar transform turns the x axis into an angle, so the tubes
// wrap into rings; each ring is a different y and counter-rotates at its own rate.
float map(vec3 u, float v, float t, float amp) {
  float l = 5.0;           // rings per repeat, kept low to reduce clipping
  float f = 1e10;

  u.xy = vec2(atan(u.x, u.y), length(u.xy));
  u.x += t * v * PI * 0.7;

  for (float i = 1.0; i <= l; i++) {
    vec3 p = u;

    float y = round((p.y - i) / l) * l + i;
    p.x *= y;
    p.x -= y * y * t * PI;
    p.x -= round(p.x / TAU) * TAU;
    p.y -= y;

    float z = cos(y * t * TAU) * 0.5 + 0.5;

    f = min(f, max(length(p.xy), -p.z - z * amp) - 0.1 - z * 0.2 - p.z / 100.0);
  }
  return f;
}

void main() {
  float t = uTime * p_speed / 300.0;
  float amp = p_amplitude;

  vec2 m = vec2(0.0, p_offset);

  vec3 o = vec3(0.0, 0.0, -130.0);
  vec3 dir = normalize(vec3((vUv - 0.5) * vec2(uAspect, 1.0), 1.0));

  float v = -o.z / 3.0;      // pattern scale

  vec3 c = vec3(0.0);
  vec3 p = vec3(0.0), k = vec3(0.0);
  float d = 0.0, s = 0.0, f = 0.0, z = 0.0, r = 0.0;
  bool inside = false;

  for (int i = 0; i < STEPS; i++) {
    p = dir * d + o;

    p.xy /= v;
    r = length(p.xy);
    z = abs(1.0 - r * r);
    inside = r < 1.0;
    if (inside) z = sqrt(z);

    p.xy /= z + 1.0;          // spherize
    p.xy -= m;
    p.xy *= v;

    // A slow lateral wave so the shaft is not perfectly straight.
    p.xy -= cos(p.z / 8.0 + t * 300.0 + vec2(0.0, 1.5708) + z / 2.0) * 0.2;

    s = map(p, v, t, amp);

    r = length(p.xy);
    f = cos(round(r) * t * TAU) * 0.5 + 0.5;

    vec3 hue = cos(radians(vec3(180.0, 90.0, 0.0)) + (0.2 - f / 3.0 + t + p.z / 200.0) * TAU) * 0.5 + 0.5;
    k = mix(hue, pal(0.2 - f / 3.0 + t + p.z / 200.0), p_tint);
    if (inside) k = 1.0 - k;

    // Accumulating inside the march rather than shading the hit gives softer
    // edges - each near-miss still contributes a little light.
    c += min(exp(s / -0.05), s)
       * (f + 0.01)
       * min(z, 1.0)
       * sqrt(cos(r * TAU) * 0.5 + 0.5)
       * k * k;

    // Shorter steps near the sphere edge, where the inversion compresses space.
    d += s * clamp(z, 0.3, 0.9);
    if (s < 1e-3 || d > 1e3) break;
  }

  // The source sampled a texture here for a faint aqua wash. Value noise over the
  // same coordinate keeps the texture without needing a channel bound.
  float wash = valueNoise3((dir * d + o) * 0.35);
  c += wash * vec3(0.0, 0.4, s) * s * z * 0.03;

  // Bright tips where the tubes end.
  c += min(exp(-p.z - f * amp) * z * k * 0.01 * p_glow / max(s, 1e-4), 1.0);

  vec2 j = p.xy / v + m;
  c /= clamp(dot(j, j) * 4.0, 0.04, 4.0);

  fragColor = vec4(pow(max(c, 0.0), vec3(1.0 / 2.2)), 1.0);
}
