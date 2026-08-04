#include "common.glsl"
#include "palette.glsl"

// Volumetric flame, after anatole duprat's 2013 shader.
//
// The body is a squashed sphere whose surface is eaten into by noise scaled by
// height, so the erosion grows toward the tip and the silhouette tapers on its
// own. Nothing is shaded: the march counts how many steps happened *inside* the
// flame and that count is the brightness, which is why it reads as emissive.

// The source's noise - four cosine-interpolated hashes. Kept rather than swapped
// for the shared fBm because its slightly wrong, blocky character is a lot of
// what makes the flame look like flame.
float flameNoise(vec3 p) {
  vec3 i = floor(p);
  vec4 a = dot(i, vec3(1.0, 57.0, 21.0)) + vec4(0.0, 57.0, 21.0, 78.0);
  vec3 f = cos((p - i) * acos(-1.0)) * (-0.5) + 0.5;
  a = mix(sin(cos(a) * a), sin(cos(1.0 + a) * (1.0 + a)), f.x);
  a.xy = mix(a.xz, a.yw, f.y);
  return mix(a.x, a.y, f.z);
}

float sphere(vec3 p, vec4 spr) {
  return length(spr.xyz - p) - spr.w;
}

float flame(vec3 p) {
  float d = sphere(p * vec3(1.0, 0.5, 1.0), vec4(0.0, -1.0, 0.0, 1.0));
  // Scaling the erosion by p.y is what tapers the flame - the noise barely
  // touches the base and tears the tip apart.
  return d + (flameNoise(p + vec3(0.0, uTime * p_speed, 0.0))
            + flameNoise(p * 3.0) * 0.5) * p_turbulence * (p.y);
}

float scene(vec3 p) {
  return min(100.0 - length(p), abs(flame(p)));
}

vec4 march(vec3 org, vec3 dir) {
  float d = 0.0, glow = 0.0, eps = 0.02;
  vec3 p = org;
  bool glowed = false;

  for (int i = 0; i < 64; i++) {
    d = scene(p) + eps;
    p += d * dir;
    if (d > eps) {
      if (flame(p) < 0.0) glowed = true;
      // Once the ray has been inside the flame, the step index becomes the
      // brightness - deeper penetration means a longer path through the body.
      if (glowed) glow = float(i) / 64.0;
    }
  }
  return vec4(p, glow);
}

void main() {
  vec2 v = centered(vUv, uAspect);

  vec3 org = vec3(0.0, -2.0, 4.0);
  // The y negation is load-bearing and stays. The noise erosion is scaled by p.y
  // and the body sits at negative y, so the ragged end of the ellipsoid is its
  // *low* end; negating y points the top of the frame at it, which is what puts
  // the licks above a solid base. Without it the flame renders as a blob hanging
  // from the ceiling.
  vec3 dir = normalize(vec3(v.x * 1.6, -v.y, -1.5));

  vec4 hit = march(org, dir);
  float glow = hit.w;

  // Height across the flame body, which the original used to run orange at the
  // base into blue at the tip.
  float h = clamp(hit.y * 0.02 + 0.4, 0.0, 1.0);
  vec3 native = mix(vec3(1.0, 0.5, 0.1), vec3(0.1, 0.5, 1.0), h);
  vec3 col = mix(native, palClamp(1.0 - h), p_tint);

  // The fourth power is the source's, and it matters: it crushes the faint
  // outer glow to black so the flame has an edge instead of a haze.
  col *= pow(clamp(glow * p_glow, 0.0, 1.0), 4.0);

  fragColor = vec4(col, 1.0);
}
