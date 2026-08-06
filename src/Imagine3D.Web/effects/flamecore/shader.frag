#include "common.glsl"
#include "noise.glsl"
#include "palette.glsl"

// A firestorm, marched as a volume.
//
// The previous version was one flame: a noise-eroded ellipsoid sitting in the
// middle of an otherwise black frame, brightness taken from how many march steps
// landed inside it. It is a lovely trick and it makes exactly one object, which
// is the problem - nine tenths of a 1080p frame was empty, and the effect had
// nowhere to go when the music did.
//
// Here the flame is a *field* instead of a body. Columns of fuel repeat across
// the ground plane, the camera flies through them, and the march integrates
// emission along the ray rather than counting steps inside a surface. That gets
// three things the single body could not: fire in front of and behind other
// fire, so the frame reads in depth; near columns that overrun the top of the
// frame; and a horizon the far ones fall away to, so there is always something
// burning at the edges.
//
// Fixed-step marching, not sphere tracing - a volume has no surface to trace to,
// and a constant step is what makes the integral converge evenly instead of
// piling all its samples up against the first dense thing the ray meets.

const float GROUND = -1.6;
const float TOP    = 5.2;      // where the fuel runs out
const float SPACING = 2.1;     // between flame columns

/// Fuel density at p. 0 is air.
float density(vec3 p, float t) {
  // Columns repeat forever across the ground. Each cell gets its own radius and
  // its own phase so the field is not a grid of identical torches.
  vec2 cell = floor(p.xz / SPACING + 0.5);
  vec2 q = p.xz - cell * SPACING;

  float seed = hash12(cell);
  float radius = p_column * (0.65 + 0.70 * seed);

  float height = mix(0.60, 1.0, fract(seed * 7.3)) * TOP;
  float h = (p.y - GROUND) / max(0.2, height);
  if (h < -0.05 || h > 1.05) return 0.0;

  // Columns lean and taper: wide and steady at the base, thin and wandering at
  // the tip. The lean is what stops them reading as pillars.
  q += vec2(sin(t * 0.7 + seed * 30.0), cos(t * 0.5 + seed * 17.0)) * h * h * 0.9;
  float body = 1.0 - length(q) / max(0.05, radius * (1.0 - 0.45 * h * h));

  // Fuel falls off with height; the noise eats into it to make tongues. The
  // noise field itself is advected upward, which is the whole of the motion.
  float n = fbm3(vec3(p.x, p.y - t * p_speed, p.z) * p_turbulence + seed * 13.0, 3);

  // The erosion used to bite hard enough at every height that the columns burned
  // out a third of the way up and the field read as a row of camp fires. It
  // wants to be almost absent at the base - that is a body of flame, not smoke -
  // and to tear the top apart, which is what makes a tongue.
  float d = body * (1.0 - h * 0.55) * 2.1 - n * 1.5 * h;
  return clamp(d, 0.0, 1.0);
}

void main() {
  vec2 uv = centered(vUv, uAspect);
  float t = uTime;

  // Camera walks into the field, breathing on the bar and swaying slowly. Down
  // among the columns rather than looking across at them, so they tower over it
  // and the ones going past the lens leave through the top of the frame.
  //
  // Offset by half a cell in both ground axes, and swaying by less than the gap
  // between columns. Walking down the cell centres instead puts the lens inside
  // a column for most of the shot, and fuel at zero distance is not a flame, it
  // is a full-frame wall of noise - which is exactly what this looked like.
  const float LANE = SPACING * 0.5;
  vec3 ro = vec3(LANE + sin(t * 0.11) * 0.55,
                 -0.90 + sin(t * 0.17) * 0.18,
                 // Forward is +z, because that is where rd points. This was a
                 // minus, which walked the camera backwards out of the field:
                 // the columns receded instead of arriving, and a probe that
                 // fits a zoom to consecutive frames read it as 0.90 - the
                 // picture contracting - where every other flight in the
                 // library reads above 1.
                 LANE + t * p_walk);
  float F = 1.15 - 0.09 * uBeatPulse;
  vec3 rd = normalize(vec3(rot(sin(t * 0.07) * 0.10) * uv, F));

  // ---- the night the fire is burning in ----------------------------------
  // Smoke lit from below, so the sky is never a flat black plate above the
  // flames - but dark. It is a backdrop to a fire, and at any brightness that
  // competes with the flames the whole frame reads as an overcast afternoon
  // with some brown mounds in it.
  float sky = sat(rd.y * 1.4 + 0.25);
  vec3 col = mix(palClamp(0.22), palClamp(0.01), sky) * 0.16;
  col += palClamp(0.55) * exp(-max(0.0, rd.y) * 3.4) * 0.14;
  col *= 0.65 + 0.85 * fbm(vec2(atan(rd.x, rd.z) * 1.6, rd.y * 2.2) + vec2(t * 0.05, -t * 0.09), 4, 2.0, 0.5);

  // ---- the volume ---------------------------------------------------------
  int steps = int(clamp(p_steps, 16.0, 64.0));
  // Far enough that the field runs past the fog and no further. It was 26, which
  // over the same step count made each step half a metre long - and since the
  // entry point is dithered per pixel by a whole step, neighbouring pixels were
  // sampling half a metre apart through a high-contrast volume. That is the
  // grain the field came out covered in; it is the dither doing its job over too
  // coarse a march.
  float far = 15.0;
  float dt = far / float(steps);

  // Dither the entry point per pixel. A fixed step over a hard-edged volume
  // bands into visible shells; jittering the start turns the banding into grain,
  // which the eye reads as smoke.
  float jitter = hash12(gl_FragCoord.xy + floor(t * 60.0)) * dt;

  vec3 fire = vec3(0.0);
  float trans = 1.0;   // how much of the background still gets through

  for (int i = 0; i < 64; i++) {
    if (i >= steps || trans < 0.02) break;
    float dist = jitter + float(i) * dt;
    vec3 p = ro + rd * dist;
    if (p.y < GROUND - 0.2) break;

    float d = density(p, t);
    if (d <= 0.001) continue;

    // Temperature: high where the flame is dense and low down, falling off
    // through the tips. One number, and everything about the colour comes off it.
    //
    // This used to be two terms - a height ramp for the hue and a separate white
    // core keyed on density alone - and the core won everywhere, because density
    // is high through the whole body of a column and not just at its base. Every
    // palette came out as the same cream-coloured plume. Fire is a temperature
    // gradient; one gradient is the honest way to draw it.
    float h = sat((p.y - GROUND) / TOP);

    // Height leads, density only trims. The other way round comes out as one
    // flat colour: the density function saturates at 1 through the whole body of
    // a column, not just at its base, so anything keyed mainly on it paints the
    // entire flame at whatever the hottest stop happens to be.
    //
    // The ramp is calibrated to the band of h the camera actually sees, which is
    // roughly 0.15 to 0.6 - it stands among the columns rather than above them.
    // Spreading the gradient evenly over the full 0..1 of column height puts the
    // whole visible band inside the white core and wastes the other two thirds
    // of it on fuel that is above the top of the frame.
    float temp = sat(0.75 - h * 1.90 + d * 0.35);

    vec3 native = mix(vec3(0.75, 0.10, 0.01), vec3(1.0, 0.52, 0.08), sat(temp * 1.7));
    native = mix(native, vec3(1.0, 0.93, 0.74), sat(temp * temp * 1.5 - 0.45));

    vec3 tinted = palClamp(0.08 + 0.88 * temp);
    vec3 emit = mix(native, tinted, p_tint);

    // Distance dims it, so a column ten metres back is a glow and one in front
    // of the lens is a wall of light.
    float atten = exp(-dist * 0.10);

    float a = d * dt * p_density;
    // Gain low enough that the mid-tones stay coloured. The tone curve below
    // compresses every channel toward the same ceiling, so an over-driven
    // integral does not come out as bright fire - it comes out as white.
    fire += emit * a * trans * atten * p_glow * 1.15;
    trans *= exp(-a * 2.6);
  }

  col = col * trans + fire;

  // ---- embers -------------------------------------------------------------
  // Points of light rising out of the field, which is what fills the empty sky
  // between the columns and gives the top of the frame something to do.
  vec2 eg = vec2(uv.x * 1.4, uv.y) * 26.0 + vec2(sin(uTime * 0.3) * 4.0, -uTime * 3.2 * p_walk);
  vec2 ecell = floor(eg);
  float ember = step(0.985, hash12(ecell)) *
                smoothstep(0.55, 0.0, length(fract(eg) - 0.5)) *
                smoothstep(-0.9, 0.7, uv.y);
  col += ember * mix(vec3(1.0, 0.7, 0.3), palClamp(0.9), p_tint) * (0.6 + 1.2 * uBeatPulse);

  // The whole field leans on the low end - fire responds to the kick, not to a
  // metronome.
  col *= 0.88 + 0.30 * uBass + 0.22 * uBeatPulse;

  // Roll the highlights off instead of clipping them: a volume integral has no
  // upper bound and hard-clipping it leaves flat white plates with edges.
  //
  // Rolled off on the brightest channel, and every channel then scaled by that
  // one factor. Compressing each channel against its own curve is the usual
  // form and it is wrong for fire: red saturates first, green follows, blue last,
  // so the hotter the flame the closer the three come together and the whole
  // field arrives at the same cream colour whatever the palette said. Scaling
  // uniformly keeps the ratio between the channels, which is the hue.
  float peak = max(col.r, max(col.g, col.b));
  col *= 1.0 / (1.0 + peak * 0.85);
  fragColor = vec4(max(col, 0.0), 1.0);
}
