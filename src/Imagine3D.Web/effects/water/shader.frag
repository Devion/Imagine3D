#include "common.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Summed circular wavefronts. Each "drop" is a decaying radial sine; the surface
// normal comes from the analytic gradient, which is what lets the highlights be
// sharp without a heightmap texture.

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime * p_speed;

  float height = 0.0;
  vec2 grad = vec2(0.0);

  int n = int(clamp(p_drops, 1.0, 10.0));
  for (int i = 0; i < 10; i++) {
    if (i >= n) break;
    float fi = float(i);

    // Drops land at scattered points, restarting on their own cycle.
    float cycle = 3.4 + hash11(fi) * 2.6;
    float age = mod(t + fi * 1.9, cycle);
    vec2 c = (hash22(vec2(fi, floor((t + fi * 1.9) / cycle))) - 0.5) * vec2(1.7 * uAspect, 1.5);

    vec2 d = uv - c;
    float r = length(d) + 1e-4;

    // Each drop is tuned to its own band, so what strikes the surface is
    // whatever is playing in that part of the mix. A hi-hat pattern ripples in
    // the fine drops while the kick drives the broad ones, which is a surface
    // being played rather than a surface being turned up.
    float bandX = fi / max(1.0, float(n - 1));
    float band = spectrumNow(bandX);
    float strike = spectrumHit(bandX);

    float phase = r * 14.0 - age * 7.0;
    float envelope = exp(-r * 1.9) * exp(-age * 0.85) * (0.45 + 0.85 * band + 0.50 * strike);

    height += sin(phase) * envelope;
    grad += (d / r) * cos(phase) * 14.0 * envelope;
  }

  height *= p_amplitude;
  grad *= p_amplitude;

  vec3 normal = normalize(vec3(-grad * 0.06, 1.0));

  // Base water colour shifted by the refracted "depth".
  vec3 col = palClamp(0.28 + height * 0.16);

  vec3 lightDir = normalize(vec3(0.4, 0.75, 0.5));
  float spec = pow(max(0.0, dot(normal, lightDir)), 48.0);
  col += palClamp(0.95) * spec * 1.5;

  // Caustics: bright where the surface focuses light, i.e. where curvature is high.
  float caustic = pow(max(0.0, 1.0 - length(grad) * 0.05), 6.0);
  col += palClamp(0.85) * caustic * p_caustic * 0.5;

  float fres = pow(1.0 - normal.y, 3.0);
  col += palClamp(0.6) * fres * 0.3;

  col *= 0.9 + 0.25 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
