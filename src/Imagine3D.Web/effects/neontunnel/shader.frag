#include "common.glsl"
#include "palette.glsl"

// Flight down a snaking corridor lit only by two neon strands.
//
// The corridor centre follows a spline in z; the camera rides the same spline a
// little ahead of itself, which is what makes it bank into the turns rather
// than sliding sideways. Nothing is shaded from a light: the image is the sum of
// 1/distance to the strands and the walls, which is why it reads as pure neon.
//
// Technique reference: the glow-accumulation corridor flights on Shadertoy.

float gCurve, gStrands;
vec3 gLight;   // accumulated strand colour for this step

/// Centre of the corridor at depth z.
vec3 path(float z) {
  return vec3(
    (cos(z * 0.015) * 16.0 + cos(z * 0.006) * 64.0) * gCurve,
    (cos(z * 0.011) * 24.0 + cos(z * 0.009) * 32.0) * gCurve,
    z);
}

/// Repeating boxes that form the corridor walls.
float boxen(vec3 p) {
  p = abs(fract(p / 40.0) * 40.0 - 20.0) - 2.0;
  return min(p.x, min(p.y, p.z));
}

float map(vec3 p) {
  vec3 c = path(p.z);

  float walls = boxen(p);
  float floorPlane = c.y - p.y + 6.0;

  // Into corridor-local space.
  p.xy -= c.xy;

  // Two strands weaving along the corridor on offset sines.
  float a = length(p.xy - sin(p.y / 12.0 + vec2(5.0, 1.0)) * 12.0) - 1.0;
  float b = length(p.xy - sin(p.y / 12.0 + vec2(0.0, 1.0)) * 12.0) - 1.0;

  // Strands emit rather than reflect - accumulate their contribution here.
  gLight += palClamp(0.30) * gStrands / (0.1 + abs(a) / 10.0);
  gLight += palClamp(0.88) * gStrands / (0.1 + abs(b) / 10.0);

  vec3 q = abs(p);

  // Surface relief on the walls, so they are not flat slabs.
  //
  // The floor here is not cosmetic. p.xy is measured relative to the corridor
  // centre, and the very first sample of every ray is taken at the camera, which
  // rides that centre exactly - so q.x and q.y are both zero on step one of every
  // pixel. Dividing by q then produced an infinity, the relief came back as one,
  // the distance as minus infinity, and the march advanced by NaN. NaN fails
  // every comparison, so the loop neither hit anything nor terminated, and the
  // whole effect rendered black on every frame.
  float relief = abs(length(sin(q * cos(q.yzx / 30.0) * 4.0) / max(q * 4.0, 1e-3)));

  float tunnel = min(64.0 - q.x - q.y + walls, 32.0 - q.y - walls);
  float d = max(min(walls, floorPlane), tunnel) - relief;

  return min(min(a, b), d);
}

void main() {
  gCurve = p_curve;
  gStrands = p_strands;

  vec2 uv = centered(vUv, uAspect) * 0.5;
  uv.y -= 0.2;

  float t = sin(uTime * 0.6) * 64.0 + uTime * p_speed;

  vec3 ro = path(t);
  vec3 fwd = normalize(path(t + 10.0) - ro);
  vec3 side = normalize(vec3(fwd.z, 0.0, -fwd.x));
  vec3 up = cross(side, fwd);

  // Bank into the turns.
  vec2 rolled = rot(sin(t * 0.005) * 0.4) * uv;
  vec3 rd = normalize(rolled.x * side + rolled.y * up + fwd);

  vec3 col = vec3(0.0);
  // Not zero: the camera sits on the corridor centre line, which is the one
  // place the wall relief above is degenerate. Starting a step in also means the
  // first sample says something about the scene rather than about the lens.
  float d = 0.35;
  float s = 1.0;

  for (int i = 0; i < 110; i++) {
    gLight = vec3(0.0);
    vec3 p = ro + rd * d;
    s = map(p) * 0.8;
    d += s;
    // Glow from the strands plus a proximity term for the walls. Both are raw
    // 1/distance sums - enormous numbers, normalised once at the end.
    // Walls contribute much less than the strands - they are there to give the
    // corridor shape, not to light it.
    // The strands are the picture; the walls are there so it has somewhere to
    // happen. Weighted accordingly - at parity the wall term is a flat wash
    // across the whole frame and the neon disappears into it.
    col += gLight * 2.4 + palClamp(0.45) * 0.35 / max(s, 0.35);
    if (d > 900.0) break;
  }

  // How far the ray travelled matters: dividing by `d` is what makes distant
  // corridor dim instead of every pixel saturating, and tanh rolls the
  // highlights off instead of clipping them.
  //
  // Both numbers here were recalibrated once the NaN above was fixed, because
  // until then this shader rendered black on every frame and there was nothing
  // to calibrate against. The accumulator runs to order 10^3 only for a ray that
  // passes close to a strand; an ordinary one down the middle of the corridor
  // collects a few tens, and against the old 1/(d*0.02) that came out at a
  // thousandth of full scale. The distance term is now gentle enough that the
  // corridor walls are visible for the whole length of the shot.
  col = tanh(col * p_glow * 0.0022 / max(1.0, d * 0.010));

  col *= 0.9 + 0.35 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
