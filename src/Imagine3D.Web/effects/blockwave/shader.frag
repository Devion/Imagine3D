#include "common.glsl"
#include "palette.glsl"
#include "sdf.glsl"

// An infinite grid of columns whose heights come from the music.
//
// Domain repetition puts a box in every cell for one distance evaluation, and
// the height is a pure function of the cell index - so the "equaliser" is
// generated rather than stored, and the grid can run to the horizon.

float gSpacing, gHeight, gWave, gSpeed;

float columnHeight(vec2 cell) {
  // Per-column randomness, so the grid never looks like a plain sine sheet.
  float seed = hash12(cell);

  // A wave travelling outward from the origin.
  float d = length(cell);
  float travel = sin(d * 0.55 - uTime * gSpeed * 3.0) * 0.5 + 0.5;

  // Rows nearer the camera answer to the bass, further rows to the highs, which
  // is what makes it read as a spectrum rather than random motion.
  float depth = fract(cell.y * 0.12 + 0.5);
  float band = mix(uBass, uHigh, depth);

  float h = 0.25 + travel * gWave * 0.35 + band * 0.9 + seed * 0.35;
  return h * gHeight * 0.5;
}

float map(vec3 p) {
  // Fly forward over the grid.
  p.z += uTime * gSpeed * 2.0;

  vec2 cell = floor(p.xz / gSpacing);
  vec2 local = mod(p.xz, gSpacing) - gSpacing * 0.5;

  float h = columnHeight(cell);

  // Box standing on the ground plane, so growth is upward not centred.
  vec3 q = vec3(local.x, p.y - h * 0.5, local.y);
  float box = sdBox(q, vec3(gSpacing * 0.34, h * 0.5, gSpacing * 0.34));

  float ground = p.y + 0.02;
  return min(box, ground);
}

void main() {
  gSpacing = max(0.4, p_spacing);
  gHeight = p_height;
  gWave = p_wave;
  gSpeed = p_speed;

  vec2 uv = centered(vUv, uAspect);

  vec3 ro = vec3(0.0, 2.1 + 0.4 * sin(uTime * 0.2), -4.5);
  vec3 target = vec3(0.0, 0.9, 2.0);
  mat3 cam = lookAt(ro, target, sin(uTime * 0.13) * 0.06);
  vec3 rd = normalize(cam * vec3(uv, 1.5));

  int steps;
  float t = raymarch(ro, rd, 42.0, int(clamp(p_steps, 24.0, 160.0)), steps);

  vec3 col;
  if (t < 42.0) {
    vec3 pos = ro + rd * t;
    vec3 n = calcNormal(pos, 0.004);

    vec3 lightDir = normalize(vec3(0.4, 0.85, -0.35));
    float diff = max(0.0, dot(n, lightDir));
    float ao = ambientOcclusion(pos, n);
    float fres = pow(1.0 - max(0.0, dot(n, -rd)), 4.0);

    // Height drives colour, so a pumping column sweeps up the palette as it grows.
    float hgt = clamp(pos.y / max(0.4, gHeight), 0.0, 1.0);
    vec3 base = palClamp(0.12 + hgt * 0.8);

    col = base * (0.15 * ao + 0.85 * diff);
    col += palClamp(0.95) * fres * 0.5;

    // Bright top faces read as glowing caps on the peaks.
    col += base * smoothstep(0.7, 1.0, n.y) * hgt * 0.8;

    col = mix(col, palClamp(0.03), smoothstep(12.0, 38.0, t));
  } else {
    col = mix(palClamp(0.3), palClamp(0.02), sat(uv.y * 0.8 + 0.4));
  }

  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
