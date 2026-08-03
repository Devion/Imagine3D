#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// Layered starfield flying toward the camera.
//
// Each layer is a jittered grid of cells at its own depth. Stars are drawn as an
// inverse-distance glow rather than a hard disc: a smoothstep dot of a fixed
// radius is sub-pixel at these cell scales and renders as a nearly black frame.

void main() {
  vec2 uv = centered(vUv, uAspect);

  // Barrel warp on the downbeat - the frame lurches without the camera moving.
  uv *= 1.0 + p_warp * dot(uv, uv) * 0.25;

  vec3 col = vec3(0.0);
  const int LAYERS = 6;

  for (int i = 0; i < LAYERS; i++) {
    float fi = float(i);

    // Depth cycles 0..1; each layer runs at its own rate, which is the parallax.
    float z = fract(uTime * p_speed * (0.06 + 0.035 * fi) + fi * 0.171);

    // Far layers pack many small cells, near layers few large ones.
    float scale = mix(26.0, 3.0, z);
    float fade = smoothstep(0.0, 0.18, z) * smoothstep(1.0, 0.55, z);

    vec2 g = uv * scale + fi * 37.13;
    vec2 cell = floor(g);
    vec2 f = fract(g) - 0.5;

    float bright = hash12(cell + fi * 23.7);
    if (bright < 1.0 - p_density / 200.0) continue;

    vec2 offset = f - (hash22(cell + fi * 11.3) - 0.5) * 0.8;

    // Smear along the direction of travel, which is radially outward.
    vec2 dir = normalize(uv + 1e-4);
    float along = dot(offset, dir);
    float across = length(offset - dir * along);
    float d = length(vec2(along / (1.0 + p_streak * 6.0), across));

    // Inverse-distance glow: bright core, soft halo, and it survives the cell
    // scale changing by an order of magnitude between layers.
    float glow = 0.05 / (d + 0.05);
    float star = pow(glow, 1.6) * fade * (0.5 + bright * 1.1);

    // Stars sit in the bright half of the palette, so a dark palette still
    // produces visible stars rather than a black frame.
    col += palClamp(0.55 + 0.45 * hash11(bright * 91.0)) * star;
  }

  col *= 2.1;

  // Faint nebula so the background is never a dead flat black.
  float neb = fbm(uv * 1.4 + vec2(uTime * 0.02, 0.0), 4, 2.0, 0.5);
  neb = smoothstep(0.45, 0.85, neb);
  col += palClamp(0.2 + 0.3 * neb) * neb * 0.28;

  col *= 0.8 + 0.5 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
