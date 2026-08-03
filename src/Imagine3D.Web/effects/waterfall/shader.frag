#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// A waterfall built from vertically advected noise.
//
// Water reads as water because of *streaks*: noise stretched hard along the fall
// direction, layered at several speeds so near and far sheets separate, with
// foam where the flow is fastest and mist where it lands.

float sheet(vec2 uv, float speed, float stretch, float t) {
  // Squash y hard so the noise becomes vertical filaments rather than blobs.
  vec2 p = vec2(uv.x * stretch, uv.y * 0.35 - t * speed);
  return fbm(p, 4, 2.1, 0.55);
}

void main() {
  vec2 uv = vUv;
  float t = uTime * p_flow;

  float poolTop = clamp(p_pool, 0.05, 0.6);

  // Rock walls either side; the water column narrows slightly as it falls.
  float halfW = p_width * 0.5 * (1.0 - 0.12 * (1.0 - uv.y));
  float fromCentre = abs(uv.x - 0.5);
  float inFall = smoothstep(halfW, halfW - 0.06, fromCentre);

  vec3 col;

  // ---- rock behind and beside the fall ----
  float rockN = fbm(vec2(uv.x * 6.0, uv.y * 3.0), 4, 2.0, 0.5);
  vec3 rock = palClamp(0.06 + rockN * 0.16) * (0.55 + 0.45 * rockN);
  rock *= 0.6 + 0.4 * smoothstep(0.0, 0.6, uv.y);
  col = rock;

  if (uv.y > poolTop) {
    // ---- falling water ----
    float a = sheet(uv, 1.0, 3.0, t);
    float b = sheet(uv + vec2(0.31, 0.0), 1.6, 5.0, t);
    float c = sheet(uv + vec2(0.67, 0.0), 2.4, 8.0, t);

    float water = a * 0.45 + b * 0.35 + c * 0.20;

    // Water accelerates as it falls, so streaks lengthen and brighten downward.
    float accel = smoothstep(1.0, poolTop, uv.y);
    water = mix(water, water * 1.25, accel);

    vec3 wet = palClamp(0.32 + water * 0.4);

    // Foam: the brightest filaments blow out to white.
    float foam = smoothstep(0.62, 0.9, water) * p_foam;
    wet += vec3(0.85, 0.92, 1.0) * foam * (0.5 + 0.6 * accel);

    // Thin dark gaps between sheets give it depth.
    wet *= 0.7 + 0.5 * smoothstep(0.25, 0.6, water);

    col = mix(col, wet, inFall);

    // Spray blowing off the edges of the column.
    float edge = smoothstep(halfW + 0.09, halfW - 0.02, fromCentre) * (1.0 - inFall);
    float spray = fbm(vec2(uv.x * 14.0, uv.y * 5.0 - t * 2.2), 3, 2.0, 0.5);
    col += vec3(0.8, 0.88, 1.0) * edge * smoothstep(0.55, 0.85, spray) * 0.5;
  }

  // ---- splash pool ----
  if (uv.y <= poolTop) {
    float depth = (poolTop - uv.y) / max(0.01, poolTop);

    // Concentric churn where the column lands, plus general surface motion.
    float impact = smoothstep(0.35, 0.0, fromCentre);
    float churn = fbm(vec2(uv.x * 9.0 - t * 0.4, uv.y * 22.0 + t * 1.8), 4, 2.0, 0.55);
    float rings = sin((fromCentre * 26.0 - t * 5.0)) * 0.5 + 0.5;

    vec3 water = palClamp(0.24 + churn * 0.3);
    water += vec3(0.8, 0.9, 1.0) * smoothstep(0.68, 0.95, churn) * impact * p_foam * 0.9;
    water += palClamp(0.85) * rings * impact * 0.18 * (1.0 - depth);

    // A blurred reflection of the fall, fading with depth.
    float refl = sheet(vec2(uv.x, poolTop + (poolTop - uv.y) * 1.4), 1.0, 3.0, t);
    water += palClamp(0.6) * refl * 0.22 * (1.0 - depth) * inFall;

    col = mix(water, palClamp(0.08), depth * 0.55);
  }

  // ---- mist rising from the impact ----
  float mistBand = smoothstep(poolTop + 0.38, poolTop - 0.05, uv.y);
  float mistN = fbm(vec2(uv.x * 3.4 + t * 0.15, uv.y * 4.0 - t * 0.5), 4, 2.0, 0.55);
  float mist = mistBand * smoothstep(0.35, 0.85, mistN) * p_mist;
  col = mix(col, palClamp(0.75), clamp(mist * 0.55, 0.0, 0.75));

  // Light from above, so the top of the frame is brightest.
  col *= 0.65 + 0.5 * smoothstep(0.0, 1.0, uv.y);
  col *= 0.92 + 0.22 * uBeatPulse;

  fragColor = vec4(col, 1.0);
}
