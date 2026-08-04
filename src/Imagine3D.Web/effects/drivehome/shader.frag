#include "common.glsl"
#include "palette.glsl"

// "The Drive Home", after Martijn Steinrucken (BigWings).
//
// There is no geometry and no march. Every light is a point in 3D scored against
// the camera ray by its perpendicular distance, turned into a soft disc - a bokeh
// mask. Stack enough of those on a few scrolling loops and it reads as a motorway.
//
// The rain is the good part: the drops are never drawn. GetDrops returns a 2D
// offset that is subtracted from the ray's target on the image plane, so the drops
// only exist as a displacement of everything behind them. That is also physically
// what a drop on glass does.

#define S(a, b, t) smoothstep(a, b, t)

// The camera ray, set up once per pixel by cameraSetup and read by every light.
vec3 ro = vec3(0.0);
vec3 rd = vec3(0.0);

float hash1(float t) {
  return fract(sin(t * 10234.324) * 123423.23512);
}

// 3 out, 1 in - Dave Hoskins.
vec3 hash31(float p) {
  vec3 p3 = fract(vec3(p) * vec3(0.1031, 0.11369, 0.13787));
  p3 += dot(p3, p3.yzx + 19.19);
  return fract(vec3((p3.x + p3.y) * p3.z, (p3.x + p3.z) * p3.y, (p3.y + p3.z) * p3.x));
}

float distLine(vec3 o, vec3 d, vec3 p) {
  return length(cross(p - o, d));
}

float remap(float a, float b, float c, float d, float t) {
  return ((t - a) / (b - a)) * (d - c) + c;
}

// A light as seen by this ray: a disc whose softness is the lens blur. The inner
// step is what gives the bokeh its slightly brighter rim.
float bokehMask(vec3 o, vec3 d, vec3 p, float size, float blur) {
  float dist = distLine(o, d, p);
  float m = S(size, size * (1.0 - blur), dist);
  m *= mix(0.7, 1.0, S(0.8 * size, size, dist));
  return m;
}

// A sawtooth with rounded corners, and its derivative. The drop slides fast then
// hangs, which is what real drops on glass do.
float sawTooth(float t) {
  return cos(t + cos(t)) + sin(2.0 * t) * 0.2 + sin(4.0 * t) * 0.02;
}

float deltaSawTooth(float t) {
  return 0.4 * cos(2.0 * t) + 0.08 * cos(4.0 * t) - (1.0 - sin(t)) * sin(t + cos(t));
}

// Returns a refraction offset, not a colour. One drop per cell, plus the trail it
// leaves behind as it slides.
vec2 getDrops(vec2 uv, float seed) {
  float t = uTime;

  uv.y += t * 0.05;
  uv *= vec2(10.0, 2.5) * 2.0;

  vec2 id = floor(uv);
  vec3 n = hash31(id.x + (id.y + seed) * 546.3524);

  vec2 bd = fract(uv) - 0.5;
  bd.y *= 4.0;
  bd.x += (n.x - 0.5) * 0.6;

  t += n.z * TAU;
  float slide = sawTooth(t);

  float ts = 1.5;
  vec2 trailPos = vec2(bd.x * ts, (fract(bd.y * ts * 2.0 - t * 2.0) - 0.5) * 0.5);

  bd.y += slide * 2.0;

  // The drop stretches while it accelerates and rounds up when it stalls.
  bd.y += bd.x * bd.x * deltaSawTooth(t);

  float d = length(bd);

  // Trail only exists above the drop, and thins as it goes.
  float trailMask = S(-0.2, 0.2, bd.y) * bd.y;
  float td = length(trailPos * max(0.5, trailMask));

  float mainDrop = S(0.2, 0.1, d);
  float dropTrail = S(0.1, 0.02, td) * trailMask;

  return mix(bd * mainDrop, trailPos, dropTrail);
}

void cameraSetup(vec2 uv, vec3 pos, vec3 lookat, float zoom) {
  ro = pos;

  vec3 f = normalize(lookat - ro);
  vec3 r = cross(vec3(0.0, 1.0, 0.0), f);
  vec3 u = cross(f, r);

  float t = uTime;

  // Tilt the drop field slowly, as though the car is leaning through bends.
  float x = (sin(t * 0.1) * 0.5 + 0.5) * 0.5;
  x = -x * x;
  vec2 dropUv = rot(-x) * uv;
  dropUv.x += -sin(t * 0.1) * 0.5;

  // Three scales of drop, plus a fine ripple for the sheet of water between them.
  vec2 offs = getDrops(dropUv, 1.0);
  offs += getDrops(dropUv * 1.4, 10.0);
  offs += getDrops(dropUv * 2.4, 25.0);

  float ripple = sin(t + uv.y * PI * 30.0 + uv.x * 124.0) * 0.5 + 0.5;
  ripple *= 0.005;
  offs += vec2(ripple * ripple, ripple);

  offs *= p_rain;

  // Subtracting the offset from the image-plane target is the whole refraction.
  vec3 center = ro + f * zoom;
  vec3 i = center + (uv.x - offs.x) * r + (uv.y - offs.y) * u;

  rd = normalize(i - ro);
}

vec3 headLights(float i, float t, vec3 col) {
  float z = fract(-t * 2.0 + i);
  vec3 p = vec3(-0.3, 0.1, z * 40.0);
  float d = length(p - ro);

  float size = mix(0.03, 0.05, S(0.02, 0.07, z)) * d;
  float blur = 0.1;

  float m = 0.0;
  m += bokehMask(ro, rd, p - vec3(0.08, 0.0, 0.0), size, blur);
  m += bokehMask(ro, rd, p + vec3(0.08, 0.0, 0.0), size, blur);
  m += bokehMask(ro, rd, p + vec3(0.10, 0.0, 0.0), size, blur);
  m += bokehMask(ro, rd, p - vec3(0.10, 0.0, 0.0), size, blur);

  // Ninth power: oncoming cars stay dim until they are almost past, then flare.
  float distFade = max(0.01, pow(1.0 - z, 9.0));

  // The reflection of the headlights in the wet road, below and much softer.
  blur = 0.8;
  size *= 2.5;
  float r = 0.0;
  r += bokehMask(ro, rd, p + vec3(-0.09, -0.2, 0.0), size, blur);
  r += bokehMask(ro, rd, p + vec3(0.09, -0.2, 0.0), size, blur);
  r *= distFade * distFade;

  return col * (m + r) * distFade;
}

vec3 tailLights(float i, float t, vec3 col) {
  t = t * 1.5 + i;

  float id = floor(t) + i;
  vec3 n = hash31(id);

  float laneId = S(0.5, 0.51, n.y);
  float ft = fract(t);
  float z = 3.0 - ft * 3.0;              // distance ahead

  laneId *= S(0.2, 1.5, z);              // pull over as we close on them
  float lane = mix(0.6, 0.3, laneId);

  vec3 p = vec3(lane, 0.1, z);
  float d = length(p - ro);

  float size = 0.05 * d;
  float blur = 0.1;

  float m = bokehMask(ro, rd, p - vec3(0.08, 0.0, 0.0), size, blur)
          + bokehMask(ro, rd, p + vec3(0.08, 0.0, 0.0), size, blur);

  // Brake lights come on at a random distance and hold for a random duration.
  float bs = n.z * 3.0;
  float brake = S(bs, bs + 0.01, z) * S(bs + 0.01, bs, z - 0.5 * n.y);
  m += (bokehMask(ro, rd, p + vec3(0.10, 0.0, 0.0), size, blur) +
        bokehMask(ro, rd, p - vec3(0.10, 0.0, 0.0), size, blur)) * brake;

  float refSize = size * 2.5;
  m += bokehMask(ro, rd, p + vec3(-0.09, -0.2, 0.0), refSize, 0.8);
  m += bokehMask(ro, rd, p + vec3(0.09, -0.2, 0.0), refSize, 0.8);

  vec3 outp = col * m * ft;

  // Indicator, on the side they are pulling toward.
  float b = bokehMask(ro, rd, p + vec3(0.12, 0.0, 0.0), size, blur);
  b += bokehMask(ro, rd, p + vec3(0.12, -0.2, 0.0), refSize, 0.8) * 0.2;

  vec3 blinker = vec3(1.0, 0.7, 0.2);
  blinker *= S(1.5, 1.4, z) * S(0.2, 0.3, z);
  blinker *= sat(sin(t * 200.0) * 100.0);   // hard square wave
  blinker *= laneId;

  return outp + blinker * b;
}

vec3 streetLights(float i, float t, vec3 col) {
  float side = sign(rd.x);
  float offset = max(side, 0.0) * (1.0 / 16.0);   // stagger the two sides
  float z = fract(i - t + offset);

  vec3 p = vec3(2.0 * side, 2.0, z * 60.0);
  float d = length(p - ro);

  float distFade = remap(1.0, 0.7, 0.1, 1.5, 1.0 - pow(1.0 - z, 6.0)) * (1.0 - z);

  return bokehMask(ro, rd, p, 0.05 * d, 0.1) * distFade * col;
}

vec3 environmentLights(float i, float t, vec3 warm, vec3 cool) {
  float n = hash1(i + floor(t));

  float side = sign(rd.x);
  float offset = max(side, 0.0) * (1.0 / 16.0);
  float z = fract(i - t + offset + fract(n * 234.0));
  float n2 = fract(n * 100.0);

  vec3 p = vec3((3.0 + n) * side, n2 * n2 * n2, z * 60.0);
  float d = length(p - ro);

  float distFade = remap(1.0, 0.7, 0.1, 1.5, 1.0 - pow(1.0 - z, 6.0));
  float m = bokehMask(ro, rd, p, 0.05 * d, 0.1) * distFade * distFade * 0.5;

  // Occlusion by whatever is between us and the buildings - trees, barriers.
  m *= 1.0 - pow(sin(z * TAU * 20.0 * n) * 0.5 + 0.5, 20.0);

  vec3 randomCol = vec3(fract(n * -34.5), fract(n * 4572.0), fract(n * 1264.0));
  vec3 col = mix(cool, warm, fract(n * -65.42));
  col = mix(col, randomCol, n);

  return m * col * 0.2;
}

void main() {
  vec2 uv = (vUv - 0.5) * vec2(uAspect, 1.0);

  // Light colours: sodium street lamps, blue-white headlights, red tail lights.
  // These are most of what makes the scene legible as a road, so the palette only
  // pulls them part of the way.
  vec3 streetCol = mix(vec3(1.0, 0.7, 0.3), pal(0.12), p_tint);
  vec3 headCol   = mix(vec3(0.8, 0.8, 1.0), pal(0.62), p_tint);
  vec3 tailCol   = mix(vec3(1.0, 0.1, 0.1), pal(0.0), p_tint);

  // Suspension: a stepped random walk at 5Hz, cubed so most of the ride is smooth
  // and the occasional bump is sharp.
  float bt = uTime * 5.0;
  float bumps = mix(hash1(floor(bt)), hash1(floor(bt + 1.0)), fract(bt)) * 0.1;
  bumps = bumps * bumps * bumps * p_shake;

  vec3 pos = vec3(0.3, 0.15 + bumps, 0.0);
  float lookatY = pos.y + bumps;

  // Drift between looking down the lane and looking across it.
  vec3 lookat = mix(vec3(0.3, lookatY, 1.0), vec3(0.0, lookatY, 0.7),
                    sin(uTime * 0.1) * 0.5 + 0.5);

  uv.y += bumps * 4.0;
  cameraSetup(uv, pos, lookat, 2.0);

  float t = uTime * p_speed;

  vec3 col = vec3(0.0);

  const float stp = 1.0 / 8.0;
  for (float i = 0.0; i < 1.0; i += stp) col += streetLights(i, t, streetCol);
  for (float i = 0.0; i < 1.0; i += stp) {
    float n = hash1(i + floor(t));
    col += headLights(i + n * stp * 0.7, t, headCol);
  }

  for (float i = 0.0; i < 1.0; i += 1.0 / 32.0)
    col += environmentLights(i, t, streetCol, tailCol);

  col += tailLights(0.0, t, tailCol);
  col += tailLights(0.5, t, tailCol);

  // Sky. Everything above the horizon gets a wash, which is what stops the top of
  // the frame being empty black.
  col += sat(rd.y) * mix(vec3(0.6, 0.5, 0.9), pal(0.78), p_tint);

  col *= p_flare;

  fragColor = vec4(col, 1.0);
}
