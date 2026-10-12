# Imagine3D

Turns an MP3 into an Amiga-demoscene-style music video. The engine picks every
scene, effect and transition from the audio and the lyrics — you supply the song.

- **.NET 10** backend, **Photino** desktop window, **WebGL2** render engine.
- Audio analysis (BPM, beats, bars, sections, six-band VU) is written in C#, no Python.
- **93 effects**, each one folder. Adding one needs no code changes anywhere else.
- Lyrics are timed against the actual vocal by Whisper forced alignment.
- Scenes **blend** as well as cut — 15 transitions plus sustained layering.
- Drop your own **images** into a project and the director casts them into it.
- Renders **1080p at ~50–68 fps** on an RTX 5090 — a 5:42 song encodes in about 3 minutes.
- Optional AI video (LTX via ComfyUI) blended in with screen/multiply/XOR — as a
  few inserts, or running continuously underneath the effects.

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
4  Generate LTX       optional; ComfyUI + LTX 2.3, cached by prompt hash.  A few
                      inserts, or whole scenes tiled end to end (see AI video)
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

### How lyrics get drawn

Ten treatments, chosen per section by `Director.BuildTexts` from what the music
is doing there — its energy, the song's tempo, whether the beat grid is worth
trusting, the section's own spectral tilt, and how fast its words arrive. Every
line in a section gets the same one, because a treatment that changes line to
line reads as a fault rather than as an idea. A line the treatment has no room
for is downgraded to one that fits: a wipe across half a second is a flash, not a
wipe.

| | |
|---|---|
| `karaoke` | the whole line is up and legible; the *lit* word tracks the vocal |
| `cascade` | one word per beat, dropped in off the tracked grid and left alone |
| `spectrum`| each column of letters rides the band living at that part of the frame |
| `shockwave`| a ring leaves the middle of the line on every beat and passes through it |
| `drift` | each word bobbing on its own slow phase, swelling with the take |
| `shatter` | slices tear sideways on a real transient and are back within a fraction of a beat |
| `wave` `slam` `fade` `scroll` | the originals: Amiga scroller, beat punch, soft fade, marquee |

Two rules bind all of them, and `effects/textcomposite/shader.frag` is written
around them. **Readable**: motion returns to rest, letterforms are never
permanently warped, no word is held dark long enough to be missed. **On time**:
every one is driven by something the music is doing — a beat off the tracked
grid, a band follower, or the singer's own position in the line — never by a
free-running timer.

What makes the per-word treatments possible is that `engine/textlayer.js` puts
more than a mask in the text raster. The alpha channel is the glyphs; the colour
channels carry, per word, where it sits in the line's reading order, a stable
random of its own, and which wrapped row it is on. Reading order is measured in
*characters*, not words, because "the" and "everything" are one word each and
nowhere near one beat each. It costs nothing at render time — the raster is
still drawn once per line and cached.

```
dotnet run --project src/Imagine3D.Tests -- --lyrics
```

reports which treatment every section of every analysed project draws, with the
tempo and the cue lengths each one ends up carrying — a style whose mean line is
under a second is being asked to do something it cannot.

### Matching the music's energy

`energyRange` in a manifest is a **hard gate**, not a preference. An effect that
declares `[0.5, 1.0]` cannot be chosen for a section at energy 0.2 no matter how
well its tags match — it was one weighted term among several, and a broadly
tagged effect could out-argue it, which is how a `[0.5, 1.0]` shader ended up
over a quiet passage. Only if nothing in the library covers an energy does the
gate widen.

Inside the band, being near its middle scores higher, and a *narrow* band scores
higher than a wide one — declaring `[0.5, 0.7]` is a specific claim about where
an effect belongs and is rewarded over `[0, 1]`.

The post-processing stack scales with energy too, down to **nothing at all**
below 0.24. That emptiness is deliberate: it is what gives the loud sections
somewhere to arrive from.

So tag `energyRange` honestly. It is the strongest signal in the system.

### The clock the effects run on

`uTime` is not the song's clock. Two things are done to it in
`engine/modulation.js`, and both exist because of the same complaint: effects
that feel obnoxiously fast against the music.

**It is paced to the tempo.** Every free-running rate in the library is in
wall-clock seconds — `uTime * p_speed` in a shader, `m.t` in a module effect, a
`sin(t*0.2)` in a storyboard expression — so a scene runs at exactly the same
rate over a 70 BPM ballad as over a 140 BPM dance track. The beat-driven sources
were never the problem; `beatPulse`, `bar` and the band followers already move
with the song. It is the motion underneath them, which nothing was pacing.
120 BPM is the reference. Below it the correction is proportional, because a
slow song's beats are longer and proportionally more of every cycle was landing
inside one; above it it is square-rooted and barely moves, since there is no
evidence the library is too *slow* on fast material. An untrustworthy tempo
estimate disables it — pacing a whole video to a wrong number is worse than not
pacing it.

**It restarts at each scene.** Almost every manifest modulates its speed with the
music: `0.28 + 0.16*rms + 0.15*midRel`. The music moving the speed a little every
frame is the point, but `uTime * speed` turns that wobble into a phase jump the
size of *t* — seven minutes in, a one percent flicker in `rms` is several seconds
of animation inside one frame. The effect stops being fast and becomes random,
and it gets worse the longer the song runs. Integrating the rate is the textbook
answer, but `renderAt(t)` has to stand alone — the preview scrubs and the encoder
asks for arbitrary frames — so there is no running phase to accumulate into.
Restarting the clock each scene bounds the multiplier instead, and it costs
nothing: the boundary it jumps at is a cut or a transition, where the picture is
being replaced anyway. Measured over this repo's own plans it takes mean
frame-to-frame correlation from 0.69 to 0.84 and the number of scenes with no
frame-to-frame continuity at all from seven to one. The lyric layer opts out and
stays on song time, because a line is often still on screen when the scene under
it cuts.

The rule that falls out of this, for anyone writing a manifest: **never drive a
rate from an impulse.** `beatPulse`, `onset` and the per-band `*Hit` sources are
spikes — perfect on a brightness or a scale, wrong on a `speed`, where a spike is
not a surge but a jump in position. Use the level or shape sibling (`midHit` →
`midRel`) and put the impulse on something the effect can move instantly instead;
`tunnel` pumps its wall with the kick and travels at a steady rate. A unit test
enforces this.

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

A blend *replaces* the transition rather than decorating one, so it has to carry
the crossfade itself. `sceneblend` takes a `reveal` alongside its mix amount:
reveal decides which of the two scenes the frame settles on underneath the layer,
and it starts at zero. At the boundary both knobs are zero, so the first frame of
a blended scene is precisely the last frame of the one before it and the new
scene arrives by being mixed in. Without that the mix amount alone left the
incoming scene on screen raw at the cut and then swelled the outgoing one back
over the top of it — a hard cut followed by a ghost, which is the opposite of
flowing. Scene 0 is transitioned out of black for the same reason: it is
otherwise the one edit in the render that nothing leads into.

Transitions carry a repetition penalty, the same as scenes. Without it the
best-matching transition wins every comparable boundary — one shader ended up
carrying nine of twenty edits and the video read as repetitive.

### Which effects flow into which

Whether a boundary can be dissolved is a question about *two* pictures, and
`coverage` only answers "will the lights go out". Two effects can be identically
bright and still cut badly: a flat plasma into a corridor flight shares nothing
but its exposure, and dissolving between them shows two unrelated pictures at
once rather than one becoming the other. Two tunnel flights, meanwhile, dissolve
into each other almost invisibly however different their geometry is, because the
eye tracks the same vanishing point through both.

A pairwise table would be the obvious answer and is the wrong one — 58 scene
effects is 1653 pairs, and adding an effect would mean writing 58 new entries. So
each effect declares two properties of its picture and the pair score is derived:

| field | values | what it decides |
|---|---|---|
| `motion` | `depth-in` `depth-out` `planar` `churn` `still` | whether the two share an optical flow for a dissolve to ride on |
| `focus` | `centre` `spread` `horizon` | whether they agree about where the eye is when the mix starts |

`Flow.Affinity` combines those with the coverage gap into 0..1, and the director
uses it three ways: it biases *which* effect gets picked (gently, and not at all
where the music wants a break), it refuses to layer pairs that would come out as
mush, and it scales how long a transition runs. Opposed travel — a flight into
the screen against one falling away — scores zero on motion, and that is exactly
when a hard cut is the honest edit: the eye cannot track both flows, so a slow mix
reads as a fault rather than as a transition.

Across the current library that comes out as 24% of ordered pairs flowing, 34%
blendable, 30% wanting a short dissolve and 12% wanting a hard cut. Read the
mapping for yourself — the whole library, or one effect's full row:

```
dotnet run --project src/Imagine3D.Tests -- --flow            # every effect
dotnet run --project src/Imagine3D.Tests -- --flow spectrum   # one row in full
```

Each scene in a storyboard also records the verdict for its own boundary in its
`why`, so the plan says why an edit is a cut rather than a dissolve.

### Measuring what an effect declares

`coverage` and `motion` are the two fields nobody can eyeball reliably, and both
are load-bearing. **`probe.html`**, served alongside `preview.html`, measures
them: it renders each effect off-screen and reports coverage, plus which camera
move best explains two frames a third of a second apart. `?auto=1` runs it on
load so it can be driven headlessly.

Coverage is authoritative — a disagreement over about 0.10 means the manifest is
wrong. Motion is a screen rather than a verdict: the fit only sees head-on
travel, so an off-axis corridor flight or a sparse point field comes back as
`churn` however plainly it is a flight. The flag worth always acting on is
`BARELY MOVES`, which is a picture that changes too little to hold a scene.

It also reports **`cont`** — how much of the picture survives a single frame, as
the correlation between two frames 1/30 s apart. Near 1 the effect moved; near 0
it was replaced, and an effect that replaces itself thirty times a second is not
fast, it is noise. Neither coverage nor motion can see the difference, because a
palette flash changes every pixel while the shape underneath stays put, and a
structural churn changes the same pixels while nothing survives at all. `STROBES`
flags the second case. It measures an effect's *own* rate — the modulation is
held constant across the pair — so how a whole plan paces against its song is a
separate question, answered above.

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
  images/*.jpg          your own pictures, if you want any in it
  analysis/analysis.json   bpm, beats, downbeats, sections, rms, bands, fineBands
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

## Your own images

Drop pictures into a project — **Add images…** in the sidebar takes as many as you
like at once, or point it at a folder — and the director casts them into the video
the same way it casts effects. They land in `images/` and nothing downstream ever
writes there.

```
POST /api/projects/<name>/images   {"paths": ["D:\\photos", "D:\\shot.jpg"]}
```

Three ways a picture can be in a shot, and they are answers to different
questions about the frame the effect has already drawn:

| placement | when | what it is |
|---|---|---|
| `behind` | the scene's `coverage` is ≤ 0.55 | the photo is the backdrop, keyed by the scene's own luminance |
| `over` | the frame is already full | a few seconds of interference through screen/multiply/difference/XOR |
| `effect` | the scene's effect draws pictures itself | the image is handed to the shader; nothing is composited |

`behind` is the one worth understanding. These shaders draw on black, so what an
effect lights up *is* its alpha: the picture is dimmed by the scene's luminance
and the scene added back over it, which reads as the demo glowing in front of a
photograph rather than as a hole cut out of one. That is also why coverage
decides the placement — put an image behind a full-frame shader and it is simply
never seen.

The image goes in **before the scene's post stack**, not after the transition the
way an LTX clip does. It is pixelated by that scene's pixelate, bent by its CRT,
and it arrives and leaves through the scene's own edit. Composited after all that
it reads as a sticker. Every picture is also pulled some way towards the run's
palette, which is what stops a photograph looking like a screenshot pasted into a
demo.

**Uniqueness first.** The images are dealt from a shuffled reel, so every one
appears before any appears twice, and a reshuffle can never deal the same picture
twice running. *How often* sets what share of scenes may carry one; where they go
is decided by how much room the shot has — low coverage, a long scene, and a
still or sideways-travelling picture all argue for it — and no two neighbouring
scenes ever both carry one. With fewer images than slots, `maxUsesPerImage`
(3 by default) caps the count rather than repeating one picture into wallpaper.

Cues are placed **when the plan is made**, so images added to a project that
already has a storyboard need a **Redo storyboard** before they are in it. The
panel says so rather than leaving a folder that silently does nothing. Each cue
is a plain entry in `storyboard.json` with its own opacity and parameter
expressions, so it can be hand-edited and re-rendered like everything else.

An effect can also draw the picture itself rather than have it composited —
`imagerotozoom` and `imageshatter` do — and those are simply not offered to a
project with no images, because an image effect with no image is a black frame.

---

## AI video (LTX)

Off by default, and it needs ComfyUI with LTX 2.3. When it is on, clips are
generated from **a frame of the demo at the moment they land** and mixed into the
finished picture with a blend operator — screen, add, multiply, difference, XOR.
They are never cut to. A failed or skipped LTX stage still leaves a complete
video.

Two shapes:

| mode | what it is |
|---|---|
| **Sparse** | a handful of clips over the loudest scenes, each an event that arrives and leaves |
| **Continuous** | whole scenes tiled end to end with short clips, so the AI video runs *underneath* the effects for a stretch at a time |

Continuous is not one long insert. Each clip starts from the demo frame at its
own start time, so a two-minute run never drifts away from what the effects are
doing — which is the only reason a sustained overlay reads as a blend rather than
as a video with a demo on top of it. The clips of a run are joined into one file
per scene, so the renderer holds one `<video>` per stretch instead of one per
second of song.

**It stops for the scenes it would fight with.** The gate is the effect's own
declared `coverage`. A clip mixed over `apollonian` — 0.29, a small bright solid
on black — is not a blend, it is the clip playing with a fractal in front of it,
because through screen or add most of the frame has nothing to mix with. So those
scenes are left as they are, and the run resumes on the next one that fills the
frame. Scenes carrying one of your own images rank down too: a photograph, an
effect and a clip at once is three pictures competing.

**Clip length is not free-form.** LTX's VAE compresses time by 8, so the only
lengths it can return are 8n+1 frames — a 5s request at 30fps has always come
back as 4.83s. The panel says what you will actually get, and short clips are
genuinely available: 1.0s → 0.83s, 0.5s → 0.30s. Short clips re-anchor to the
demo more often and cost more ComfyUI time for the same coverage.

| setting | what it does |
|---|---|
| `mode` | `inserts` or `continuous` |
| `clipSeconds` | requested clip length; rounded down to something LTX can hold |
| `coverage` | continuous: roughly what share of the song to cover |
| `minEffectCoverage` | continuous: the frame-fill below which a scene is left alone |
| `maxClips` | continuous: hard ceiling on clips generated in one pass |
| `carry` | continuous: start each clip from the previous clip's last frame — one continuous take, but it drifts away from the demo and keeps drifting |
| `strength` | how hard the clips are mixed in; 0.9 is what inserts always used |

The budget is shared out by giving every eligible scene a run first and only then
pouring what is left back over them in proportion to the room each has. Handing
it to the best-scoring scenes until it runs out is the obvious rule and it is the
wrong one — on a real eight minute plan it spent all 120 clips on the last six
scenes and left the first four minutes with nine seconds of video in it.

To see where a run would go, and what it would cost, without queueing a single
ComfyUI job:

```
dotnet run --project src/Imagine3D.Tests -- --ltx "<project>" [clipSeconds] [coverage]
```

It prints every scene, its coverage, and either the stretch it gets or why it was
left alone.

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
  "energyRange": [0.1, 0.7], "coverage": 0.62, "cost": "low",
  "motion": "churn", "focus": "spread",
  "params": { "scale": { "type": "float", "default": "2.4 + 0.8*beatPulse" } }
}
```

`coverage` is how much of the frame the effect lights up, 0..1 — `apollonian` is
0.29, `spectrum` 0.70, `ifstunnel` 0.72. It has nothing to do with energy or
quality. It exists because cutting from a frame full of light to one that is
mostly black reads as the lights going out however good the transition is, and
the director cannot see what an effect looks like unless the effect says. Get it
roughly right and the edit around your effect gets longer, softer and more
likely to layer rather than wipe.

Measure it rather than guessing: render the effect off-screen with mid-energy
music values and take 0.6 × the fraction of the frame meaningfully above its own
darkest tenth, plus 0.4 × mean luminance, averaged over a couple of palettes and
a few moments. Hand-written values drift — before the last sweep the declared
numbers were out by up to 0.44, and one effect declared 0.10 while rendering
black on every frame, which is exactly what a number nobody checks will hide.

Parameters are **expressions over the music**, so an effect becomes beat-reactive
without containing any sync code:

| source | meaning |
|---|---|
| `beat` `bar` `phrase` | 0..1 sawtooth per beat / bar / 4-bar phrase |
| `beatPulse` `barPulse` | exponential decay from the hit, **scaled by how hard it landed** |
| `beatStrength` | 0..1, that scaling on its own |
| `onset` | transient strength |
| `rms` `energy` | level now / section energy |
| `sub bass lowMid mid high air` | the six band followers |
| `rmsPeak` `subPeak` … `airPeak` | the same, held at their recent maximum then falling — a meter's peak indicator |
| `subHit` … `airHit` | that band's own **attack** — how hard it was just struck, falling away after |
| `subRel` … `airRel` | that band against the average across bands — spectral **shape**, 0.5 is "sitting at the average" |
| `brightness` | spectral centroid: 0 all the energy is low, 1 all of it is high |
| `band0` … `band11` | the twelve-band spectrum, low to high, about ¾ of an octave each |
| `t` `sceneT` `sectionT` | seconds, progress through scene/section |
| `imageT` | 0..1 through the image cue running on this scene, if any |

Functions: `sin cos abs min max clamp mix smoothstep step pow sqrt floor fract mod noise`.

**The beat grid is a metronome; `beatPulse` is not.** The grid ticks through a
breakdown at the rate it ticks through a chorus, so an effect bound to a bare
decay bumps whether or not anything hit — the visuals dancing while the music
isn't. `beatPulse` is therefore scaled by `beatStrength`: the onset envelope at
that beat (something *started*) times the RMS follower (it was *loud*). Neither
works alone — the onset envelope has the loudness trend deliberately removed so
the beat tracker can work through a quiet intro, and RMS can't tell struck from
sustained. Sections in this repo sit at RMS 0.48 with an onset score of 0.01:
full level, nothing hitting. A half-time passage needs no special case — its
off-beats carry no transient, so the picture pulses at the rate the music does.

**Band level is not spectral response.** Bind `bass` and it looks like you are
reading the spectrum; measure it and you are reading the beat again. Every band
rises and falls with the arrangement, so they move together and they move with
the level — across this repo's own songs the mean |r| between one band and
another is 0.44, and between a band and the RMS envelope 0.54. That is why a
library where forty-odd effects referenced a band still looked like it only
heard the kick.

Two derived sources get out of it, both in `engine/modulation.js`:

- **`*Rel` — shape.** The band minus the average across bands at that instant.
  Whatever the whole spectrum does together cancels, and what is left is which
  way the energy is leaning. Correlation with the level drops from 0.54 to
  **0.15**, so an effect bound to it follows the arrangement — a filter opening,
  a breakdown dropping to the bass — instead of pumping with everything else.
- **`*Hit` — attack.** That band's own rise, normalised against the biggest
  rises in this song and then allowed to fall away. A hi-hat pattern appears in
  `airHit` and nowhere else, so one effect can answer the hats while another
  answers the kick. `onset` is one number for the whole mix and can never say
  that.

Both are computed at load from the bands the analysis already carries, and
`Imagine3D.Tests` prints the decorrelation table above for whatever song you
point it at, so the claim is checkable rather than folklore.

Reach for `*Rel` and `brightness` for anything that should follow the *music*
(hue, camera, character), `*Hit` for anything that should flicker with the
*percussion*, and plain band level or `beatPulse` for weight and punch. Spread
them: if every effect binds the same source, a finer spectrum buys nothing.

The shader gets `uResolution uAspect uTime uBeatPulse uBass …`, the run's five
palette stops as `uPal0..4`, and one `p_<name>` uniform per declared parameter.
Shared GLSL is available via `#include`:

```glsl
#include "common.glsl"   // rot, hashes, bayer4, quantize, hsv
#include "noise.glsl"    // valueNoise, gradNoise, fbm, ridged, fbm3
#include "palette.glsl"  // pal(), palClamp(), palSteps()
#include "blend.glsl"    // blendMode() incl. multiply, screen, difference, XOR
#include "sdf.glsl"      // primitives, raymarch(), softShadow(), AO
#include "panel.glsl"    // 2D shapes, pixel-unit fill()/stroke(), spectrum sampling
#include "image.glsl"    // imageUv() cover-fit, imageSample(), imageTone()
```

**Sampling the spectrum in a shader.** The twelve bands arrive as the array
uniforms `uBands uBandPeaks uBandHits uBandRel`, but prefer `panel.glsl`'s
`spectrumNow(x)` / `spectrumPeak(x)` / `spectrumHit(x)` / `spectrumRel(x)`, which
read them as a continuous curve with `x` running 0 (lowest band) to 1 (highest).
Because the bands are geometrically spaced, `x` is an *octave* axis: equal steps
are equal musical intervals, rather than half the curve being spent on the top
two octaves where music has little but cymbals.

That curve is what turns an effect with repeated elements into an instrument
rather than one knob. Give each bar, ring, layer or blob its own `x` and the
picture reads the mix apart — `kefrens` puts a bar on each band, `vectorballs`
tunes each ring of the corridor, `tunnel` wires the strip lights around the wall
and the hoops coming at the camera, `water` strikes each drop with its own part
of the mix. Sample it *once per element*, not per raymarch step: `metaballs`
fills a `float gBandR[12]` in `main()` for exactly that reason.

`kind` is one of `scene2d`, `raymarch`, `scene3d`, `post`, `transition`.
Set `"module": true` and supply `effect.js` instead when the effect needs real
geometry (see `meshshowcase`, `meshflyby`).

**Using a project image.** `uImage` is in the preamble like every other uniform,
so any effect that can sample a texture can sample a picture — it is bound for
every pass of a scene that has a cue, the scene shader and its post stack alike.
Declaring `"usesImage": true` is how an effect says it *needs* one rather than
merely being handed one, and it buys two things: the director will not pick the
effect for a project with no images, and a scene that gets it is given a cue
whether or not the density asked for one. Use `image.glsl` rather than sampling
`uImage` directly — cover-fitting, the beat ripple and the palette tone are three
things that have to be right every time — and respect `uHasImage`, or the effect
draws a black frame on the contact sheet, in the gallery and on the probe.

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

**A play button on every scene in the storyboard.** This is where the decision
about an effect actually gets made — you are reading the plan, scene 7 says
`kaliset`, and the question is whether to change it. Pressing play opens a
preview under that row, running that scene over that part of the song.

It uses the real compositor rather than drawing the shader on its own, so what
you see is what will render: the scene, then *its own post stack*, then the
transition it comes in through, then the lyric layer. Previewing the bare effect
would answer a different question and quietly mislead — most scenes carry two or
three post passes, and pixelate over kaliset is not kaliset. It starts a moment
before the scene so the transition into it is part of what you see, loops the
scene's window, and plays the song underneath it.

One canvas and one GL context for the whole list, moved into whichever row is
playing. It is thrown away and rebuilt whenever the plan changes, because a
preview built from the previous plan is the one thing a preview must never be.

**`preview.html` — the effect gallery.** A card per effect with a play button.
Press play and it runs; press **Play visible** and everything on screen runs at
once. This is the page to open when you want to know what an effect *does*, which
a still cannot tell you: how fast it is, how hard it lands on the beat, whether
it travels or just sits there being busy.

Every card is driven by a real song. Pick a project and the analysis behind it
feeds `Modulation` exactly as it does in a render — same beat grid, same band
followers, same peak holds — so an effect bound to `beatPulse` punches on the
same beats it will punch on in the video. Press **Play audio** and the cards are
in sync with what you are hearing, because both read `audio.currentTime`. With no
project selected it falls back to a plain 124 BPM metronome and says so.

Transitions sweep their wipe on a loop rather than sitting at one frozen slice,
post effects are shown over a test image, and effects that draw one of the
project's images are given that project's first picture — with a stand-in when it
has none, because "what does this effect do" is a different question with a
photograph in it than with a test pattern. The lyric card steps through all ten
of its treatments, four seconds and one whole line lifetime each, over a sample
line rasterised by the renderer's own code — a plain white one would preview a
different shader, since half the treatments address the words individually. So
all 93 effects are legible and not just the scenes. Deep links work: `preview.html?kind=raymarch&play=tunnel&t=42`.

One WebGL context serves the whole page — ninety is past what a browser will
give you, and would be ninety copies of every compiled shader. Cards that are
playing but scrolled out of view are skipped rather than stopped, so "play
everything" costs a screenful however far the list runs.

**`probe.html`** measures `coverage` and `motion`; see above.

```
POST /api/devsheet?kind=all&palette=neon
```

Renders every effect into one labelled contact sheet and writes it to
`%TEMP%\imagine3d-shots\` — the same sheet is available at the bottom of
`preview.html`. Useful for reviewing the whole library at a glance or attaching
to a note; the gallery is the better tool for judging any single effect.

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
- **Continuous LTX is as slow as it sounds.** Covering half of an eight minute
  song at 0.83s a clip is ~290 generations; the clip ceiling exists so that
  cannot be queued by accident, and the panel says how many before you start.
  Everything is cached, so only the first pass pays for it.
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
