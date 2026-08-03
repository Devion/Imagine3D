#include "common.glsl"

vec3 radialSample(sampler2D tex, vec2 uv, float strength) {
  vec3 sum = vec3(0.0);
  const int N = 8;
  for (int i = 0; i < N; i++) {
    float s = 1.0 + strength * (float(i) / float(N));
    sum += texture(tex, (uv - 0.5) / s + 0.5).rgb;
  }
  return sum / float(N);
}

void main() {
  float k = clamp(uAmount, 0.0, 1.0);
  float e = smoothstep(0.0, 1.0, k);

  // Outgoing: accelerates toward the viewer and smears.
  vec3 a = radialSample(uPrev, vUv, -0.6 * e);
  // Incoming: settles back from an over-zoom.
  vec3 b = radialSample(uNext, vUv, 0.35 * (1.0 - e));

  vec3 col = mix(a, b, e);
  col *= 1.0 + 0.6 * sin(k * PI);   // brief overexposure at the impact
  fragColor = vec4(col, 1.0);
}
