using Imagine3D.Audio;
using Imagine3D.Projects;

namespace Imagine3D.Direct;

/// Turns the analysis (plus optional LLM intent) into a concrete storyboard.
/// Entirely deterministic given the project seed: the same project always renders
/// the same video, and "reroll" is an explicit bump of that seed.
public sealed class Director(EffectRegistry registry)
{
    /// Sections shorter than this get folded into their neighbour - a 3-second
    /// scene reads as a glitch, not as a scene.
    const double MinSceneSeconds = 6.0;

    /// How many scenes must pass before an effect may be reused.
    const int RepeatWindow = 4;

    public Storyboard Build(AudioAnalysis analysis, ProjectSettings settings, Intent? intent)
    {
        intent ??= Intent.Empty;
        var rng = new Random(settings.Seed);

        var sections = MergeShort(analysis.Sections, analysis.Duration);
        var scenes = new List<StoryScene>();
        var recent = new List<string>();
        var recentTransitions = new List<string>();

        var sceneKinds = new[] { "scene2d", "scene3d", "raymarch" };
        var candidates = registry.OfKind(sceneKinds)
            .Where(e => e.SupportsAspect(settings.Aspect))
            .ToList();

        if (candidates.Count == 0)
            throw new InvalidOperationException(
                "No scene effects are registered. Check that src/Imagine3D.Web/effects/*/effect.json exist.");

        for (int i = 0; i < sections.Length; i++)
        {
            var sec = sections[i];
            var si = intent.For(sec.Index);

            var tags = BuildTags(sec, si, intent);
            double intensity = si?.Intensity is > 0 ? si.Intensity : sec.Energy;

            var pick = PickScene(candidates, tags, intensity, recent, rng);
            recent.Add(pick.Id);

            var post = PickPost(pick, tags, intensity, settings.Aspect, rng);

            double prevEnergy = i > 0 ? sections[i - 1].Energy : 0;
            double delta = intensity - prevEnergy;

            // A scene either blends with the one before it or cuts to it. Blending
            // is the more interesting edit when nothing in the music demands a
            // hard break, so it is offered first.
            var blend = PickBlend(i, sec, pick, candidates, delta, intensity, rng);
            var (transition, transitionDur) = blend is not null
                ? ("fade", 0.0)   // the blend's own ramp is the transition
                : PickTransition(i, sec, delta, recentTransitions, rng);
            if (blend is null) recentTransitions.Add(transition);

            scenes.Add(new StoryScene(
                Index: i,
                Start: sec.Start,
                End: sec.End,
                EffectId: pick.Id,
                Params: DefaultParams(pick),
                Post: post,
                TransitionIn: transition,
                TransitionDuration: transitionDur,
                SectionLabel: sec.Label,
                Energy: Math.Round(intensity, 3),
                Why: Explain(pick, tags, intensity) + (blend is null ? "" : $" - blended ({blend.Mode})"),
                Blend: blend));
        }

        var texts = BuildTexts(analysis, sections);

        return new Storyboard(
            Version: Storyboard.CurrentVersion,
            Seed: settings.Seed,
            Aspect: settings.Aspect,
            Fps: settings.Fps,
            Duration: analysis.Duration,
            Mood: intent.Mood,
            Palette: string.IsNullOrWhiteSpace(intent.Palette) ? DerivePalette(analysis, rng) : intent.Palette,
            Notes: intent.Story,
            Scenes: scenes.ToArray(),
            Texts: texts,
            Ltx: []); // filled in by the LTX stage when it runs
    }

    /// Fold sections that are too short to register as a scene into the previous one.
    static Section[] MergeShort(Section[] sections, double duration)
    {
        if (sections.Length == 0)
            return [new Section(0, 0, duration, "A", 0.5, 1, [], [])];

        var outp = new List<Section>();
        foreach (var s in sections)
        {
            if (outp.Count > 0 && s.Duration < MinSceneSeconds)
            {
                var prev = outp[^1];
                outp[^1] = prev with
                {
                    End = s.End,
                    Energy = (prev.Energy + s.Energy) / 2,
                    Markers = [.. prev.Markers, .. s.Markers],
                    Lyrics = [.. prev.Lyrics, .. s.Lyrics],
                };
            }
            else outp.Add(s);
        }

        // A trailing short section has no previous to merge into on the first pass.
        if (outp.Count > 1 && outp[^1].Duration < MinSceneSeconds)
        {
            var last = outp[^1];
            outp[^2] = outp[^2] with { End = last.End };
            outp.RemoveAt(outp.Count - 1);
        }

        return outp.Select((s, i) => s with { Index = i }).ToArray();
    }

    static string[] BuildTags(Section sec, SectionIntent? si, Intent intent)
    {
        var tags = new List<string>();
        void Add(IEnumerable<string> t) { foreach (var x in t) if (!tags.Contains(x)) tags.Add(x); }

        if (si is not null) Add(si.Tags);
        Add(intent.GlobalTags);
        Add(TagInference.FromMarkers(sec.Markers));
        Add(TagInference.FromText(sec.Lyrics));

        // Energy always contributes, so a section with no words still steers.
        if (sec.Energy > 0.72) Add(["high-energy", "aggressive"]);
        else if (sec.Energy < 0.32) Add(["calm", "sparse"]);

        return tags.ToArray();
    }

    EffectManifest PickScene(
        List<EffectManifest> candidates, string[] tags, double energy,
        List<string> recent, Random rng)
    {
        var scored = candidates.Select(e => (Effect: e, Score: Score(e, tags, energy, recent, rng)))
            .OrderByDescending(x => x.Score)
            .ToList();
        return scored[0].Effect;
    }

    double Score(EffectManifest e, string[] tags, double energy, List<string> recent, Random rng)
    {
        double score = 0;

        // Tag overlap is the main signal, normalised by how many tags the effect
        // declares. Raw overlap rewards breadth: an effect tagged with eight
        // moods matches almost any section and crowds out focused effects, which
        // is exactly what happened when the library grew.
        int overlap = e.Tags.Count(t => tags.Contains(t, StringComparer.OrdinalIgnoreCase));
        score += overlap * 2.0 / Math.Sqrt(Math.Max(1, e.Tags.Length));

        // Energy fit: how close the section sits to the middle of the effect's band.
        double lo = e.EnergyRange.Length > 0 ? e.EnergyRange[0] : 0;
        double hi = e.EnergyRange.Length > 1 ? e.EnergyRange[1] : 1;
        if (energy < lo || energy > hi) score -= 2.5 * Math.Min(Math.Abs(energy - lo), Math.Abs(energy - hi));
        else score += 1.5 * (1 - Math.Abs(energy - (lo + hi) / 2) / Math.Max(0.01, (hi - lo) / 2));

        // Repetition: a scene used recently is heavily penalised, decaying with age.
        int since = recent.Count - 1 - recent.LastIndexOf(e.Id);
        if (recent.Contains(e.Id) && since < RepeatWindow)
            score -= 6.0 * (RepeatWindow - since) / RepeatWindow;

        score -= 0.25 * e.CostWeight;

        // Seeded jitter breaks ties and keeps consecutive songs from looking
        // identical, without making the same project non-reproducible.
        score += rng.NextDouble() * 1.2;

        return score;
    }

    PostEffect[] PickPost(
        EffectManifest scene, string[] tags, double energy, string aspect, Random rng)
    {
        var pool = registry.OfKind("post")
            .Where(e => e.SupportsAspect(aspect))
            .Where(e => !scene.Conflicts.Contains(e.Id) && !e.Conflicts.Contains(scene.Id))
            .ToList();
        if (pool.Count == 0) return [];

        // Busier sections carry more layers; a sparse intro gets one at most.
        int want = energy > 0.7 ? 3 : energy > 0.4 ? 2 : 1;

        var chosen = new List<EffectManifest>();
        foreach (var e in pool.OrderByDescending(e => Score(e, tags, energy, [], rng)))
        {
            if (chosen.Count >= want) break;
            if (chosen.Any(c => c.Conflicts.Contains(e.Id) || e.Conflicts.Contains(c.Id))) continue;
            chosen.Add(e);
        }

        return chosen.Select(e => new PostEffect(
            e.Id,
            DefaultParams(e),
            // Wet/dry breathes with the music rather than sitting at a fixed value.
            Amount: energy > 0.65 ? "0.55 + 0.45*rms" : "0.35 + 0.35*rms")).ToArray();
    }

    /// Blend modes that suit layering two moving scenes, split by energy.
    /// Additive operators bloom and read as one image growing out of another;
    /// multiplicative and difference operators read as interference.
    static readonly string[] HotBlends = ["screen", "add", "difference", "lighten"];
    static readonly string[] CoolBlends = ["multiply", "overlay", "softlight", "screen"];

    /// Decide whether this scene layers over the previous one instead of cutting.
    ///
    /// Cutting every time makes a long video feel like a slideshow. Blending is
    /// held back where the music genuinely breaks - a big energy jump or a strong
    /// section boundary earns a cut - and used elsewhere.
    SceneBlend? PickBlend(
        int index, Section sec, EffectManifest scene, List<EffectManifest> candidates,
        double energyDelta, double energy, Random rng)
    {
        if (index == 0) return null;

        // A real musical break should land as a break.
        if (energyDelta > 0.18 || sec.BoundaryStrength > 0.75) return null;

        // Two expensive scenes drawn every frame would halve the render rate.
        if (scene.Cost == "high" && rng.NextDouble() < 0.75) return null;

        // Too short to establish a layered look.
        if (sec.Duration < MinSceneSeconds * 1.5) return null;

        if (rng.NextDouble() > 0.45) return null;

        var pool = energy > 0.55 ? HotBlends : CoolBlends;
        var mode = pool[rng.Next(pool.Length)];

        // Either layer for the whole scene, or bleed through for a few seconds
        // and resolve to the new scene alone.
        bool wholeScene = rng.NextDouble() < 0.35;
        double duration = wholeScene ? 0 : Math.Min(sec.Duration * 0.7, 3.0 + rng.NextDouble() * 5.0);
        double fade = Math.Min(1.6, Math.Max(0.6, sec.Duration * 0.12));

        // Sustained layering sits back so the new scene still reads; a short
        // bleed-through can afford to be strong.
        var amount = wholeScene
            ? "0.30 + 0.22*rms"
            : "0.55 + 0.35*rms";

        return new SceneBlend(mode, amount, Math.Round(duration, 2), Math.Round(fade, 2));
    }

    /// How many boundaries must pass before a transition may be used again.
    const int TransitionRepeatWindow = 5;

    /// Decays with age, so a transition used five boundaries ago is fair game.
    static double RepetitionPenalty(string id, List<string> recent)
    {
        int last = recent.LastIndexOf(id);
        if (last < 0) return 0;
        int since = recent.Count - 1 - last;
        if (since >= TransitionRepeatWindow) return 0;
        return -5.0 * (TransitionRepeatWindow - since) / TransitionRepeatWindow;
    }

    (string Id, double Duration) PickTransition(
        int index, Section sec, double energyDelta, List<string> recent, Random rng)
    {
        if (index == 0) return ("fadethrough", 1.4);

        var pool = registry.OfKind("transition").ToList();
        if (pool.Count == 0) return ("cut", 0);

        // A hard boundary into a louder section wants a cut; a gentle one into a
        // quieter section wants a dissolve. This is the single most audible way the
        // edit either matches the music or fights it.
        bool hard = energyDelta > 0.15 || sec.BoundaryStrength > 0.72;
        bool soft = energyDelta < -0.1;

        var wanted = hard ? new[] { "hard", "impact", "glitch" }
                   : soft ? ["soft", "dissolve", "fluid", "cinematic"]
                   : ["wipe", "geometric", "mechanical", "retro"];

        var scored = pool
            .Select(e => (e, s: e.Tags.Count(t => wanted.Contains(t)) * 2.0
                             + (e.FitsEnergy(sec.Energy) ? 0.8 : -1.5)
                             // Without this the best-matching transition wins every
                             // comparable boundary - one shader ends up carrying
                             // half the edits and the video reads as repetitive.
                             + RepetitionPenalty(e.Id, recent)
                             + rng.NextDouble() * 1.6))
            .OrderByDescending(x => x.s)
            .ToList();

        var pick = scored[0].e;

        // Duration varies per pick rather than per class, so repeated use of the
        // same wipe does not always take exactly the same time.
        double dur = hard ? 0.12 + rng.NextDouble() * 0.25
                   : soft ? 1.2 + rng.NextDouble() * 1.6
                   : 0.5 + rng.NextDouble() * 1.0;

        // A fade-through has to cover three phases, so give it room.
        if (pick.Id == "fadethrough") dur = Math.Max(dur, 1.1);

        // Never let a transition eat more than a third of the scene it opens.
        dur = Math.Min(dur, sec.Duration / 3);

        return (pick.Id, Math.Round(dur, 3));
    }

    /// A one-line reason, stored on the scene and shown in the UI. The director
    /// making an opaque choice is the thing that makes a generated video feel
    /// arbitrary; saying why it picked this scene is most of the fix.
    static string Explain(EffectManifest e, string[] tags, double energy)
    {
        var matched = e.Tags.Where(t => tags.Contains(t, StringComparer.OrdinalIgnoreCase)).ToArray();
        var band = energy > 0.7 ? "high energy" : energy < 0.35 ? "low energy" : "mid energy";
        return matched.Length > 0
            ? $"{band}, matches {string.Join("/", matched.Take(3))}"
            : $"{band}, no tag match - chosen on energy fit";
    }

    static Dictionary<string, string> DefaultParams(EffectManifest e) =>
        e.Params.ToDictionary(kv => kv.Key, kv => kv.Value.Default);

    /// Lyric lines become on-screen text. Markers are stage directions, not lyrics,
    /// so they are never drawn.
    static TextCue[] BuildTexts(AudioAnalysis analysis, Section[] sections)
    {
        var cues = new List<TextCue>();
        foreach (var l in analysis.Lyrics)
        {
            if (l.IsMarker) continue;
            if (string.IsNullOrWhiteSpace(l.Text)) continue;

            var sec = sections.FirstOrDefault(s => l.Start >= s.Start && l.Start < s.End);
            string style = sec is null ? "wave"
                : sec.Energy > 0.7 ? "slam"
                : sec.Energy < 0.35 ? "fade"
                : "wave";

            // Hold each line a beat longer than its slot so it is readable.
            cues.Add(new TextCue(l.Start, Math.Min(analysis.Duration, l.End + 0.4), l.Text, style));
        }
        return cues.ToArray();
    }

    /// Pick a palette from the song's spectral balance and how loud it runs.
    ///
    /// The bands are each normalised to their own dynamic range, so their absolute
    /// values all sit around 0.75 and comparing them to a fixed threshold picked
    /// the same palette every time. The ratio of treble to bass is scale-free and
    /// actually says something: bright, airy material versus dark and bass-heavy.
    static string DerivePalette(AudioAnalysis analysis, Random rng)
    {
        if (analysis.Bands.Length < 6) return "frost";

        double treble = analysis.Bands[4].Average() + analysis.Bands[5].Average();
        double bass = analysis.Bands[0].Average() + analysis.Bands[1].Average();
        double tilt = treble / Math.Max(0.05, bass);        // >1 is bright-leaning
        double loudness = analysis.Rms.Average();

        string[] pool =
            tilt > 1.12 && loudness > 0.55 ? ["neon", "candy", "sunset"]      // bright and loud
            : tilt > 1.12 ? ["frost", "chrome", "neon"]                        // bright and restrained
            : loudness > 0.55 ? ["ember", "toxic", "sunset"]                   // dark and loud
            : ["void", "frost", "ember"];                                      // dark and quiet

        return pool[rng.Next(pool.Length)];
    }
}
