#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// The well, from the inside.
//
// The original drew seven pieces falling down a flat board. On a 1080p frame
// that is a handful of small coloured shapes with a lot of dark grid around
// them - it reads as a screenshot of a game rather than as a place - and behind
// a band the eye has nothing to travel along.
//
// This is the same well turned into a shaft the camera flies down. The four
// walls are tiled with tetrominoes, so what is on screen is still unmistakably
// Tetris, but the near blocks are metres across at the corners of the frame and
// the far ones converge on the vanishing point.
//
// Nothing is marched. A rectangular tube has a closed-form intersection: for a
// ray through the pixel, the wall it hits is whichever of |x| and |y| is larger,
// and the distance to it is one over that. Every pixel therefore does exactly
// one intersection, one hash and one 4x4 bitmask lookup, whatever the depth.

// The seven tetrominoes as 4x4 bitmasks, row-major from the top.
int pieceMask(int id) {
  if (id == 0) return 0x0F00;   // I
  if (id == 1) return 0x8E00;   // J
  if (id == 2) return 0x2E00;   // L
  if (id == 3) return 0x6600;   // O
  if (id == 4) return 0x6C00;   // S
  if (id == 5) return 0x4E00;   // T
  return 0xC600;                // Z
}

/// Is cell (x,y) of a 4x4 piece filled, after `rot` quarter turns?
bool pieceAt(int id, int rot, int x, int y) {
  if (x < 0 || x > 3 || y < 0 || y > 3) return false;

  // Rotate the lookup instead of the data.
  int rx = x, ry = y;
  for (int i = 0; i < 3; i++) {
    if (i >= rot) break;
    int nx = 3 - ry;
    ry = rx;
    rx = nx;
  }

  int bit = ry * 4 + rx;
  return ((pieceMask(id) >> (15 - bit)) & 1) == 1;
}

void main() {
  vec2 uv = centered(vUv, uAspect);

  // A slow drift of the shaft axis, so the vanishing point is not nailed to the
  // middle of the frame for the whole scene.
  uv -= vec2(sin(uTime * 0.13), cos(uTime * 0.11)) * p_drift;
  uv = rot(sin(uTime * 0.09) * 0.25 + uTime * p_roll) * uv;

  float ax = abs(uv.x), ay = abs(uv.y);
  float m = max(ax, ay);

  // Distance to the wall this pixel sees, and where on it the pixel lands.
  float z = 1.0 / max(m, 1e-4);
  float u, face;
  if (ax > ay) { u = uv.y / max(ax, 1e-4); face = uv.x > 0.0 ? 0.0 : 2.0; }
  else         { u = uv.x / max(ay, 1e-4); face = uv.y > 0.0 ? 1.0 : 3.0; }

  float cells = clamp(floor(p_cell + 0.5), 2.0, 10.0);
  float travel = z + uTime * p_fall;

  // Cell coordinates: around the perimeter, and down the shaft. The z spacing is
  // 2/cells per row so the blocks come out square on the wall.
  float gu = (face * 2.0 + u + 1.0) * 0.5 * cells;
  float gv = travel * cells * 0.5;

  vec2 within = fract(vec2(gu, gv));
  float cu = floor(gu), cv = floor(gv);

  // Which 4x4 piece this cell belongs to, and which cell of it this is.
  float bu = floor(cu * 0.25), bv = floor(cv * 0.25);
  float seed = hash12(vec2(bu, bv) + p_seed);
  int id = int(seed * 7.0);
  int rot = int(hash12(vec2(bv, bu) * 1.7) * 4.0);
  bool filled = pieceAt(id, rot, int(mod(cu, 4.0)), int(mod(cv, 4.0)));

  // A quarter of the wall is left open, so the shaft has holes in it and reads
  // as a structure rather than as wallpaper.
  if (hash12(vec2(bu, bv) * 3.13 + 11.0) < p_gaps) filled = false;

  // ---- the shaft itself ---------------------------------------------------
  //
  // The wall behind the blocks carries most of the frame: a quarter of the cells
  // are deliberately empty and a tetromino only fills part of the 4x4 block it
  // sits in, so roughly two thirds of what is on screen is *not* a block. Left
  // near black, as the flat version left it, the effect measures a fifth of the
  // frame lit however good the blocks are. It is a lit surface here, not a void.
  vec3 col = palClamp(0.16) * 0.55;
  col += palClamp(0.42) * fbm(vec2(gu * 0.35, travel * 0.4), 4, 2.0, 0.5) * 0.30;

  // Brushed panelling along the shaft, so the empty wall has a direction.
  col *= 0.82 + 0.30 * sin(gv * TAU * 0.5 + gu * 0.4);

  // The grid the blocks are set into, lit where they are missing.
  vec2 gl = abs(within - 0.5);
  float rule = smoothstep(0.40, 0.5, max(gl.x, gl.y));
  col += palClamp(0.62) * rule * 0.42;
  col += palClamp(0.90) * smoothstep(0.47, 0.5, max(gl.x, gl.y)) * 0.20 * uBeatPulse;

  // ---- the blocks ---------------------------------------------------------
  if (filled) {
    vec3 blockCol = pal(fract(float(id) * 0.1428 + bv * 0.035 + uTime * 0.02));

    // Bevel: lit from the top-left of each cell, as the originals were.
    float b = clamp(p_bevel, 0.0, 0.45);
    float lightEdge = smoothstep(b, 0.0, min(within.x, 1.0 - within.y));
    float darkEdge = smoothstep(b, 0.0, min(1.0 - within.x, within.y));

    col = blockCol * 0.78;
    col += blockCol * lightEdge * 0.95 + vec3(0.28) * lightEdge;
    col -= vec3(0.30) * darkEdge;

    // Side walls take less light than the floor and ceiling, which is most of
    // what stops the four faces reading as one flat sheet folded round.
    col *= mix(0.72, 1.12, mod(face, 2.0));
  }

  // ---- rows locking in ----------------------------------------------------
  // A completed row flashes and goes. Whole rows of the shaft light up on the
  // bar, travelling away from the camera, which is the closest thing this
  // geometry has to a line clear - and it is the beat you actually see.
  float rowSeed = hash11(bv * 4.7);
  float lockPhase = fract(uBar + rowSeed);
  float lock = smoothstep(0.86, 1.0, lockPhase) * step(rowSeed, 0.34);
  col += palClamp(0.95) * lock * (0.55 + 1.1 * uBeatPulse) * float(filled);

  // ---- depth --------------------------------------------------------------
  // Near blocks run hot, far ones sink into the throat glow rather than into
  // black, so the shaft has no visible end and never turns to moire.
  col *= mix(1.45, 0.55, sat(z / 9.0));
  col = mix(col, palClamp(0.42) * 0.8, smoothstep(3.5, 11.0, z));

  // Light coming up the shaft.
  col += palClamp(0.88) * exp(-length(uv) * 1.9) * (0.28 + 0.40 * uBeatPulse) * p_glow;

  col *= 0.93 + 0.24 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
