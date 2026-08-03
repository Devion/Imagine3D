#include "common.glsl"
#include "palette.glsl"

// Perspective floor by direct projection: for a pixel below the horizon, the
// ground distance is a simple reciprocal of how far below it sits. No marching.

void main() {
  vec2 uv = vUv;
  float horizon = p_horizon;

  vec3 col;

  if (uv.y < horizon) {
    // ---- floor ----
    float below = horizon - uv.y;
    float z = 0.25 / max(below, 1e-4);          // distance into the scene
    float x = (uv.x - 0.5) * uAspect * z * 2.0; // widen with distance

    vec2 g = vec2(x, z + uTime * p_speed) * p_scale;
    vec2 cell = floor(g);
    float checker = mod(cell.x + cell.y, 2.0);

    vec3 a = palClamp(0.15);
    vec3 b = palClamp(0.72);
    col = mix(a, b, checker);

    // Grid lines fading out with distance.
    vec2 f = abs(fract(g) - 0.5);
    float line = smoothstep(0.46, 0.5, max(f.x, f.y));
    col = mix(col, palClamp(0.95), line * 0.35 * smoothstep(40.0, 2.0, z));

    // Fog into the horizon.
    col = mix(col, palClamp(0.35), smoothstep(3.0, 45.0, z));
  } else {
    // ---- sky ----
    float h = (uv.y - horizon) / max(0.01, 1.0 - horizon);
    col = mix(palClamp(0.4), palClamp(0.06), h);

    // Stars, denser toward the top.
    vec2 sg = vec2(uv.x * uAspect, uv.y) * 90.0;
    float star = step(0.995, hash12(floor(sg)));
    col += star * palClamp(0.9) * h * (0.5 + 0.5 * uBeatPulse);

    // Sun sitting on the horizon, reflected below.
    vec2 sunP = vec2(0.5, horizon + 0.06);
    float sun = smoothstep(0.11, 0.02, length((uv - sunP) * vec2(uAspect, 1.0)));
    col += palClamp(0.88) * sun * 1.4;
  }

  // A cheap mirror: fold the sky's sun back into the floor near the horizon.
  if (uv.y < horizon && p_reflect > 0.0) {
    vec2 mirrored = vec2(uv.x, horizon + (horizon - uv.y) * 0.6);
    vec2 sunP = vec2(0.5, horizon + 0.06);
    float sun = smoothstep(0.14, 0.02, length((mirrored - sunP) * vec2(uAspect, 1.0)));
    col += palClamp(0.85) * sun * p_reflect *
           smoothstep(0.0, 0.25, horizon - uv.y) * 0.9;
  }

  fragColor = vec4(col, 1.0);
}
