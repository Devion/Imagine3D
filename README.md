# Imagine3D

Turns an MP3 into an Amiga-demoscene-style music video. The engine picks every
scene, effect and transition from the audio and the lyrics — you supply the song.

- **.NET 10** backend, **Photino** desktop window, **WebGL2** render engine.
- Audio analysis (BPM, beats, bars, sections, six-band VU) is written in C#, no Python.
- **60 effects**, each one folder. Adding one needs no code changes anywhere else.
- Lyrics are timed against the actual vocal by Whisper forced alignment.
- Scenes **blend** as well as cut — 15 transitions plus sustained layering.
- Renders **1080p at ~50–68 fps** on an RTX 5090 — a 5:42 song encodes in about 3 minutes.
- Optional AI video inserts (LTX via ComfyUI) blended in with screen/multiply/XOR.

```
dotnet run --project src/Imagine3D.App          # desktop window
dotnet run --project src/Imagine3D.App -- --serve  # backend only, open in a browser
dotnet run --project src/Imagine3D.Tests        # DSP unit tests + analysis report
```

---

## How a video gets made

```
0  Align lyrics       Whisper (word timestamps) -> sequence-align against the
                      author's lyrics -> anchors -> interpolate.  Cached.
1  Analyse audio      NAudio decode -> STFT -> onsets -> tempo -> beat grid ->
                      bars -> 6-band VU -> MFCC self-similarity -> sections
2  Infer intent       claude/codex CLI reads the lyrics, returns mood + palette +
                      per-section TAGS (never effect names)
3  Build storyboard   deterministic scorer resolves tags -> effects, picks post
                      stacks, transitions, text cues.  Seeded = reproducible
4  Generate LTX       optional; ComfyUI + LTX 2.3, cached by prompt hash
5  Render frames      lockstep, frame N drawn at exactly t = N/fps
6  Encode + mux       raw RGBA -> ffmpeg stdin -> H.264 + the original MP3
```

Every stage writes plain JSON to the project folder, so any of them can be
inspected, hand-edited and re-run without redoing the others.

To render an edited storyboard exactly as written — no director, no LLM:

```
POST /api/projects/<name>/generate   {"useExistingStoryboard": true}
```

Swap an `effectId`, change a parameter expression, delete a scene, retune a
`blend`, then re-render. A plain **Generate** also renders what is on disk —
this is the stricter form, which additionally skips the LTX stage and never
re-plans, whatever the settings say.

**Trimmed copy.** `saveTrimmedCopy` writes a shortened version alongside the full
render — `song_16x9_4min.mp4` — for platforms with a length or size cap. The full
render is always kept.

`trimTargetMb` sets a size ceiling:

- **0** — stream copy. Instant and lossless, but it inherits the source bitrate.
- **>0** — two-pass re-encode at a bitrate computed from the ceiling and the
  clip length, minus 3% for container overhead.

Two-pass rather than single-pass ABR because the point is an upload limit: given
a full first-pass analysis, x264 lands within a couple of percent, where
single-pass overshoots on content whose complexity swings as much as a demo's.
Measured on the 5:42 test song, 4 minutes at a 185 MB ceiling: **179.5 MB, 97% of
the limit, 56 seconds to encode.**

If the clip would already be under the ceiling, it falls back to the stream copy
rather than re-encoding to reach a size it is already below. If the ceiling is
too small to be reachable it says so and leaves the full render alone.

```
dotnet run --project src/Imagine3D.Tests -- --trim <video.mp4> [minutes] [targetMb]
```

### How lyrics get their timing

Whisper transcribes the song with word-level timestamps. On a dense mix that
transcript is largely wrong — under half its words match the real lyrics — but it
does not need to be right, only right *often enough*. The author's `song.txt` is
the truth for **what** is sung; Whisper only has to say **when**.

A Needleman–Wunsch alignment between the two word sequences finds where they
agree. Those agreements become anchors and everything between them is
interpolated. Three filters keep bad anchors out, and they matter more than the
transcription quality does — one confidently-wrong word drags every line around
it:

- **Confidence, calibrated per song.** Whisper's `no_speech_prob` sits around
  0.84 for a *sung* track, because singing does not sound like speech to it, so
  an absolute threshold rejects everything. Only its spread within one song is
  informative, so the cut is taken from that song's own distribution.
- **Robust outlier rejection** against a straight fit of time against word index,
  scaled by median absolute deviation.
- **A rate check** — clusters of mutually-agreeing bad anchors survive a linear
  fit but show up as a dozen lyric lines crammed into one second, so consecutive
  anchors must leave a plausible minimum time per word.

On the test song this anchors **51% of lines** directly to the audio. The rest
are interpolated between them, which is far better than the fallback but is not
the same as every line being frame-exact. Coverage is reported in the analysis
panel, so the timing can be trusted on evidence rather than on faith. With no
Whisper-capable Python present, it falls back to distributing lines across
detected sections and says so.

### Matching the music's energy

`energyRange` in a manifest is a **hard gate**, not a preference. An effect that
declares `[0.5, 1.0]` cannot be chosen for a section at energy 0.2 no matter how
well its tags match — it was one weighted term among several, and a broadly
tagged effect could out-argue it, which is how `lightning` ended up over a quiet
passage. Only if nothing in the library covers an energy does the gate widen.

Inside the band, being near its middle scores higher, and a *narrow* band scores
higher than a wide one — declaring `[0.5, 0.7]` is a specific claim about where
an effect belongs and is rewarded over `[0, 1]`.

The post-processing stack scales with energy too, down to **nothing at all**
below 0.24. That emptiness is deliberate: it is what gives the loud sections
somewhere to arrive from.

So tag `energyRange` honestly. It is the strongest signal in the system.

### Iterating without rendering

Choosing scenes takes under two seconds; rendering them takes minutes. Three
buttons, and the equivalent API calls:

| Button | Body | What runs |
|---|---|---|
| **Analyse audio** | `POST .../analyze?useLlm=` | analyse → intent → director, writes `storyboard.json` |
| **Redo storyboard** | `{"planOnly": true}` | intent → director again, writes `storyboard.json`, stops |
| **Render this storyboard** | `{"useExistingStoryboard": true}` | renders the file on disk verbatim, LTX stage skipped |
| **Generate video** | `{}` | LTX → render → encode, using the plan on disk |

**Generate renders the storyboard on screen.** It only calls the director when
there is no plan yet, or when the one on disk stopped describing this video —
a different aspect or fps, a song of a different length, a seed typed by hand.
Nothing downstream of the director (encoder, CRF, trim) is grounds for a
re-plan, so a list you have read and hand-edited is the list that gets rendered.

*Reroll* bumps the seed and re-plans immediately, so a new seed has a visible
consequence. The normal loop is: reroll or re-plan until the scene list reads
well, then render once.

A fresh seed is rolled at every **plan** when `randomSeedEachRun` is on — not at
every render, which used to mean the storyboard you were reading was rebuilt
from a different RNG stream the moment you pressed Generate.

### Cuts and blends

A scene either **cuts** into the previous one through one of 15 transitions, or
**blends** with it — the two run layered for a stretch, composited with
screen/add/multiply/difference/softlight, ramping in and out so it never pops.
The director holds blending back where the music genuinely breaks (a big energy
jump or a strong section boundary earns a hard cut) and uses it elsewhere;
roughly a quarter to a third of scene changes end up blended.

Transitions carry a repetition penalty, the same as scenes. Without it the
best-matching transition wins every comparable boundary — one shader ended up
carrying nine of twenty edits and the video read as repetitive.

### Why the render loop is built this way

The server asks the page for **one frame at a time** and waits for the pixels
before asking for the next. Frame N is always drawn at `t = N/fps`, however long
it took to draw frame N-1, so **audio/video drift is impossible by construction**
rather than something that has to be corrected. It also gives natural
backpressure: the page can never run ahead of ffmpeg.

Pixels go straight from `gl.readPixels` into ffmpeg's stdin as raw RGBA — nothing
is ever PNG-encoded or written to disk mid-render.

---

## Project layout

```
projects/<Name>/
  project.json          aspect, fps, seed, encoder, LTX settings
  source/song.mp3       the imported source (+ song.txt if supplied)
  analysis/analysis.json   bpm, beats, downbeats, sections, rms, bands
  plan/intent.json         what the LLM understood the song to be about
  plan/storyboard.json     the resolved effect timeline — editable
  ltx/clip_001.mp4 ...     cached AI clips
  output/song_16x9.mp4
```

`song.txt` next to the MP3 is picked up automatically:

```
Style:    cold, clockwork, frost        # authoritative — survives into every prompt
Negative: text, watermark               # things to avoid
[Whispered vocal]                       # section markers map to detected boundaries
Do not speak my hidden name             # lyric lines become on-screen text
```

---

## Adding an effect

One folder under `src/Imagine3D.Web/effects/<id>/`. It is discovered on the next
request — no rebuild, no registration, no list to edit.

```
effects/plasma/
  effect.json     metadata + parameters
  shader.frag     the effect
```

```json
{
  "id": "plasma", "name": "Plasma", "kind": "scene2d",
  "tags": ["amiga", "retro", "psychedelic"],
  "energyRange": [0.1, 0.7], "cost": "low",
  "params": { "scale": { "type": "float", "default": "2.4 + 0.8*beatPulse" } }
}
```

Parameters are **expressions over the music**, so an effect becomes beat-reactive
without containing any sync code:

| source | meaning |
|---|---|
| `beat` `bar` `phrase` | 0..1 sawtooth per beat / bar / 4-bar phrase |
| `beatPulse` `barPulse` | exponential decay, 1.0 on the hit |
| `onset` | transient strength |
| `rms` `energy` | level now / section energy |
| `sub bass lowMid mid high air` | the six band followers |
| `t` `sceneT` `sectionT` | seconds, progress through scene/section |

Functions: `sin cos abs min max clamp mix smoothstep step pow sqrt floor fract mod noise`.

The shader gets `uResolution uAspect uTime uBeatPulse uBass …`, the run's five
palette stops as `uPal0..4`, and one `p_<name>` uniform per declared parameter.
Shared GLSL is available via `#include`:

```glsl
#include "common.glsl"   // rot, hashes, bayer4, quantize, hsv
#include "noise.glsl"    // valueNoise, gradNoise, fbm, ridged, fbm3
#include "palette.glsl"  // pal(), palClamp(), palSteps()
#include "blend.glsl"    // blendMode() incl. multiply, screen, difference, XOR
#include "sdf.glsl"      // primitives, raymarch(), softShadow(), AO
```

`kind` is one of `scene2d`, `raymarch`, `scene3d`, `post`, `transition`.
Set `"module": true` and supply `effect.js` instead when the effect needs real
geometry (see `meshshowcase`, `meshflyby`).

**Keep `tags` honest.** The director normalises tag overlap by how many tags an
effect declares, because raw overlap rewards breadth — an effect tagged with
eight moods matches nearly every section and crowds out focused ones. Tag an
effect with what it actually is, not with everything it could conceivably suit.

**Two recurring shader mistakes**, both of which produced a black or white frame
here before being caught by the contact sheet:

- *Gain on accumulated glow.* Summing `1/d` over 100 steps produces numbers in
  the thousands. Pick the normalisation by reasoning about the actual range, then
  `tanh` it — a `col/(1+col)` on an already-huge sum just clips to white.
- *Powers on noise.* fBm sits near 0.5, so `pow(n, 6.0)` is 0.015 and forty steps
  of it is invisible. Check what your shaping function does to the value range.
- *Hard-edged full-width bands.* Anything that draws a stripe across the whole
  frame — a raster bar, a scanline artefact — has to be anti-aliased in **pixel**
  units (`1.5 / uResolution.y`), not as a fraction of the band, and should fall
  off toward its own edges so it doesn't meet the background as a contrast step.
  Never invert or blow out a row outright: modulate what is already there.
  Both effects that got this wrong looked like damage to the render rather than
  to the picture.

### Seeing what you made

```
POST /api/devsheet?kind=all&palette=neon
```

Renders every effect into a labelled contact sheet and writes it to
`%TEMP%\imagine3d-shots\`. `preview.html` is the interactive version. This is the
fastest way to check a new shader, and it reloads the page first so edits to the
engine modules take effect.

---

## 3D assets

```
POST /api/assets/build?source=D:\Downloads\mod
```

Runs Blender headless over a model library and normalises everything —
`.blend`, `.fbx`, oversized `.obj` — into one decimated OBJ per asset, plus a
catalogue with triangle counts and inferred tags. Blender is located
automatically; it does not need to be on PATH.

Two quirks of real model libraries are handled explicitly:

- **Studio backdrops.** Many `.blend` files ship a cyclorama or ground plane
  around the subject. Framing on the bounding box shows the backdrop and hides
  the car. Meshes therefore carry *core bounds* (2nd–98th percentile of vertex
  positions) and the showcase scene draws only the geometry inside them.
- **Inconsistent winding.** Back-face culling is off and `gl_FrontFacing` flips
  the normal instead, so a model authored with reversed faces still lights.

---

## On the Shadertoy references

Several effects here implement *techniques* that are well known from Shadertoy —
folded-space fractals, kaleidoscopic IFS tunnels, glow-accumulation corridors,
octave-summed ocean waves. They are written from scratch against this library's
uniform, palette and modulation contract; none of them is a copy, and each names
its reference in a comment.

Two of the shaders in `D:\shader\` (`9.txt`, `12.txt`) are **Inigo Quilez's**, and
carry an explicit licence: *"You cannot use this Work in any commercial or
non-commercial product, website or project"*, altered or not. Those were not
ported and should not be. Three more (`8`, `13`, `14` — including nimitz's
"Protean clouds") are **CC BY-NC-SA**, which does permit adaptation for a
non-commercial project with attribution and share-alike; they were left alone
pending your call on whether you want that licence attached to the output.

## Notes and limits

- **Beat tracking on rubato material is unreliable.** Confidence is reported
  everywhere; below 0.4 the director falls back to section boundaries and the RMS
  envelope instead of the beat grid. The UI has a manual BPM override.
- **Lyric timing is anchored, not exact.** About half the lines get a real audio
  anchor on a dense mix; the rest are interpolated between them. Coverage is
  reported in the UI. A cleaner vocal will anchor far more. `whisperModel` in
  `project.json` trades speed for anchors (`medium` is the default and the best
  balance measured here); `lyricAlignment` can force or disable it.
- **LTX inserts are verified end-to-end.** The app launches ComfyUI if it is not
  already up (~35s), renders a frame of the demo as the init image, generates the
  clip and blends it in. Clips are cached by prompt hash, so a re-render never
  regenerates them.
- Seeded from `project.json`: the same project always renders the same video.
  *Reroll* bumps the seed deliberately.

## Requirements

- .NET 10 SDK, WebView2 runtime (present on Windows 11)
- ffmpeg — auto-located from ComfyUI's bundled `imageio_ffmpeg`, or on PATH
- Blender — only for building the 3D asset catalogue
- Python with `openai-whisper` + torch — only for lyric alignment. ComfyUI's
  embedded interpreter already has both and is found automatically.
- `claude` or `codex` on PATH — only for the optional intent stage
- ComfyUI with LTX 2.3 — only for the optional AI video inserts
