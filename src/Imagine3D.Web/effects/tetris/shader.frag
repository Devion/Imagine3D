#include "common.glsl"
#include "palette.glsl"

// Tetrominoes falling down a well.
//
// Drawn in 2D with beveled cells rather than real geometry: a raymarched version
// would cost ten times as much for the same read, because the shapes are axis
// aligned and the whole look comes from the bevel shading.

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
  float cols = max(6.0, p_cell);
  float rows = max(6.0, floor(cols / uAspect));

  vec2 grid = vec2(cols, rows);
  vec2 g = vUv * grid;
  vec2 cell = floor(g);
  vec2 within = fract(g);

  // Background: the well, with a faint grid.
  vec3 col = palClamp(0.03) * (1.0 - 0.4 * length(centered(vUv, uAspect)));
  vec2 gl = abs(within - 0.5);
  col += palClamp(0.14) * smoothstep(0.47, 0.5, max(gl.x, gl.y)) * 0.35;

  bool filled = false;
  float pieceId = 0.0;
  float landed = 0.0;

  int count = int(clamp(p_pieces, 1.0, 14.0));
  for (int i = 0; i < 14; i++) {
    if (i >= count) break;
    float fi = float(i);

    // Each piece has its own lane, cadence and phase.
    float cycle = 3.0 + hash11(fi * 3.7) * 3.5;
    float phase = uTime * (p_fall * 0.12) + fi * 0.37;
    float run = floor(phase / cycle * cycle);
    float age = mod(phase, 1.0);

    float seed = hash11(fi * 11.3 + floor(phase));
    int id = int(seed * 7.0);
    int rot = int(hash11(fi * 5.1 + floor(phase)) * 4.0);

    float lane = floor(hash11(fi * 7.9 + floor(phase)) * (cols - 4.0));

    // Fall from above the frame to a resting row, then hold briefly.
    float restRow = rows - 4.0 - floor(hash11(fi * 2.3 + floor(phase)) * (rows * 0.55));
    float top = mix(-4.0, restRow, min(1.0, age * 1.35));

    // Snap to whole cells so it steps like the real thing.
    top = floor(top);

    int lx = int(cell.x - lane);
    int ly = int(cell.y - top);

    if (pieceAt(id, rot, lx, ly)) {
      filled = true;
      pieceId = seed;
      landed = max(landed, smoothstep(0.72, 1.0, age));
    }
  }

  if (filled) {
    vec3 blockCol = pal(fract(pieceId * 0.9 + uTime * 0.03));

    // Bevel: light from the top-left, dark to the bottom-right.
    float b = clamp(p_bevel, 0.0, 0.45);
    float lightEdge = smoothstep(b, 0.0, min(within.x, 1.0 - within.y));
    float darkEdge = smoothstep(b, 0.0, min(1.0 - within.x, within.y));

    col = blockCol * 0.75;
    col += blockCol * lightEdge * 0.9 + vec3(0.25) * lightEdge;
    col -= vec3(0.28) * darkEdge;

    // Flash as a piece locks into place.
    col += palClamp(0.95) * landed * 0.8 * uBeatPulse;
  }

  col *= 0.92 + 0.25 * uBeatPulse;
  fragColor = vec4(col, 1.0);
}
