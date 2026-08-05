#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Strings on a board, each one standing in its own mode.
//
// A string pinned at both ends can only vibrate in shapes that fit a whole
// number of half-waves between the ends, so every string here is
// sin(mode * PI * u) held between two fixed points and swung by a phase. That is
// the physics, not a decoration of it: the string is dead still at its nodes and
// swings hardest at its antinodes, and marking the nodes on the board is the one
// thing a picture of a standing wave can show that a picture of a wave cannot.
//
// The strings are tuned across the spectrum — the fundamental takes the sub
// band, the highest partial takes air — and driven by the band followers, which
// already have a fast attack and a slow release. That envelope is a pluck. No
// extra shaping is needed to make a string ring and die away; it is what the
// analysis hands over.

void main() {
  vec2 p = centered(vUv, uAspect);
  float aa = pixel();
  float W = uAspect * 0.86;

  float n = clamp(floor(p_strings + 0.5), 2.0, 12.0);
  float u = (p.x + W) / (2.0 * W);
  float onBoard = step(abs(p.x), W);

  // --- soundboard ---------------------------------------------------------
  vec3 col = mix(palClamp(0.05), palClamp(0.22), sat(-p.y * 0.45 + 0.5)) * 0.62;
  col *= 0.78 + 0.44 * fbm(vec2(p.x * 1.4, p.y * 26.0), 4, 2.0, 0.5);   // grain, along the grain
  col += palClamp(0.50) * exp(-length(p * vec2(0.6, 1.0)) * 1.3) * 0.10;

  vec3 light = vec3(0.0);

  for (int i = 0; i < 12; i++) {
    if (float(i) >= n) break;
    float fi = float(i);
    float k = (fi + 0.5) / n;                       // 0..1 down the set
    float rest = mix(0.72, -0.72, k);
    float mode = floor(1.0 + fi * max(0.0, p_modes));

    float band = clamp(spectrumNow(k), 0.0, 1.0);
    float peak = clamp(spectrumPeak(k), 0.0, 1.0);

    // Swing is bounded by the gap to the next string, so a loud band never puts
    // one string through its neighbour.
    float amp = band * p_swing * 0.45 * (1.44 / n);

    // A real string runs at hundreds of hertz and would be a blur. This is the
    // right *relationship* — higher modes shimmer faster — at a rate the eye can
    // follow, which is the only honest way to draw it at 60 frames a second.
    float phase = sin(uTime * p_ring * (1.0 + mode * 0.35) + fi * 1.7);
    float shape = sin(mode * PI * clamp(u, 0.0, 1.0));

    float y = rest + amp * shape * phase;
    float dydx = amp * phase * mode * PI / (2.0 * W) * cos(mode * PI * clamp(u, 0.0, 1.0));
    float g = inversesqrt(1.0 + dydx * dydx);

    float w = mix(0.0052, 0.0016, k) * p_gauge;     // bass strings are thicker
    float d = abs(p.y - y) * g;

    vec3 c = palClamp(0.14 + 0.76 * k);
    // A wound string is not evenly lit along its length.
    c *= 0.80 + 0.35 * sin(u * TAU * 2.0 - uTime * 0.5 + fi);

    // Shadow on the board, cast down and to the right of the string.
    col *= 1.0 - 0.50 * fill(abs(p.y - y + 0.018) - w * 2.4, aa) * onBoard;

    light += c * glowLine(d, w, w * 4.5, aa) * (0.45 + 1.10 * band + 0.55 * peak * uOnset) * onBoard;
    // Lacquer: the string mirrored in the board, close in and dim, so it reads as
    // polish rather than as a second string.
    light += c * exp(-abs(p.y - (2.0 * (rest - 0.045) - y)) * 30.0) * 0.13 * band * onBoard;

    // Nodes: where this mode's string never moves. Marked on the board, so the
    // count of them says which partial you are looking at.
    float toNode = min(fract(u * mode), 1.0 - fract(u * mode)) * (2.0 * W / mode);
    light += c * exp(-length(vec2(toNode, p.y - rest)) * 48.0) * 0.28 * onBoard;
  }

  col += light * p_glow;

  // --- nut and bridge -----------------------------------------------------
  // The rails the strings are stretched between. Without them the strings end in
  // mid-air and the standing wave has nothing to stand against.
  float rail = min(abs(p.x + W), abs(p.x - W));
  vec3 metal = mix(vec3(0.52, 0.53, 0.58), palClamp(0.90), 0.35);
  col = mix(col, metal * (0.35 + 0.55 * exp(-abs(p.y) * 0.6)), fill(rail - 0.013, aa));
  col += metal * exp(-rail * 85.0) * 0.14;

  col *= 1.0 - 0.32 * pow(length(p * vec2(0.5, 0.8)), 2.4);
  col *= 0.95 + 0.10 * uBeatPulse;
  fragColor = vec4(max(col, 0.0), 1.0);
}
