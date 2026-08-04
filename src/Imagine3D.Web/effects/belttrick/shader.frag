#include "common.glsl"
#include "palette.glsl"

// The Dirac / Feynman belt trick, as an infinite lattice.
//
// The figure at any instant is ONE rigid object - a cube with three abs-folded
// ribbon boxes - pushed through a radius-dependent spinor field. Nothing is
// animated by hand: a point at radius r is rotated by the quaternion spinor(t(r)),
// so the core turns while the ribbon anchors stay put and the twist distributes
// itself along the belt.
//
// The reason it untangles is the whole point. A 360-degree turn leaves the belts
// tangled; 720 does not, because the double cover means the spinor returns to the
// identity only after 4PI. TURNS = 2 makes the animation loop seamlessly.
//
// The source ships eight compile-time switches for alternative topologies and
// diagnostics. Only the author's chosen configuration is kept here - repeated
// domain, linear twist profile, fixed axis, no slack, no exact-SDF path, no AO or
// shadows - because the dead branches were most of the file. The values that
// remain configurable at runtime are parameters instead.

#define TURNS   2.0            // 2 = 720 degrees: unwinds and loops
#define UMAX    1.0            // matches the linear twist profile below

const float H    = 0.62;       // cube half-extent
const float R0   = 1.15;       // rigid core radius (>= sqrt(3)*H)
const float R1   = 4.40;       // anchor / cell-face radius
const float WID  = 0.30;       // ribbon width
const float THK  = 0.06;       // ribbon thickness

#define PERIOD (2.0 * R1)      // cell period: ribbons meet exactly at the faces

// Phase 0..1 through the cycle, and its half-angle pair. Globals because the
// spinor is evaluated per sample and they never vary within a frame.
float gS = 0.0;
vec2 gA = vec2(1.0, 0.0);

// Lipschitz bound for the twisted field. The spinor makes map() overestimate
// distance, so every step is divided by this or the march tunnels through walls.
float gLip = 1.0;

vec4 qmul(vec4 a, vec4 b) {
  return vec4(a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz), a.w * b.w - dot(a.xyz, b.xyz));
}
vec4 qconj(vec4 q) { return vec4(-q.xyz, q.w); }
vec3 qrot(vec4 q, vec3 v) { return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v); }

// Linear twist profile: full rotation at the core, none at the anchor.
float uOf(float t) { return 1.0 - t; }

vec4 spinor(float t) {
  float u = uOf(t);
  float c = cos(0.5 * PI * u), d = sin(0.5 * PI * u);
  vec3 m = vec3(1.0, 0.0, 0.0);                 // fixed axis (HOMOTOPY 0)
  vec4 A = vec4(0.0, gA.y, 0.0, gA.x);
  return qmul(c * A + vec4(d * m, 0.0), qconj(vec4(d * m, c)));
}

// Radius mapped to twist parameter: 1 at the core, 0 at the anchor.
float tOf(float r) { return clamp((R1 - r) / (R1 - R0), 0.0, 1.0); }

float lipschitz() {
  float phi = PI * TURNS * gS;
  float w = TAU * UMAX * abs(sin(0.5 * phi));
  return 1.0 + R1 * w / (R1 - R0);
}

vec3 localP(vec3 p) { return mod(p + 0.5 * PERIOD, PERIOD) - 0.5 * PERIOD; }

// Undo the twist, so the static figure can be evaluated in its own frame.
vec3 undeformL(vec3 lp) { return qrot(qconj(spinor(tOf(length(lp)))), lp); }
vec3 undeform(vec3 p) { return undeformL(localP(p)); }

float sdBox(vec3 p, vec3 b) {
  vec3 q = abs(p) - b;
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0);
}

// The untwisted figure: a cube (id 1) and three abs-folded ribbon pairs (id 2).
// Folding by abs() is what makes one box into an opposing pair.
vec2 sdStatic(vec3 p) {
  vec2 res = vec2(sdBox(p, vec3(H)), 1.0);

  vec3 a = abs(p);
  float m = 0.5 * (H + R1), e = 0.5 * (R1 - H);

  float db = sdBox(a - vec3(m, 0, 0), vec3(e, THK, WID));
  db = min(db, sdBox(a - vec3(0, m, 0), vec3(WID, e, THK)));
  db = min(db, sdBox(a - vec3(0, 0, m), vec3(THK, WID, e)));
  if (db < res.x) res = vec2(db, 2.0);

  return res;
}

vec2 map(vec3 p) { return sdStatic(undeformL(localP(p))); }

vec3 calcNormal(vec3 p) {
  const vec2 k = vec2(1.0, -1.0);
  float h = 0.0015;
  return normalize(k.xyy * map(p + k.xyy * h).x + k.yyx * map(p + k.yyx * h).x +
                   k.yxy * map(p + k.yxy * h).x + k.xxx * map(p + k.xxx * h).x);
}

vec2 trace(vec3 ro, vec3 rd, int iter, float fog) {
  float t = 0.01;
  float tEnd = min(80.0, 6.0 / max(fog, 0.001));

  for (int i = 0; i < 320; i++) {
    if (i >= iter) break;
    vec2 h = map(ro + rd * t);
    float eps = 0.0015 + 0.00035 * t;
    if (h.x < eps) return vec2(t, h.y);
    t += max(0.95 * h.x / gLip, 0.6 * eps);
    if (t > tEnd) break;
  }
  return vec2(-1.0);
}

// Cube faces keep their six keyed colours - they are how the eye tracks the
// rotation - while the ribbons take the palette.
vec3 material(vec3 p, float id) {
  vec3 pr = undeform(p), ap = abs(pr);

  if (id < 1.5) {
    if (ap.x > ap.y && ap.x > ap.z) return pr.x > 0.0 ? vec3(.90, .24, .18) : vec3(.16, .52, .95);
    else if (ap.y > ap.z)           return pr.y > 0.0 ? vec3(.96, .82, .20) : vec3(.58, .24, .88);
    else                            return pr.z > 0.0 ? vec3(.22, .80, .42) : vec3(.93, .93, .90);
  }

  bool isX = (ap.x > ap.y && ap.x > ap.z);
  bool isY = (!isX) && (ap.y > ap.z);
  float wide = isX ? pr.z : (isY ? pr.x : pr.y);

  // One colour per axis, identical in every cell, so the ribbons match across
  // cell joins and the lattice reads as continuous.
  vec3 col = isX ? mix(vec3(.97, .46, .10), pal(0.08), p_tint)
           : isY ? mix(vec3(.25, .70, .35), pal(0.42), p_tint)
                 : mix(vec3(.08, .55, .62), pal(0.72), p_tint);

  // Pale edges so the ribbon's thickness is visible against its own face.
  return mix(col, vec3(0.85), smoothstep(WID * 0.95, WID * 0.99, abs(wide)));
}

vec3 background(vec3 rd) {
  return mix(vec3(0.0), mix(vec3(.13, .16, .21), pal(0.05) * 0.22, p_tint), 0.2 + 0.5 * rd.y);
}

vec3 render(vec3 ro, vec3 rd, int iter, float fog) {
  vec3 col = background(rd);

  vec2 h = trace(ro, rd, iter, fog);
  if (h.x > 0.0) {
    vec3 p = ro + rd * h.x;
    vec3 n = calcNormal(p);
    vec3 alb = material(p, h.y);

    vec3 L1 = normalize(vec3(.60, .78, .40));
    vec3 L2 = normalize(vec3(-.55, .20, -.60));
    float fre = pow(clamp(1.0 + dot(rd, n), 0.0, 1.0), 4.0);

    vec3 lin = 2.5 * max(dot(n, L1), 0.0) * vec3(1.0, .95, .86);
    lin += 0.55 * max(dot(n, L2), 0.0) * vec3(.45, .62, 1.0);
    lin += 0.25 * max(dot(n, -L1), 0.0) * vec3(.30, .33, .40);
    lin += 0.40 * vec3(.34, .42, .58);
    lin += 0.50 * fre;

    col = alb * lin + 1.1 * pow(max(dot(n, normalize(L1 - rd)), 0.0), 52.0);
    col = mix(col, background(rd), 1.0 - exp(-fog * h.x));
  }

  return col;
}

void main() {
  // One full untangle per cycle. fract() makes it loop, and TURNS = 2 is what
  // makes the loop seamless rather than snapping back.
  gS = fract(uTime / max(p_cycle, 0.5));
  gA = vec2(cos(PI * TURNS * gS), sin(PI * TURNS * gS));
  gLip = lipschitz();

  float an = 0.75 + p_orbit * uTime;
  float el = clamp(0.40 + 0.12 * sin(uTime * 0.13), -1.25, 1.25);

  vec3 ro = p_distance * vec3(cos(an) * cos(el), sin(el), sin(an) * cos(el));
  vec3 ww = normalize(-ro);
  vec3 uu = normalize(cross(ww, vec3(0.0, 1.0, 0.0)));
  vec3 vv = cross(uu, ww);

  // Push the camera out of any cube it happens to be sitting inside - with a
  // repeated domain it will otherwise end up buried every few seconds.
  vec3 lr = localP(ro);
  float cs = sdBox(lr, vec3(H + 0.25));
  if (cs < 0.0) ro -= normalize(lr + 1e-5) * cs;

  vec2 uv = (vUv - 0.5) * 2.0 * vec2(uAspect, 1.0);
  vec3 rd = normalize(uv.x * uu + uv.y * vv + 1.8 * ww);

  vec3 col = render(ro, rd, int(clamp(p_steps, 60.0, 320.0)), p_fog);

  col *= 0.94 + 0.14 * uBeatPulse;
  col = pow(clamp(col, 0.0, 1.0), vec3(0.4545));
  col *= 1.0 - 0.06 * dot(uv, uv);

  fragColor = vec4(col, 1.0);
}
