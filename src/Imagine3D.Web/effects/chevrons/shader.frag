#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Diagonal bands raking across the frame.
//
// Three layers at different frequencies and speeds, weighted by depth, which is
// what gives parallax without a camera. Each band has a hard leading edge and a
// long trailing fade rather than being symmetric - that asymmetry is why a still
// frame still reads as moving in a particular direction.
//
// The chevron is a fold: subtracting the distance from the centre line off the
// band axis bends parallel bars into a V without a second set of bars.

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime;

  float ang = p_angle * PI;
  vec2 dir = vec2(cos(ang), sin(ang));
  vec2 perp = vec2(-dir.y, dir.x);

  float along = dot(uv, dir);
  float across = dot(uv, perp);

  vec3 col = mix(palClamp(0.12), palClamp(0.0), sat(length(uv) * 0.6));

  for (int i = 0; i < 3; i++) {
    float fi = float(i);
    float depth = 1.0 + fi * 0.9;

    float axis = along - abs(across) * p_chevron;
    float k = axis * (p_freq / depth) - t * p_speed / depth - uBarPulse * 0.3 / depth;

    float idx = floor(k);
    float b = fract(k);

    float band = smoothstep(0.0, 0.06, b) * smoothstep(1.0, 0.45, b);

    vec3 c = pal(fract(idx * 0.09 + fi * 0.21 + t * 0.02));
    float gloss = pow(sat(1.0 - abs(b - 0.32) * 3.2), 6.0);

    float layer = 1.0 / depth;   // near layers dominate, far ones fill in
    col += c * band * layer * 0.55 * p_bright;
    col += mix(c, vec3(1.0), 0.6) * gloss * band * layer * 0.5 * p_bright;
    col += vec3(1.0) * smoothstep(0.035, 0.0, b) * layer * 0.35 * p_bright;
  }

  // Speed lines: noise squashed hard across the bands and stretched along them.
  vec2 q = vec2(along * 1.2 - t * p_speed * 0.6, across * 40.0);
  float streak = fbm(q, 3, 2.0, 0.5);
  col += palClamp(0.78) * pow(sat(streak - 0.45) * 2.0, 2.0) * 0.35 * (0.4 + 0.6 * uHigh);

  col *= 0.85 + 0.4 * uBeatPulse;
  col *= 1.0 - 0.35 * sat(length(uv) * 0.55 - 0.3);

  fragColor = vec4(col, 1.0);
}
