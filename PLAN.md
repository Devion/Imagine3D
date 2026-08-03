# Imagine3D — Plan

> **Status: built.** All milestones M0–M7 are implemented and verified on a full
> song except the LTX stage, which is written but has not been run end-to-end
> (it needs ComfyUI up with a real API-format graph). See `README.md` for how the
> finished system works and how to extend it. This document is kept as the design
> record — the reasoning behind the architecture, and the risks that were called
> out before building. Where reality differed, it is noted inline below.

An MP3 → demoscene music-video generator. C# / .NET 10 backend, Photino webview UI,
WebGL2 render engine, ComfyUI+LTX for AI video inserts, ffmpeg for the final MP4.

The user picks a project and an MP3. Everything else — scene choice, effect stack,
transitions, where LTX clips go — is decided by the engine from the audio analysis
and the lyrics.

---

## 0. Ground truth (verified on this machine, 2026-08-03)

| Thing | State |
|---|---|
| `D:\Dev\Imagine3D` | **empty** — greenfield, not a git repo |
| .NET SDK | `10.0.302` |
| GPU | RTX 5090 (24 GB) |
| WebView2 runtime | `150.0.4078.105` — present, Photino will work |
| Blender | `C:\Program Files\Blender Foundation\Blender 5.1` — installed, **not on PATH** |
| ComfyUI | `D:\AI\ComfyUI\ComfyUI`, HTTP at `127.0.0.1:8188`, LTX 2.3 present |
| ffmpeg | bundled: `D:\AI\ComfyUI\python_embeded\Lib\site-packages\imageio_ffmpeg\binaries` |
| Sample song | `D:\Dev\Mp3ToVid\mp3\Time.mp3` + `Time.txt` (Style: line, `[section]` markers, lyrics, **no timestamps**) |

### Reusable from `D:\Dev\Mp3ToVid\src` (copy, don't reference — it's an `Exe`)

| File | What it gives us | Change needed |
|---|---|---|
| `Comfy.cs` | ComfyUI client: `EnsureUp` (auto-launches via embedded python), `%TOKEN%` substitution, `/prompt` queue, poll `/history`, download `/view` | swap `Console.WriteLine` for an `IProgress<>` sink so the UI sees it |
| `Ffmpeg.cs` | exe auto-location, `GetDuration` (stderr parse — no ffprobe here), `FitImage`, xfade chain builder | add a **stdin rawvideo pipe** encoder (new, the big addition) |
| `Planner.cs` | `claude`/`codex` CLI subprocess driver with transient-error retry (5/15/45s backoff), both-streams error capture, `ExtractJson` | keep the plumbing, replace the prompt entirely |
| `SongText.cs` | sidecar `.txt` parsing: `Style:`/`Negative:` as authoritative directives + lyric body; `ComposeStyle`/`ComposeNegative` layering | reuse nearly as-is |

Workflows on disk are `LTX2_I2V.json`, `sdxlturbo.json`, `sdxlturbo_img2img.json`
(the Mp3ToVid README names older files — trust `Program.cs`, not the README).

### Asset library `D:\Downloads\mod\`

| Asset | Format | Size | Use |
|---|---|---|---|
| Castelia City | OBJ / FBX / DAE / 3DS (777 files) | 244 MB | city flyby — needs decimation |
| Futuristic City | `.blend` | 232 MB | city flyby — needs Blender export |
| BusGameMap | `.blend` + `.obj` | 99 / 72 MB | terrain/streets |
| McLaren Senna | `.blend` | 140 MB | hero object showcase |
| Dragon (4 variants) | `.blend` | ~14 MB | hero object, has baked actions |
| Intergalactic Spaceship | `.obj` | 4.9 MB | space scenes |
| Space Station Scene | `.obj` | 3.2 MB | space scenes |
| Wolf ×2, Rigged Hand, Pot Plant | `.obj` | < 1 MB | small props, morph targets |

---

## 1. Architecture decision: **the 3D engine runs in the webview**

This is the pivotal fork, so it's stated up front.

**Chosen: WebGL2 (three.js + hand-written GLSL passes) inside the Photino WebView2.**

Why:
- Amiga-demo effects *are* fragment shaders. Shadertoy-grade GLSL is the native
  idiom, and it hot-reloads — you can iterate on an effect without restarting.
- three.js gives OBJ/FBX/DAE/glTF loaders, cameras, scene graph, instancing for free.
- **LTX clips become video textures.** A `<video>` element is a first-class WebGL
  texture, so MUL/XOR/screen/difference blending with the 3D scene is a one-line
  shader op. In a native renderer you'd be decoding video frames by hand.
- **Preview and final render share one code path.** What you scrub is what you get.

Cost: frames must cross the process boundary to reach ffmpeg. Solved in §4.

Escape hatch: the effect contract is GLSL + a uniform block. If WebGL ever caps out,
the same shaders port to Silk.NET/OpenGL with a new host — the effect library survives.

**Foundation decision:** the app embeds a **Kestrel server on `127.0.0.1:<random port>`**
and points Photino at it, rather than loading `file://`. This buys ES module loading,
no CORS pain, HTTP range requests so `<video>` can seek LTX clips, streaming of large
glTF assets, and a place to hang the frame-transfer WebSocket. Bind loopback only.

---

## 2. Solution layout

```
D:\Dev\Imagine3D\
  Imagine3D.slnx
  src\
    Imagine3D.App\              # Photino host + Kestrel + DI wiring
      Program.cs, HostWindow.cs, LocalServer.cs
    Imagine3D.Core\             # domain, no UI deps
      Projects\   ProjectStore.cs, ProjectSettings.cs
      Audio\      Decoder.cs, Fft.cs, OnsetEnvelope.cs, TempoEstimator.cs,
                  BeatTracker.cs, BandEnergy.cs, StructureAnalyzer.cs, Analysis.cs
      Lyrics\     SongText.cs (ported), LyricAligner.cs
      Direct\     IntentPlanner.cs, EffectRegistryIndex.cs, Director.cs, Storyboard.cs
      Media\      Ffmpeg.cs (ported+extended), FramePipe.cs, Muxer.cs
      Comfy\      Comfy.cs (ported), LtxInserts.cs
      Assets\     AssetCatalog.cs, BlenderConverter.cs
      Pipeline\   GenerationPipeline.cs, StageProgress.cs
    Imagine3D.Web\              # static web assets, copied to output
      index.html, app.js, ui\
      engine\     renderer.js, clock.js, modulation.js, expr.js,
                  passes.js, capture.js, registry.js
      effects\    <one folder per effect>   <-- the extensible library
      scenes\     <three.js scene generators>
      shaders\    shared GLSL includes (noise, palettes, sdf, blend modes)
    Imagine3D.Tests\
  workflows\                    # ComfyUI API-format graphs (copied from Mp3ToVid)
  assets\                       # converted/decimated glTF cache (gitignored)
  projects\                     # default project root (gitignored)
```

Per-project directory — the separation the brief asks for:

```
projects\<ProjectName>\
  project.json          aspect, width/height, fps, seed, encoder, ltx settings
  source\song.mp3       the copied root source
  source\song.txt       lyrics/style sidecar, if supplied
  analysis\analysis.json   bpm, beats, downbeats, bars, sections, rms, bands
  analysis\waveform.json   downsampled peaks for the UI
  plan\intent.json         LLM's mood/palette/tag output
  plan\storyboard.json     the resolved effect timeline  <-- editable, re-renderable
  ltx\clip_001.mp4 ...     cached LTX inserts
  ltx\prompts.json         what each clip was asked for (cache key)
  cache\keyframes\         SDXL / captured init frames
  output\song_16x9.mp4
  logs\run_<n>.log
```

Everything is a plain JSON file on disk. A run is inspectable and resumable, and
`storyboard.json` can be hand-edited and re-rendered without touching the analysis.

---

## 3. Audio analysis (pure C#, no Python)

Decode with **NAudio** (`Mp3FileReader` → mono float 44.1 kHz). Everything downstream
is our own DSP so there's no library-availability risk and the output is deterministic.

Pipeline, all landing in `analysis.json`:

1. **STFT** — 2048 window / 512 hop (11.6 ms frames), Hann. Small radix-2 FFT (~80 lines)
   or MathNet.Numerics.
2. **Onset envelope** — half-wave-rectified spectral flux on log-magnitude, per-band
   then summed, normalized by a local median.
3. **Tempo** — autocorrelation of the onset envelope over 60–200 BPM with a log-normal
   prior at 120; report **BPM + confidence**, plus runner-up (catches half/double time).
4. **Beat grid** — Ellis dynamic-programming beat tracker (onset strength vs. tempo
   regularity cost). Output beat times.
5. **Downbeats / bars** — assume 4/4, choose the phase whose beats carry the most
   low-band energy. Group into bars, then 4- and 8-bar **phrases** — these are the
   natural cut points for scene changes.
6. **Level / VU** — per-frame RMS + 6 log-spaced band energies (sub, bass, low-mid,
   mid, high, air), each with a fast-attack/slow-release follower. This is the VU
   the effects react to.
7. **Structure** — MFCC (or chroma) → self-similarity matrix → checkerboard-kernel
   novelty curve → peak-pick boundaries → agglomerative clustering into repeated
   sections (A/B/C). Snap every boundary to the nearest downbeat.

> **Flagged risk:** your own sample (`Time.txt`) literally specifies
> *"Muted kick, irregular heartbeat rhythm"* and *"Uneven percussion"*. Beat tracking
> on deliberately rubato material will be shaky. So: always surface BPM **confidence**
> in the UI, allow **manual BPM + downbeat-offset override** in `project.json`, and
> when confidence is low let the Director lean on **section boundaries and the RMS
> envelope** instead of the beat grid. Design for this from day one, not as a patch.

**Lyric alignment.** The sidecar has no timestamps, so:
- Parse `Style:`/`Negative:` out as authoritative (ported `SongText.cs`).
- Match `[bracketed markers]` to detected structural boundaries in order — they're a
  section map the author already wrote.
- Distribute the plain lyric lines inside each section proportionally by beat count.
- *Later upgrade:* Whisper forced alignment for real word timings. Not needed for PoC.

---

## 4. Render core — deterministic offline capture

The part that makes music-sync exact.

**Not** a realtime screen grab. For each output frame `N`:

1. C# sends `{cmd:"frame", n:N}` over the WebSocket.
2. JS sets the virtual clock to exactly `t = N / fps`, samples the analysis at `t`,
   evaluates every parameter binding, renders the full pass stack to an FBO.
3. `gl.readPixels` → RGBA `ArrayBuffer` → `ws.send(buffer)` (binary, transferable).
4. C# writes those bytes straight into **ffmpeg's stdin** as `-f rawvideo -pix_fmt rgba`.
5. C# acks; only then does JS render frame `N+1`.

Consequences that matter:
- **A/V drift is impossible by construction** — frame N *is* time N/fps, however long
  it took to draw.
- A heavy raymarch frame just makes the render slower, never janky.
- No PNG encode/decode anywhere in the loop.
- 1920×1080 RGBA = 8.3 MB/frame; localhost WS sustains this comfortably. If it ever
  binds, add an async fence + `getBufferSubData` for double-buffered readback.

Encode: `libx264 -crf 18 -preset slow` for compatibility, `h264_nvenc`/`hevc_nvenc`
as a fast option (you have a 5090). Then mux the **original MP3** in — never re-derive
audio. Optional 2× supersample + lanczos downscale for the crisp demoscene look.

**Aspect ratio.** `16:9 → 1920×1080`, `9:16 → 1080×1920`, chosen per render, stored in
`project.json`. Every effect receives `uResolution` and `uAspect`; 3D scenes adjust FOV
and framing rather than stretching. Both orientations get tested in M3 — vertical is
not an afterthought.

**Modulation system** — the glue that makes it feel like the music. Named sources
available to every effect:

| Source | Meaning |
|---|---|
| `t`, `sectionT` | absolute seconds, 0..1 progress through current section |
| `beat`, `bar`, `phrase` | 0..1 sawtooth per beat / bar / phrase |
| `beatPulse`, `barPulse` | exponential-decay envelope, 1.0 at the hit |
| `onset` | onset strength at this instant |
| `rms` | overall level |
| `sub bass lowMid mid high air` | the 6 band followers |
| `energy` | section-level energy class, 0..1 |

Effects declare params as expressions: `{ "zoom": "1.0 + 0.35*beatPulse", "hue": "t*0.05 + bass*0.4" }`.
A ~150-line expression evaluator in JS compiles these once per effect instance. This
means **a new effect becomes beat-reactive without writing any sync code**.

---

## 5. The effect library

The extensibility requirement. **One effect = one folder, auto-discovered.**

```
effects\plasma\
  effect.json     id, name, kind, tags, energyRange, aspects, cost, params schema, defaults
  effect.js       export default class { init(gl, ctx) render(u) dispose() }
  plasma.frag     GLSL
```

`registry.js` globs `effects/*/effect.json` at startup and builds the index; C# reads
the same manifests so the Director can score them. Adding an effect is **one folder
plus zero code changes elsewhere**. Shared GLSL (`noise.glsl`, `palettes.glsl`,
`sdf.glsl`, `blend.glsl`) is `#include`-injected by a tiny preprocessor.

`effect.json` metadata drives selection:

```json
{
  "id": "plasma", "kind": "fullscreen2d",
  "tags": ["amiga", "retro", "psychedelic", "abstract"],
  "energyRange": [0.2, 0.8], "aspects": ["16:9","9:16"], "cost": "low",
  "params": { "scale": {"type":"float","default":"1.0 + 0.3*beatPulse"} }
}
```

### Starter catalogue

**Classic Amiga / demoscene 2D** — plasma (palette-cycled), copper/raster bars,
Kefrens bars, rotozoomer, texture tunnel, bump-mapped tunnel, Doom fire, metaballs,
shadebobs, bobs on lissajous paths, twister, glenz vectors (transparent additive
polyhedra), vector balls / rubber-band, dot-morph point clouds, 2D+3D starfields,
checkerboard floor + horizon, moire/interference rings, water ripple + reflection,
voxel heightmap landscape (Comanche-style), palette cycling, **sine-wave scrolltext**
and per-character wavy lyric text.

**Raymarched fullscreen** — sphere field, Menger sponge, Mandelbulb, Apollonian
gasket, kaleidoscopic IFS (kali set), SDF terrain, **volumetric fBm clouds** (the
"colorful clouds" ask), Mandelbrot/Julia zooms.

**3D scenes (three.js)** — procedural low-poly terrain flyover (simplex fBm, quantized
palette, fog), space flight / asteroid field / wormhole, **city flyby** (Castelia /
Futuristic City), hero-object showcase with beat-driven rim light, procedural greebled
corridor, instanced cube-grid spectrum bars, marching-cubes morphing blob,
wireframe "vector vision" mode, extruded chrome logo/text with env-map.

**Post-processing stack (composable)** — CRT scanlines / aperture grille, VHS chroma
bleed, bloom, god rays, anamorphic streaks, chromatic aberration, barrel distortion,
**feedback/echo buffer** (motion trails, kaleidoscope feedback), datamosh/glitch,
block shuffle, **Amiga palette quantization** (32 / 4096 colours) with Bayer dithering,
posterize, halftone, pixelate/mosaic, radial + zoom blur, motion blur, LUT grading,
hue cycling, vignette, film grain, gate weave.

**Transitions / wipers** — radial wipe, venetian blinds, pixel dissolve, glitch cut,
RGB-split slam, zoom-blur punch, film burn, hard beat cut, luma-ramp wipe.

**LTX blend layer** — normal/alpha, additive, multiply (MUL), screen, overlay,
difference, **XOR** (integer ops on 8-bit), colour dodge/burn; luma key, chroma key,
noise-mask and geometric-mask reveals, beat-gated flicker; LTX clip **as a texture on
3D geometry** (tunnel walls, cube faces, a floating monolith); LTX luminance **as a
displacement source** for a mesh or as plasma input.

### Asset pipeline

A one-time `AssetCatalog` build step, cached in `assets\`:
- `.blend` → glTF via Blender CLI headless (`blender -b in.blend --python-expr "..."`).
  Locate `blender.exe` the same way `Ffmpeg.Locate()` works — it's installed but not
  on PATH.
- `.obj`/`.fbx`/`.dae` → glTF, then **decimate + Draco compress**. Castelia City at
  39 MB OBJ / 777 files will not stream to a webview raw; it needs LOD generation.
- Each converted asset gets an entry with tags (`city`, `vehicle`, `creature`, `prop`,
  `scifi`), bounding box, and triangle count so the Director can pick appropriately
  and stay inside a frame budget.

---

## 6. The Director — the engine picks everything

Per the brief, the user picks only the MP3 and lyrics. Two stages, so it degrades safely:

**Stage A — Intent (LLM, optional).** Reuse `Planner.cs`'s subprocess+retry plumbing
with a new prompt. Input: lyrics, `[markers]`, `Style:` directives, and the *analysis
summary* (BPM, section table with energies, durations). Output `intent.json`: overall
mood, palette family, a tag preference vector per section, escalation points, and
which lyric lines deserve on-screen text.

The LLM **never names effect ids** — it expresses intent. The registry resolves intent
to effects. A babbling or offline LLM degrades to defaults instead of breaking the run.

**Stage B — Resolve (deterministic C#).** Scores every registered effect per section:

```
score = tagMatch(intent, effect.tags)
      + energyFit(section.energy, effect.energyRange)
      + aspectOk(effect, project.aspect)
      - repetitionPenalty(recently used)
      - costPenalty(if frame budget is tight)
      + seededJitter(project.seed)
```

Then assembles the storyboard: one primary scene per section, a stack of 1–3 post
effects, a transition at each boundary (type chosen by boundary strength — hard cut on
a drop, slow dissolve into an outro), text overlays on the chosen lyric lines, and LTX
insert slots. Constraints enforced: no scene repeat within N sections, escalate on
`[drop]`/`[rising]`, calm the outro, keep the whole video inside a frame-time budget.

Seeded from `project.seed` → **the same project always renders the same video**.
"Reroll" is an explicit button that bumps the seed.

Output `storyboard.json` — the fully inspectable, hand-editable contract between the
Director and the renderer.

---

## 7. LTX integration

Reusing the proven Mp3ToVid approach, but as *inserts* rather than the whole video.

- Director picks 4–10 insert points (~5 s each) at strong section boundaries or
  lyrically dense moments.
- Prompts built with the existing 3-layer style composition (author directives →
  global look → section look), so LTX clips match the demo's palette.
- Init frame — two modes:
  1. SDXL txt2img keyframe (`sdxlturbo.json`), or
  2. **a frame captured from our own 3D render at that timestamp.** The demo scene
     becomes the LTX init image, so the AI clip flows *out of* the 3D scene instead of
     cutting to something unrelated. Costs nothing extra — we're already rendering.
- Generate via `LTX2_I2V.json` through the ported `Comfy.cs`.
- **Cache aggressively** in `ltx\`, keyed on the prompt hash. LTX is minutes per clip;
  a re-render must never regenerate them. Whole stage is skippable.
- At render time the clip is a `<video>` texture blended per the storyboard's chosen
  blend mode — it can be a full-frame cut, a ghost layer, or mapped onto geometry.

---

## 8. UI and the generation chain

Photino window → HTML/JS served by the embedded Kestrel.

**Flow:** project picker (new / open / recent) → import MP3 (copied into `source\`,
sibling `.txt` auto-detected) → analysis screen (waveform + beat grid + BPM +
confidence + section blocks + lyrics panel) → options (**16:9 / 9:16**, resolution,
fps, encoder, seed, LTX on/off + count) → **Generate**.

The chain is shown explicitly as a pipeline, each stage with live status, progress and
ETA, each expandable to show its actual output:

```
1  Analyse audio      ██████████ 100%   132 BPM (conf 0.81) · 9 sections · 412 beats
2  Infer intent       ██████████ 100%   claude · "cold ritual dread, frost palette"
3  Build storyboard   ██████████ 100%   9 scenes · 24 effects · 6 transitions
4  Generate LTX       ████░░░░░░  40%   clip 4/10 · ~6m remaining   [skippable]
5  Render frames      ░░░░░░░░░░   0%   0/7104 · — fps · ETA —
6  Encode + mux       ░░░░░░░░░░   0%
```

Progress reaches the UI over the same WebSocket (`IProgress<StageProgress>` from the
pipeline → JSON push). Stage 5 shows a **live thumbnail** of the frame being rendered —
cheap, since the frame is already crossing the wire.

On completion the finished MP4 plays **inline in the app** (`<video>` served over the
local HTTP server, range requests already work), with *Open folder*, *Re-render*,
*Reroll storyboard*, and *Edit storyboard JSON*.

---

## 9. Milestones

Each ends with something runnable.

**M0 — Skeleton.** Photino + Kestrel host, project store, create/open project, import
MP3 into `source\`, `project.json` round-trip. *Done when:* app opens, a project exists
on disk with the MP3 copied in.

**M1 — Analysis.** NAudio decode, FFT, onset, tempo, beat grid, bars, bands, structure;
`analysis.json`; waveform + beat overlay in the UI; manual BPM override.
*Done when:* `Time.mp3` analyses and the beat grid visibly lines up with the waveform,
with an honest confidence number.

**M2 — Render loop end to end.** WebGL2 harness, modulation/expression system, offline
deterministic capture, ffmpeg stdin pipe, mux. Ship **three** effects only (plasma,
starfield, scrolltext). *Done when:* a beat-reactive MP4 with correct audio exists, and
a rendered click-track test confirms zero A/V drift.

**M3 — Effect library.** Build out §5's 2D, raymarch, post and transition sets. Post-stack
composition, feedback buffers, Amiga palette quantization. Verify both aspects.
*Done when:* 30+ effects registered, all render correctly at 16:9 **and** 9:16.

**M4 — 3D layer.** three.js scene host, asset pipeline (Blender CLI conversion,
decimation, Draco, LOD), procedural terrain, space, city flyby, object showcase.
*Done when:* Castelia City flyby renders at target fps within the frame budget.

**M5 — Director.** Intent LLM, registry scoring, storyboard assembly, lyric-to-time
mapping, text overlays, seeded reproducibility. *Done when:* a full video is produced
from MP3 + txt with **no effect chosen by hand**.

**M6 — LTX inserts.** Port `Comfy.cs`, insert planning, prompt layering, 3D-frame-as-init,
blend modes, caching. *Done when:* LTX clips blend into the demo and a re-render reuses
the cache.

**M7 — UI polish.** Pipeline visualization, live thumbnails, result playback, reroll and
storyboard editing, error surfacing.

---

## 10. Risks, with mitigations

| Risk | Mitigation |
|---|---|
| **WebView2 falls back to software WebGL** (SwiftShader) → unusable render speed | Verify GPU rasterization on day one of M2; enable devtools in Photino; pass GPU-forcing browser args. This is a go/no-go check *before* building the effect library. **Outcome:** hardware path confirmed, 55–68 fps at 1080p. The real blocker was different — WebView2 needs an **STA** thread, and top-level statements resume on an MTA thread-pool thread after `await app.StartAsync()`, so the native window appeared but the webview never initialised. The UI now runs on an explicit STA thread. |
| **Beat tracking fails on rubato material** (your own sample is deliberately irregular) | Report confidence; manual BPM + downbeat override; Director falls back to section boundaries + RMS envelope when confidence is low. Designed in from M1. |
| **Huge assets** — 244 MB Castelia, 232 MB `.blend` | Offline conversion + decimation + Draco to a cached `assets\` library; triangle budgets in the catalogue; never load raw source files at render time. |
| **LTX is slow** (minutes per 5 s clip) | Prompt-hash cache, backgroundable and fully skippable stage, honest ETAs. Never on the critical path for iterating on effects. |
| **`readPixels` stalls the GL pipeline** | Acceptable and *wanted* for offline lockstep. If throughput binds, add fence + `getBufferSubData` double-buffering. |
| **Frame transfer volume** (8.3 MB/frame × thousands) | Binary WS + ack backpressure keeps memory flat; raw RGBA straight into ffmpeg avoids any encode round-trip. |
| **Non-reproducible output** | One `seed` in `project.json` feeds every RNG; reroll is explicit. |
| **LLM unavailable / returns garbage** | Intent stage is optional; the deterministic scorer produces a complete storyboard on its own. |

---

## 11. Open choices (defaults picked, easy to change)

- **Project root** — defaults to `D:\Dev\Imagine3D\projects`, overridable in settings.
- **Encoder** — `libx264 -crf 18` default; `h264_nvenc` available for speed.
- **fps** — 30 default (24 for a filmic look, 60 for hard beat-sync snap).
- **Lyric timing** — structure-proportional distribution now; Whisper forced alignment
  is the later upgrade.
- **git** — `Imagine3D` is not a repo yet. Worth `git init` before M0, with `projects\`,
  `assets\`, `bin\`, `obj\` ignored.
