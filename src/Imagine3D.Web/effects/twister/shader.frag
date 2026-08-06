#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// A forest of twisted columns, walked through rather than looked at.
//
// The column itself is the original trick and is untouched: per scanline the
// square cross-section is rotated by an angle that grows with height, the four
// corners are projected to x, and the pixel takes whichever face's span contains
// it and faces the viewer. Four cosines and no geometry.
//
// The framing is what changed. One column standing in the middle of the frame is
// a small object with two thirds of the picture doing nothing, which is fine on
// a 1990 monitor and useless behind a band. Here the same column is instanced
// down a corridor: each one has its own depth, and depth sets its screen scale,
// its horizontal position, how much of its twist fits on screen and how far it
// sinks into the fog. Columns walk toward the camera and recycle at the back, so
// the frame is always full and always moving through something.
//
// Painter's algorithm, back to front - a column nearer the camera simply
// overwrites the one behind it, which is correct because each is convex and they
// never interpenetrate.

const float FOCAL = 1.55;
const int   COLUMNS = 16;
const float FAR = 9.0;

/// Where column `i` stands, and how far away it is right now.
void columnAt(float i, float travel, out float worldX, out float z, out float seed) {
  seed = hash11(i * 7.31 + 1.0);

  // Depth recycles over FAR so the walk never ends. Each column starts at its
  // own offset down the corridor, so they arrive one at a time.
  float phase = fract(seed + travel / FAR);
  z = 0.35 + phase * FAR;

  // Lanes, spread wider than the frame so columns enter from off-screen. The
  // wander is per column and slow, so the forest is not a row of fenceposts.
  //
  // The spread is tied to depth: a lane six units wide covers the frame at the
  // back of the corridor and puts two thirds of the near columns outside it, so
  // the front of the shot goes empty exactly where the columns should be biggest.
  worldX = (fract(seed * 17.13) - 0.5) * (1.8 + z * 0.75);
  worldX += sin(travel * 0.35 + seed * 31.0) * 0.35;
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float travel = uTime * p_walk;

  // ---- the space the columns stand in ------------------------------------
  vec3 col = mix(palClamp(0.02), palClamp(0.26), sat(uv.y * 0.45 + 0.5)) * 0.75;
  col += palClamp(0.55) * exp(-abs(uv.y) * 2.6) * 0.10;                 // haze band
  col += palClamp(0.35) * fbm(uv * 1.1 + vec2(travel * 0.06, 0.0), 4, 2.0, 0.5) * 0.07;

  // Floor. A ground plane under the forest is what turns nine sprites into nine
  // objects standing somewhere - without it the depth cue is size alone.
  if (uv.y < -0.06) {
    float zf = 0.55 / max(-uv.y, 1e-3);
    vec2 g = vec2(uv.x * zf / FOCAL, zf + travel) * 0.85;
    vec2 f = abs(fract(g) - 0.5);
    float line = smoothstep(0.030 + zf * 0.004, 0.0, min(f.x, f.y));
    vec3 floorCol = palClamp(0.08) * 0.7 + palClamp(0.70) * line * 0.35;
    col = mix(col, floorCol, exp(-zf * 0.16) * 0.85);
  }

  // ---- the columns, far to near ------------------------------------------
  for (int i = 0; i < COLUMNS; i++) {
    // Reverse the visit order so nearer columns are drawn last and win.
    float fi = float(COLUMNS - 1 - i);

    float worldX, z, seed;
    columnAt(fi, travel, worldX, z, seed);
    if (z < 0.2) continue;

    float s = FOCAL / z;                 // world -> screen at this depth
    float cx = worldX * s;
    float halfW = p_width * s;

    // A column is a vertical slab; anything more than its own width away in x
    // cannot be on it, and that rejection is most of what this loop costs.
    if (abs(uv.x - cx) > halfW * 1.45 + 0.02) continue;

    // World height at this pixel, on this column's plane. Far columns fit more
    // of their twist on screen, which is exactly right.
    float worldY = uv.y / s;

    float rate = 0.75 + seed * 0.7;
    float angle = uTime * p_spin * rate + worldY * p_twist + seed * TAU;
    float sway = sin(uTime * 0.6 * rate + worldY * 1.6) * p_wobble;

    float best = 1e9;
    vec3 face = vec3(0.0);
    bool on = false;

    for (int k = 0; k < 4; k++) {
      float a0 = angle + float(k) * (PI * 0.5);
      float a1 = a0 + PI * 0.5;
      float x0 = (cos(a0) * p_width + sway) * s + cx;
      float x1 = (cos(a1) * p_width + sway) * s + cx;

      float lo = min(x0, x1), hi = max(x0, x1);
      if (uv.x < lo || uv.x > hi) continue;

      // A face is only visible when its normal points at the viewer, which for
      // this projection means the span is traversed in the +z half.
      float depth = (sin(a0) + sin(a1)) * 0.5;
      if (depth > best) continue;
      best = depth;
      on = true;

      float u = (uv.x - lo) / max(1e-4, hi - lo);
      float shade = 0.35 + 0.65 * sqrt(max(0.0, 1.0 - abs(u * 2.0 - 1.0)));
      shade *= 0.55 + 0.45 * (-depth * 0.5 + 0.5);

      vec3 c = pal(fract(float(k) * 0.25 + uTime * 0.04 + worldY * 0.11 + seed));
      face = c * shade;

      // Horizontal banding across the column, like the original's line
      // rendering - scaled with depth so a far column does not turn to moire.
      face *= 0.84 + 0.16 * step(0.5, fract(worldY * mix(26.0, 6.0, sat(z / FAR))));

      // Specular strip where the face turns edge-on to the light.
      face += palClamp(0.95) * pow(max(0.0, 1.0 - abs(u * 2.0 - 1.0)), 12.0) * 0.35;
    }

    if (!on) continue;

    // Depth grading. Near columns run hot, far ones dissolve into the same haze
    // the background is made of, so the corridor has no visible back wall.
    face *= mix(1.35, 0.55, sat(z / FAR));
    float fog = smoothstep(1.2, FAR * 0.95, z);
    col = mix(face, col, fog);
  }

  col *= 0.92 + 0.3 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
