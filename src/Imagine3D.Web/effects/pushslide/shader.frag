#include "common.glsl"

void main() {
  float k = clamp(uAmount, 0.0, 1.0);

  // Ease with a small overshoot so the incoming scene lands with weight rather
  // than gliding to a stop.
  float e = smoothstep(0.0, 1.0, k);
  e += p_overshoot * sin(k * PI) * (1.0 - k);

  vec2 dir = vec2(cos(p_angle), sin(p_angle));
  vec2 offset = dir * e;

  // Directional blur, strongest at mid-travel where the motion is fastest.
  float speed = sin(k * PI) * p_blur * 0.06;

  vec3 prev = vec3(0.0), next = vec3(0.0);
  const int TAPS = 5;
  for (int i = 0; i < TAPS; i++) {
    float f = (float(i) / float(TAPS - 1) - 0.5) * speed;
    vec2 smear = dir * f;
    prev += texture(uPrev, clamp(vUv + offset + smear, 0.0, 1.0)).rgb;
    next += texture(uNext, clamp(vUv + offset - dir + smear, 0.0, 1.0)).rgb;
  }
  prev /= float(TAPS);
  next /= float(TAPS);

  // Which layer a pixel belongs to depends on how far along the push it is.
  float along = dot(vUv - 0.5, dir) + 0.5;
  float mask = step(along, e);

  vec3 col = mix(prev, next, mask);

  // Bright seam at the leading edge.
  col += vec3(0.5) * smoothstep(0.012, 0.0, abs(along - e)) * sin(k * PI);

  fragColor = vec4(col, 1.0);
}
