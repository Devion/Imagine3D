#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Heightfield flyover. A true SDF march over ridged noise is slow to converge, so
// this raymarches the *height difference* directly - the standard heightmap trick,
// and far cheaper than sphere-tracing a noisy field.

float terrain(vec2 p) {
  return ridged(p * 0.35, 6) * p_height * 2.2 - 0.6;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  vec3 ro = vec3(sin(t * 0.05) * 3.0, p_altitude, t);
  vec3 rd = normalize(vec3(uv, 1.4));
  rd.xz = rot(sin(t * 0.03) * 0.25) * rd.xz;

  float dist = -1.0;
  float lastH = 0.0, lastD = 0.0;

  // Linear march with increasing steps, then one secant refinement. Robust for
  // heightfields where an SDF marcher would either crawl or step through ridges.
  for (int i = 0; i < 110; i++) {
    float d = 0.4 + float(i) * 0.42 + float(i) * float(i) * 0.004;
    vec3 p = ro + rd * d;
    float h = p.y - terrain(p.xz);
    if (h < 0.0) {
      // Interpolate between the last miss and this hit.
      dist = mix(lastD, d, lastH / max(1e-4, lastH - h));
      break;
    }
    lastH = h;
    lastD = d;
    if (d > 90.0) break;
  }

  vec3 sky = mix(palClamp(0.55), palClamp(0.15), sat(uv.y * 0.6 + 0.4));
  // A sun low on the horizon gives the haze something to bloom around.
  float sun = pow(max(0.0, 1.0 - length(uv - vec2(0.25, 0.05)) * 1.6), 6.0);
  sky += palClamp(0.95) * sun * 0.8;

  vec3 col;
  if (dist > 0.0) {
    vec3 p = ro + rd * dist;

    // Normal from finite differences of the heightfield.
    vec2 e = vec2(0.06, 0.0);
    vec3 n = normalize(vec3(
      terrain(p.xz - e.xy) - terrain(p.xz + e.xy),
      2.0 * e.x,
      terrain(p.xz - e.yx) - terrain(p.xz + e.yx)));

    float height = sat((p.y + 0.6) / max(0.5, p_height * 2.2));
    vec3 base = p_bands > 2.0 ? palSteps(height * 0.85 + 0.1, p_bands)
                              : palClamp(height * 0.85 + 0.1);

    vec3 lightDir = normalize(vec3(0.5, 0.55, -0.6));
    float diff = max(0.0, dot(n, lightDir));
    float sky2 = 0.35 + 0.65 * max(0.0, n.y);

    col = base * (0.25 * sky2 + 0.9 * diff);

    // Snow on the peaks that face up.
    col = mix(col, vec3(0.95), smoothstep(0.72, 0.92, height) * smoothstep(0.4, 0.8, n.y));

    // Aerial perspective into the sky colour.
    col = mix(col, sky, smoothstep(18.0, 85.0, dist));
  } else {
    col = sky;
  }

  col *= 0.92 + 0.25 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
