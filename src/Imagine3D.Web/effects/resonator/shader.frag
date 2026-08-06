#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"
#include "panel.glsl"

// Strings, stretched down a corridor instead of across a board.
//
// The physics is the point and it survives intact. A string pinned at both ends
// can only vibrate in shapes that fit a whole number of half-waves between the
// ends, so every string here is sin(mode * PI * u) along its own length, swung
// by a phase. It is dead still at its nodes and swings hardest at its
// antinodes, and marking the nodes is the one thing a picture of a standing wave
// can show that a picture of a wave cannot. The strings are tuned across the
// spectrum - the fundamental takes the sub band, the highest partial takes air -
// and driven by the band followers, whose fast attack and slow release already
// are a pluck.
//
// What changed is the axis. Laid across a flat board the instrument was a small
// object in the middle of the frame with a woodgrain backdrop: a diagram of a
// standing wave rather than a place to be. Here the strings run *away* from the
// camera, arranged in a barrel around it, so they converge on a vanishing point
// and the near ends sweep out past the corners.
//
// That also makes the projection invertible in closed form, which is what pays
// for it. A string on a barrel of radius R displaced *tangentially* projects to
// a fixed screen radius - rad = R * F / z - so the depth a pixel is looking at
// falls straight out of its distance from the middle of the frame, with no
// search and no marching. Every string then contributes one angle comparison.
// The wobble is entirely in the angle, which is precisely what a string plucked
// sideways looks like when you sight down it.

const float FOCAL = 1.15;
const float SPAN = 7.0;       // world length of one string, anchor to anchor

void main() {
  vec2 p = centered(vUv, uAspect);
  float aa = pixel();

  // Drift the barrel axis, so the vanishing point is not pinned to the middle
  // of the frame for a whole scene.
  p -= vec2(sin(uTime * 0.09), cos(uTime * 0.075)) * p_drift;

  float rad = max(length(p), 1e-4);
  float ang = atan(p.y, p.x);

  float travel = uTime * p_travel;
  float n = clamp(floor(p_strings + 0.5), 3.0, 16.0);
  float gap = TAU / n;

  // --- the barrel the strings are stretched down ---------------------------
  vec3 col = palClamp(0.03) * (0.5 + 0.5 * exp(-rad * 0.8));
  col += palClamp(0.28) * fbm(vec2(ang * 1.4, log(rad + 0.05) * 2.0 + travel * 0.12),
                              4, 2.0, 0.5) * 0.07;
  // Light down the far end, which is where every string is heading.
  col += palClamp(0.75) * exp(-rad * 4.5) * (0.16 + 0.30 * uBeatPulse) * p_glow;

  vec3 light = vec3(0.0);

  for (int i = 0; i < 16; i++) {
    if (float(i) >= n) break;
    float fi = float(i);
    float k = (fi + 0.5) / n;                       // 0..1 across the set

    // Each string sits on its own barrel radius, so the set reads as a nest of
    // depths rather than as one cylinder - and so two strings can cross on
    // screen, which is where the whole thing stops looking flat.
    float R = p_radius * mix(0.55, 1.35, fract(sin(fi * 12.9898) * 43758.5453));

    // Depth this pixel is looking at, on this string's barrel. Exact: the
    // tangential displacement does not move a point off its own screen ray.
    float z = R * FOCAL / rad;
    if (z > 30.0 || z < 0.35) continue;

    // Position along the string, 0 at one anchor and 1 at the next.
    //
    // Wrapped, not clamped. The camera slides down the corridor forever, so a
    // single span would run off its own far end within seconds and every string
    // would clamp to u = 1 - where sin(mode * PI * u) is exactly zero, so every
    // string stopped swinging and the whole instrument went straight. Wrapping
    // makes it a run of spans joined end to end, which is what the hoops below
    // are already drawn as: the anchors arrive at the lens one after another.
    float u = fract((z + travel) / SPAN);
    float mode = floor(1.0 + fi * max(0.0, p_modes));

    float band = clamp(spectrumNow(k), 0.0, 1.0);
    float peak = clamp(spectrumPeak(k), 0.0, 1.0);

    // Swing is bounded by the angular gap to the next string, so a loud band
    // never puts one string through its neighbour.
    float amp = band * p_swing * gap * 0.42;

    // A real string runs at hundreds of hertz and would be a blur. This is the
    // right *relationship* - higher modes shimmer faster - at a rate the eye can
    // follow, which is the only honest way to draw it at 60 frames a second.
    float phase = sin(uTime * p_ring * (1.0 + mode * 0.35) + fi * 1.7);
    float shape = sin(mode * PI * u);

    float base = fi * gap + uTime * p_spin;
    float a = base + amp * shape * phase;

    // Angular distance to the string, converted to screen units.
    float dAng = ang - a;
    dAng -= TAU * floor(dAng / TAU + 0.5);
    float d = abs(dAng) * rad;

    // Thickness in world units, projected. Bass strings are wound thicker; every
    // string thins toward the vanishing point exactly as perspective demands.
    float w = mix(0.055, 0.016, k) * p_gauge * FOCAL / z;

    vec3 c = palClamp(0.14 + 0.76 * k);
    // A wound string is not evenly lit along its length.
    c *= 0.80 + 0.35 * sin(u * TAU * 3.0 - uTime * 0.5 + fi);

    // Depth: the far end of a string dims into the same haze the barrel is made
    // of, so the corridor has no back wall.
    float dim = exp(-z * 0.075);

    light += c * glowLine(d, w, w * 4.5, aa)
             * (0.40 + 1.15 * band + 0.55 * peak * uOnset) * dim;

    // Nodes: where this mode's string never moves. Marked as a bead on the
    // string, so the count of them says which partial you are looking at.
    float toNode = min(fract(u * mode), 1.0 - fract(u * mode)) / max(mode, 1.0) * SPAN;
    light += c * exp(-length(vec2(d * 3.0, toNode)) * 3.0) * 0.45 * dim;
  }

  col += light * p_glow;

  // --- the frames the strings are stretched between ------------------------
  // Hoops at fixed depths. Without them the strings run off into nothing and the
  // standing wave has nothing to stand against; with them the corridor is built.
  for (int i = 0; i < 4; i++) {
    float zf = 1.0 + float(i) * SPAN - mod(travel, SPAN);
    if (zf < 0.4) zf += SPAN * 4.0;
    float rr = p_radius * FOCAL / zf;
    float d = abs(rad - rr);
    vec3 metal = mix(vec3(0.55, 0.56, 0.62), palClamp(0.90), 0.4);
    col += metal * (fill(d - 0.004, aa) * 0.30 + exp(-d * 90.0) * 0.14) * exp(-zf * 0.06);
  }

  col *= 0.95 + 0.12 * uBeatPulse;
  col = col / (1.0 + col * 0.28);
  fragColor = vec4(max(col, 0.0), 1.0);
}
