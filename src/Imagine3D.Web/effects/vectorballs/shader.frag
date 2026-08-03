#include "common.glsl"
#include "palette.glsl"

// Sprite-based 3D. Each ball is projected to screen space and shaded as a sphere;
// the nearest one wins per pixel, which is exactly the painter's-algorithm sprite
// approach the originals used, just resolved per fragment instead of per blit.

vec3 ballPosition(float i, float n, float t, float shape) {
  float f = i / n;
  if (shape < 0.5) {
    // Double helix.
    float a = f * TAU * 2.0 + t;
    float side = mod(i, 2.0) * PI;
    return vec3(cos(a + side) * 0.55, (f - 0.5) * 1.7, sin(a + side) * 0.55);
  } else if (shape < 1.5) {
    // Flat ring, tilted.
    float a = f * TAU + t;
    vec3 p = vec3(cos(a) * 0.75, 0.0, sin(a) * 0.75);
    p.yz = rot(0.5) * p.yz;
    return p;
  }
  // Fibonacci sphere shell.
  float phi = acos(1.0 - 2.0 * (i + 0.5) / n);
  float theta = PI * (1.0 + sqrt(5.0)) * i + t;
  return vec3(sin(phi) * cos(theta), sin(phi) * sin(theta), cos(phi)) * 0.8;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_spin;

  vec3 col = palClamp(0.04) * (1.0 - 0.4 * length(uv));

  float n = clamp(p_count, 6.0, 48.0);
  float bestZ = 1e9;

  for (int i = 0; i < 48; i++) {
    if (float(i) >= n) break;
    float fi = float(i);

    vec3 p = ballPosition(fi, n, t, p_shape);

    // Rotate the whole formation.
    p.xz = rot(t * 0.8) * p.xz;
    p.yz = rot(sin(t * 0.4) * 0.6) * p.yz;

    // Perspective projection.
    float z = p.z + 2.6;
    if (z < 0.15) continue;
    vec2 sp = p.xy * (2.0 / z);
    float r = p_radius * (2.0 / z);

    vec2 d = uv - sp;
    float dist = length(d);
    if (dist > r) continue;
    if (z > bestZ) continue;      // something nearer already covers this pixel
    bestZ = z;

    // Sphere normal from the sprite's own disc, so it shades like geometry.
    float k = sqrt(max(0.0, 1.0 - (dist / r) * (dist / r)));
    vec3 normal = normalize(vec3(d / r, k));

    vec3 lightDir = normalize(vec3(-0.4, 0.6, 0.7));
    float diff = max(0.0, dot(normal, lightDir));
    float spec = pow(max(0.0, dot(normal, normalize(lightDir + vec3(0.0, 0.0, 1.0)))), 32.0);

    vec3 base = pal(fract(fi / n + uTime * 0.05));
    vec3 ball = base * (0.2 + 0.85 * diff) + vec3(spec) * 0.7;

    // Darken with distance so the formation reads in depth.
    ball *= mix(1.15, 0.4, sat((z - 1.6) / 2.4));

    col = ball;
  }

  col *= 0.9 + 0.3 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
