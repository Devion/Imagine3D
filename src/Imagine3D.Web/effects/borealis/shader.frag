#include "common.glsl"
#include "palette.glsl"

// Aurora curtains.
//
// Rather than marching a volume, this walks 26 horizontal sheets at increasing
// height and samples a 2D noise field on each. Because the sheets are sampled in
// depth order and blended into a running average before accumulation, the near
// ones smear over the far ones and the stack reads as one translucent curtain
// instead of 26 slices.
//
// The noise itself is a domain-warped triangle-wave ridge - triangle waves rather
// than sines because the hard fold is what gives the curtain its filaments.

const mat2 FIELD_TURN = mat2(0.95534, 0.29552, -0.29552, 0.95534);

float triangleWave(float x) {
  return clamp(abs(fract(x) - 0.5), 0.01, 0.49);
}

vec2 trianglePair(vec2 p) {
  return vec2(
    triangleWave(p.x) + triangleWave(p.y),
    triangleWave(p.y + triangleWave(p.x)));
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

// Four octaves of warp-then-ridge. Each pass displaces the point by the previous
// octave's gradient, which is what bends the curtain rather than just detailing it.
float curtainNoise(vec2 p, float phase) {
  float scale = 1.8;
  float warpScale = 1.5;
  float ridgeSum = 0.0;

  p = p * rot(-p.x * 0.1);
  vec2 base = p;

  for (int octave = 0; octave < 4; octave++) {
    vec2 gradient = trianglePair(base * 1.85) * 0.75;
    gradient = gradient * rot(-phase * 1.82);

    p -= gradient / warpScale;
    base *= 1.30;
    warpScale *= 0.45;
    scale *= 0.42;
    p *= 1.21 + (ridgeSum - 1.0) * 0.02;
    ridgeSum += triangleWave(p.x + triangleWave(p.y)) * scale;
    p = p * -FIELD_TURN;
  }

  // Reciprocal of the ridge sum: thin where the folds are tight, which inverts
  // the noise into filaments instead of blobs.
  return clamp(1.0 / pow(max(ridgeSum * 29.0, 0.001), 1.30), 0.0, 0.62);
}

float valueNoise1(float x) {
  float cell = floor(x);
  float local = fract(x);
  local = local * local * (3.0 - 2.0 * local);
  return mix(hash21(vec2(cell, cell + 17.0)), hash21(vec2(cell + 1.0, cell + 18.0)), local);
}

// The vertical striations. Two scales of 1D noise, raised to a high power so most
// of the curtain is dim and a few rays are bright.
float rayFlow(float coordinate, float time) {
  float broad = valueNoise1(coordinate * 2.7 - time * 0.16);
  float fine = valueNoise1(coordinate * 8.4 - time * 0.31);
  return 0.05 + 0.95 * pow(mix(broad, fine, 0.52), 5.0);
}

vec4 marchCurtain(vec3 ro, vec3 rd, vec2 screenUv, vec2 pixel, float evolution, float amount) {
  vec4 accumulated = vec4(0.0);
  vec4 runningAverage = vec4(0.0);

  float phaseA = evolution;
  float phaseB = evolution * 0.72 + 1.70;
  float evolutionPulse = 0.5 + 0.5 * sin(evolution * 0.28 + 0.80);
  float jitterSeed = hash21(pixel) - 0.5;

  for (int sampleIndex = 0; sampleIndex < 26; sampleIndex++) {
    float fi = float(sampleIndex);
    float h = fi / 13.0;

    float jitter = 0.01 * jitterSeed * smoothstep(0.0, 12.0, fi);
    float sheetHeight = 0.72 + pow(fi, 1.3) * 0.0025;
    sheetHeight += (0.001 + h * 0.001) * sin(phaseB * 1.15 + fi * 0.047 + screenUv.x * 1.30);

    float travel = (sheetHeight - ro.y) / (rd.y * 2.0 + 0.40);
    travel -= jitter;

    vec3 position = ro + travel * rd;
    vec2 fieldPosition = position.zx;

    float mainWarp = mix(0.43, 0.55, evolutionPulse) * amount;
    float detailWarp = mix(0.17, 0.12, evolutionPulse) * amount;
    fieldPosition.y += mainWarp * sin(fieldPosition.x * 0.34 + phaseA * 1.45);
    fieldPosition.y += detailWarp * sin(fieldPosition.x * 0.91 - phaseB * 1.25);
    fieldPosition.x += 0.075 * amount * sin(fieldPosition.y * 0.56 - phaseB * 0.92);

    // A local vortex, so the curtain has one place it visibly turns rather than
    // drifting uniformly.
    vec2 curlCenter = vec2(0.50 + 0.08 * sin(phaseB * 0.72), -0.25 + 0.06 * cos(phaseA * 0.56));
    vec2 curl = fieldPosition - curlCenter;
    float curlInfluence = exp(-dot(curl, curl) * 0.22);
    float curlStrength = (0.90 + 0.18 * sin(phaseA * 0.48 + phaseB * 0.31)) * amount;
    fieldPosition = curl * rot(-(curlStrength * curlInfluence + 0.1 * sin(phaseB))) + curlCenter;

    float density = curtainNoise(fieldPosition, phaseA * 1.35);

    float rayCoordinate = screenUv.x * 4.2 + 0.18 * sin(phaseB + screenUv.x * 60.0);
    density *= 0.72 + 0.18 * rayFlow(rayCoordinate, uTime * p_flow);

    // Three overlapping height masks give the classic green-cored, red-fringed,
    // violet-tipped banding without needing three passes.
    vec3 masks;
    masks.r = 1.0 - smoothstep(0.20, 0.58, h);
    masks.g = smoothstep(0.04, 0.34, h) * (1.0 - smoothstep(0.66, 0.94, h));
    masks.b = smoothstep(0.48, 0.98, h);

    float colorFlow = 0.5 + 0.5 * sin(position.z * 0.17 + phaseA * 1.40);
    masks.r *= mix(1.15, 0.82, colorFlow);
    masks.b *= mix(0.78, 1.18, colorFlow);

    float across = smoothstep(0.22, 0.90, screenUv.x);
    masks.r *= mix(1.28, 0.55, across);
    masks.g *= 1.08;
    masks.b *= mix(0.78, 1.72, across);
    masks /= max(dot(masks, vec3(1.0)), 0.001);

    vec4 layer = vec4(masks * density, density);
    runningAverage = mix(runningAverage, layer, 0.50);

    float depthWeight = exp2(-fi * 0.065 - 2.30) * smoothstep(0.0, 5.0, fi);
    accumulated += runningAverage * depthWeight;
  }

  float horizonFade = clamp(rd.y * 12.0 + 0.30, 0.0, 1.0);
  return accumulated * horizonFade * 1.80;
}

vec3 paintCurtain(vec3 masks) {
  vec3 lo = mix(vec3(0.00, 0.65, 0.85), pal(0.30), p_tint);
  vec3 mid = mix(vec3(0.08, 0.38, 1.00), pal(0.55), p_tint);
  vec3 hi = mix(vec3(0.32, 0.18, 0.92), pal(0.80), p_tint);
  return masks.r * lo + masks.g * mid + masks.b * hi;
}

float ellipseGlow(vec2 uv, vec2 center, vec2 scale) {
  vec2 q = (uv - center) * scale;
  return exp(-dot(q, q));
}

float sparseStars(vec2 uv, float aspect) {
  vec2 starUv = vec2(uv.x * aspect, uv.y) * 78.0;
  vec2 cell = floor(starUv);
  vec2 local = fract(starUv) - 0.5;

  float seed = hash21(cell);
  vec2 point = vec2(hash21(cell + vec2(1.7, 9.2)), hash21(cell + vec2(8.3, 2.8))) - 0.5;

  float star = 1.0 - smoothstep(0.020, 0.054, length(local - point * 0.72));
  star *= step(0.9991, seed);                       // one cell in a thousand
  star *= 0.84 + 0.16 * sin(uTime * 0.22 + seed * 24.0);
  return star;
}

void main() {
  vec2 uv = vUv;
  vec2 pixel = vUv * uResolution;
  float aspect = uAspect;

  // In a tall frame the horizontal squeeze is capped, so 9:16 gets a curtain
  // rather than a smear.
  float landscape = smoothstep(1.0, 1.65, aspect);
  float horizontalScale = mix(0.76, aspect, landscape);

  vec2 cameraPlane = vec2((uv.x - 0.5) * horizontalScale, mix(0.02, 0.54, uv.y));

  // Drifting forward and sideways. Static, the curtain only ever evolved in
  // place; the march reads a world-space field, so moving the eye is enough to
  // turn that evolution into travel.
  vec3 ro = vec3(sin(uTime * 0.06) * 1.6, 0.0, -6.7 + uTime * p_drift);
  vec3 rd = normalize(vec3(cameraPlane, 1.25));

  float evolution = uTime * 0.05 * p_speed;
  rd.xz = rd.xz * rot(-0.045 * sin(evolution * 0.70));

  vec4 raw = marchCurtain(ro, rd, uv, pixel, evolution, p_amount);

  // Three tonal layers stand in for a bloom pass: a sharp core, a soft body and a
  // wide low-exponent glow, summed before they are coloured.
  vec3 base = max(raw.rgb, vec3(0.0));
  vec3 masks = pow(base, vec3(1.48)) * 2.35
             + pow(base, vec3(1.12)) * 0.18
             + pow(base, vec3(0.70)) * 0.085;
  vec3 curtain = paintCurtain(masks);

  vec3 background = mix(vec3(0.002, 0.005, 0.018), vec3(0.006, 0.030, 0.078),
                        smoothstep(0.0, 1.0, uv.y));

  background += ellipseGlow(uv, vec2(0.04, 0.34), vec2(1.70, 1.20)) * vec3(0.000, 0.030, 0.060);
  background += ellipseGlow(uv, vec2(0.82, 0.72), vec2(1.55, 1.28)) * vec3(0.010, 0.008, 0.040);
  background += ellipseGlow(uv, vec2(0.76, 0.05), vec2(1.32, 1.72)) * vec3(0.028, 0.012, 0.068);
  background += pow(clamp(raw.a, 0.0, 1.0), 0.70) * 0.045 * vec3(0.02, 0.07, 0.13);

  vec3 stars = sparseStars(uv, aspect) * vec3(0.30, 0.50, 0.78) * 0.42 * p_stars;

  // The curtain is lifted above the source's level: three tonal layers summed and
  // then tone mapped left it sitting almost entirely in the toe of the curve.
  vec3 color = background + stars + curtain * (1.45 + 0.35 * uBeatPulse);

  vec2 edge = uv * (1.0 - uv);
  color *= mix(0.68, 1.0, pow(clamp(16.0 * edge.x * edge.y, 0.0, 1.0), 0.16));

  color = 1.0 - exp(-color);
  color = pow(max(color, vec3(0.0)), vec3(0.94));
  // Dither: the sky is a very shallow gradient and bands badly without it.
  color += (hash21(pixel) - 0.5) / 255.0;

  fragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
