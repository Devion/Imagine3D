#include "common.glsl"

// Value and simplex-style noise plus fBm. The bread and butter of plasma,
// clouds, terrain and anything that needs organic movement.

float valueNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i);
  float b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0));
  float d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float valueNoise3(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n = i.x + i.y * 57.0 + i.z * 113.0;
  float a = mix(hash11(n +   0.0), hash11(n +   1.0), f.x);
  float b = mix(hash11(n +  57.0), hash11(n +  58.0), f.x);
  float c = mix(hash11(n + 113.0), hash11(n + 114.0), f.x);
  float d = mix(hash11(n + 170.0), hash11(n + 171.0), f.x);
  return mix(mix(a, b, f.y), mix(c, d, f.y), f.z);
}

// Gradient noise - smoother than value noise, better for terrain and clouds.
float gradNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = dot(hash22(i + vec2(0, 0)) * 2.0 - 1.0, f - vec2(0, 0));
  float b = dot(hash22(i + vec2(1, 0)) * 2.0 - 1.0, f - vec2(1, 0));
  float c = dot(hash22(i + vec2(0, 1)) * 2.0 - 1.0, f - vec2(0, 1));
  float d = dot(hash22(i + vec2(1, 1)) * 2.0 - 1.0, f - vec2(1, 1));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) * 0.5 + 0.5;
}

float fbm(vec2 p, int octaves, float lacunarity, float gain) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * gradNoise(p);
    norm += amp;
    p *= lacunarity;
    amp *= gain;
  }
  return sum / max(norm, 1e-5);
}

float fbm(vec2 p) { return fbm(p, 5, 2.0, 0.5); }

float fbm3(vec3 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    sum += amp * valueNoise3(p);
    norm += amp;
    p *= 2.02;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}

// Ridged fBm - sharp creases, the classic look for mountain silhouettes.
float ridged(vec2 p, int octaves) {
  float sum = 0.0, amp = 0.5, norm = 0.0;
  for (int i = 0; i < 8; i++) {
    if (i >= octaves) break;
    float n = 1.0 - abs(gradNoise(p) * 2.0 - 1.0);
    sum += amp * n * n;
    norm += amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return sum / max(norm, 1e-5);
}
