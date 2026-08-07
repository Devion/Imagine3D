using Imagine3D.Projects;

namespace Imagine3D.Direct;

/// Decides where the project's own images appear, and what is being done to them
/// while they are there.
///
/// The images are the one input to a video that the engine cannot invent, and the
/// user supplying eleven of them means something different from supplying one. So
/// this is a casting problem rather than a decoration problem: which shots have
/// room for a picture, which picture each one gets, how it is being worked, and -
/// the part that decides whether the result is a VJ mix or a slideshow - for how
/// long.
///
/// **Short.** A photograph held under a scene for twenty seconds is stale after
/// about three of them, however good the shader over it is: the eye finishes
/// reading a still picture almost immediately and then there is nothing left in
/// it. So an image arrives as a *hit* of a few seconds, swells and goes, and a
/// long scene gets two or three of them - a different picture and a different
/// treatment each time - instead of one long hold. Hits land on downbeats where
/// the analysis found any, which is the whole difference between a picture that
/// is in the mix and a picture that is on top of it.
///
/// Deterministic given the project seed, like everything else the director does.
public static class ImageDirector
{
    /// A scene shorter than this cannot hold an image: it arrives, and the shot is
    /// over before the eye has read it.
    const double MinHostSeconds = 7.0;

    /// How long one hit runs, before the beat grid rounds it off.
    ///
    /// Long enough to register and to let the treatment move through a cycle,
    /// short enough that it is gone before the picture stops being news. The
    /// upper end is for calm passages; hot ones take the lower.
    const double MinHitSeconds = 2.4;
    const double MaxHitSeconds = 6.5;

    /// Roughly one hit per this much scene, up to HitsPerScene.
    const double SecondsPerHit = 11.0;
    const int MaxHitsPerScene = 3;

    /// How long one picture stays up in a scene whose effect is drawing it.
    ///
    /// Those scenes cannot flicker - the shader has nothing else to render - but a
    /// half-minute chorus must not be half a minute of one photograph either. So
    /// the effect keeps running and the picture it is drawing changes, on a
    /// downbeat, every few bars.
    const double DrawnSliceSeconds = 9.0;

    /// The most of the video that may have a picture in it. Past this the images
    /// stop being punctuation and become the video, which is not what they are.
    const double MaxImageShare = 0.34;

    /// Coverage at or below which the frame has room for a backdrop.
    ///
    /// Above it the effect already fills the picture, so an image *behind* it would
    /// simply never be seen - the only way a photo registers over a busy shot is as
    /// interference on top of it.
    const double BackdropCoverage = 0.55;

    /// Blend operators for an image laid over a full frame, split by energy the
    /// same way the LTX inserts are: additive over hot sections, multiplicative
    /// and softening over cool ones.
    static readonly string[] HotBlends = ["screen", "add", "difference", "xor"];
    static readonly string[] CoolBlends = ["multiply", "overlay", "softlight", "screen"];

    /// What is being done to the picture. Order is not significant here - the
    /// contract with the shader is by name, through IMAGE_TREATMENTS in
    /// engine/renderer.js.
    ///
    /// Split by what the passage can take rather than offered as one pool: a
    /// mosaic or a band-tear over a quiet verse is an effect happening *at* the
    /// music, and a gentle lens breathing under a chorus is nothing at all.
    static readonly string[] CalmTreatments = ["ripple", "wave", "swirl", "bulge", "kaleido", "tunnel"];
    static readonly string[] HotTreatments = ["slice", "mosaic", "kaleido", "tunnel", "ripple", "wave"];

    public static ImageCue[] Place(
        IReadOnlyList<string> files, StoryScene[] scenes, EffectRegistry registry,
        ProjectSettings settings, IReadOnlyList<double> grid, Random rng)
    {
        var opts = settings.Images;
        if (files.Count == 0 || scenes.Length == 0 || !opts.Enabled) return [];

        // A scene drawing a picture itself gets one whatever the density says.
        // The director only offered it an image-using effect because the project
        // has images; leaving that scene without a cue would have it render the
        // stand-in pattern, which is not what the plan says it is showing.
        var mandatory = scenes.Where(s => DrawsImage(s, registry)).ToList();
        var claimed = mandatory.Select(s => s.Index).ToHashSet();

        // Never two scenes running: an image on every shot is a slideshow with a
        // demo over it, which is the opposite of what these are for.
        int cap = (scenes.Length + 1) / 2;

        int want = opts.Density <= 0
            ? 0
            : Math.Clamp((int)Math.Round(scenes.Length * opts.Density), 1, cap);

        // Long enough to be worth putting a picture in, and not already spoken for.
        var hosts = scenes
            .Where(s => !claimed.Contains(s.Index) && s.Duration >= MinHostSeconds)
            .ToArray();

        var chosen = ChooseHosts(hosts, claimed, registry, rng, Math.Max(0, want - mandatory.Count));

        // ---- when each picture is on screen ---------------------------------
        var slots = new List<(StoryScene Scene, double Start, double End, bool Drawn)>();

        foreach (var scene in mandatory)
            slots.AddRange(Slices(scene, grid).Select(s => (scene, s.Start, s.End, true)));

        foreach (var scene in chosen)
            slots.AddRange(Hits(scene, grid, rng).Select(h => (scene, h.Start, h.End, false)));

        slots = slots.OrderBy(s => s.Start).ToList();
        slots = Trim(slots, files.Count * opts.MaxUsesPerImage, scenes[^1].End);
        if (slots.Count == 0) return [];

        // ---- which picture, and what is done to it --------------------------
        var reel = new Reel(files, rng);
        var cues = new List<ImageCue>();
        string lastTreatment = "";

        foreach (var slot in slots)
        {
            var effect = registry.Get(slot.Scene.EffectId);
            double coverage = effect?.Coverage ?? 0.6;
            var (file, uses) = reel.Next();

            if (slot.Drawn)
            {
                cues.Add(Drawn(cues.Count, slot.Scene, slot.Start, slot.End, file, uses));
                continue;
            }

            var treatment = PickTreatment(slot.Scene.Energy, lastTreatment, rng);
            lastTreatment = treatment;

            cues.Add(coverage <= BackdropCoverage
                ? Backdrop(cues.Count, slot.Scene, slot.Start, slot.End, file, uses, coverage, treatment, rng)
                : Interference(cues.Count, slot.Scene, slot.Start, slot.End, file, uses, coverage, treatment, rng));
        }

        return cues.ToArray();
    }

    /// The picture changes under an effect that is drawing it.
    ///
    /// These slices must tile the scene exactly: a frame that falls between two of
    /// them has no cue, the image is unbound, and the effect renders its stand-in
    /// pattern for that frame. So the last slice is stretched to the scene's end
    /// and a slice a snap collapsed is folded into its neighbour rather than left
    /// as a gap.
    static List<(double Start, double End)> Slices(StoryScene scene, IReadOnlyList<double> grid)
    {
        int n = Math.Max(1, (int)Math.Round(scene.Duration / DrawnSliceSeconds));
        if (n == 1) return [(scene.Start, scene.End)];

        double step = scene.Duration / n;
        var slices = new List<(double Start, double End)>();
        double from = scene.Start;

        for (int i = 1; i < n; i++)
        {
            // On a downbeat, so the picture changes with the music rather than on
            // a stopwatch. This is the whole reason it reads as an edit.
            double at = Snap(scene.Start + step * i, grid, 0.6);
            if (at - from < DrawnSliceSeconds * 0.4) continue;
            slices.Add((from, at));
            from = at;
        }

        slices.Add((from, scene.End));
        return slices;
    }

    /// When, inside one scene, the picture comes and goes.
    ///
    /// Two or three separate hits across a long scene rather than one hold: each
    /// gets its own picture and its own treatment, so twenty-five seconds of scene
    /// carries three different images being worked three different ways instead of
    /// one photograph slowly going stale behind a shader.
    static List<(double Start, double End)> Hits(
        StoryScene scene, IReadOnlyList<double> grid, Random rng)
    {
        int n = Math.Clamp((int)(scene.Duration / SecondsPerHit), 1, MaxHitsPerScene);

        // Keep clear of the scene's own edges: an image arriving in the middle of
        // the transition into the shot fights the edit, and one still going at the
        // end has to be cut off by it.
        double margin = Math.Min(1.2, scene.Duration * 0.08);
        double usable = scene.Duration - margin * 2;
        double window = usable / n;

        // Hot sections take shorter hits - the faster the music is moving, the
        // sooner a held picture reads as a freeze.
        double len = Math.Clamp(
            (MaxHitSeconds - (MaxHitSeconds - MinHitSeconds) * scene.Energy) * (0.8 + rng.NextDouble() * 0.4),
            MinHitSeconds, Math.Min(MaxHitSeconds, window * 0.85));

        var hits = new List<(double, double)>();
        for (int i = 0; i < n; i++)
        {
            double slotStart = scene.Start + margin + window * i;
            double start = slotStart + rng.NextDouble() * Math.Max(0, window - len);
            double end = Math.Min(scene.End - margin * 0.5, start + len);

            // On a downbeat where there is one. This is most of what makes a hit
            // read as part of the music rather than as a timer going off.
            start = Snap(start, grid, 0.4);
            end = Snap(end, grid, 0.4);

            if (end - start >= MinHitSeconds * 0.75) hits.Add((start, end));
        }
        return hits;
    }

    /// The nearest grid point within `tolerance`, or the time unchanged.
    static double Snap(double t, IReadOnlyList<double> grid, double tolerance)
    {
        if (grid.Count == 0) return t;

        double best = t, bestGap = tolerance;
        foreach (var g in grid)
        {
            if (g > t + tolerance) break;          // grid is sorted
            double gap = Math.Abs(g - t);
            if (gap < bestGap) { bestGap = gap; best = g; }
        }
        return best;
    }

    /// Drop hits until the images are punctuation rather than the video.
    ///
    /// Two ceilings, and they are about different things. `maxCues` is what the
    /// library can carry without repeating a picture into wallpaper. The share of
    /// the running time is about the video: past about a third of it the images
    /// stop being an event and the effects start looking like a frame around them.
    /// Both trim from the middle of the run outwards, so the first and last hits -
    /// which are the ones an edit was built around - survive.
    static List<(StoryScene Scene, double Start, double End, bool Drawn)> Trim(
        List<(StoryScene Scene, double Start, double End, bool Drawn)> slots,
        int maxCues, double duration)
    {
        double budget = duration * MaxImageShare;

        // Scenes drawing the picture themselves are not negotiable - the effect
        // has nothing else to render - so they are counted but never dropped.
        double spent = slots.Where(s => s.Drawn).Sum(s => s.End - s.Start);
        var kept = slots.Where(s => s.Drawn).ToList();

        foreach (var slot in slots.Where(s => !s.Drawn))
        {
            if (kept.Count >= maxCues) break;
            double len = slot.End - slot.Start;
            if (spent + len > budget) continue;
            spent += len;
            kept.Add(slot);
        }

        return kept.OrderBy(s => s.Start).ToList();
    }

    static string PickTreatment(double energy, string avoid, Random rng)
    {
        var pool = (energy > 0.6 ? HotTreatments : CalmTreatments)
            .Where(t => t != avoid)
            .ToArray();
        return pool[rng.Next(pool.Length)];
    }

    /// Bring the image cues back in line after one scene's effect was changed by
    /// hand. Returns the whole set, reindexed.
    ///
    /// Swapping an effect changes what the shot needs from the picture, and the
    /// cue that was right for the old one is usually wrong for the new: an effect
    /// that draws the image itself must be given one or it renders the stand-in
    /// pattern, and an effect that does not must have it composited or the image
    /// vanishes from the video without the user having asked for that. Both are
    /// silent failures if this is not done here - a re-plan would fix them, but by
    /// then the scene has been rendered.
    public static ImageCue[] Resync(
        IReadOnlyList<ImageCue> existing, StoryScene[] scenes, int sceneIndex,
        EffectRegistry registry, IReadOnlyList<string> files, ProjectSettings settings, int seed)
    {
        if (sceneIndex < 0 || sceneIndex >= scenes.Length) return existing.ToArray();

        var scene = scenes[sceneIndex];
        var others = existing.Where(c => c.SceneIndex != sceneIndex).ToList();
        var mine = existing.Where(c => c.SceneIndex == sceneIndex).ToList();
        var rng = new Random(seed ^ 0x1A6E ^ (sceneIndex * 7919));

        var rebuilt = new List<ImageCue>();
        bool draws = DrawsImage(scene, registry);

        if (settings.Images.Enabled && files.Count > 0 && (draws || mine.Count > 0))
        {
            double coverage = registry.Get(scene.EffectId)?.Coverage ?? 0.6;

            if (draws)
            {
                // Slices covering the whole scene: the effect has nothing to draw
                // between them, and a long shot must not hold one picture. No beat
                // grid here - this is an edit made by hand, not by the analysis -
                // so the slices fall where the clock says.
                foreach (var (start, end) in Slices(scene, []))
                {
                    var file = LeastUsed(files, others.Concat(rebuilt).ToList(), rng);
                    rebuilt.Add(Drawn(0, scene, start, end, file,
                                      Uses(file, others.Concat(rebuilt).ToList()) + 1));
                }
            }
            else
            {
                // Keep the hits the scene already had: their timing was chosen
                // against the music and is still right, and only what is done with
                // the picture has to change.
                //
                // Unless the scene was *drawing* it. Those cues tile the whole
                // shot, so reusing their spans would leave a composited image up
                // for ten seconds at a stretch - the long hold this director
                // exists to avoid. Those get fresh hits instead.
                var windows = mine.Any(c => c.Placement == "effect")
                    ? Hits(scene, [], rng)
                    : mine.Select(c => (c.Start, c.End)).ToList();

                string last = "";
                for (int i = 0; i < windows.Count; i++)
                {
                    var was = i < mine.Count ? mine[i] : null;
                    var seen = others.Concat(rebuilt).ToList();

                    var file = Keep(was?.File, files) ?? LeastUsed(files, seen, rng);
                    var treatment = string.IsNullOrEmpty(was?.Treatment) || was.Placement == "effect"
                        ? PickTreatment(scene.Energy, last, rng)
                        : was.Treatment;
                    last = treatment;

                    rebuilt.Add(coverage <= BackdropCoverage
                        ? Backdrop(0, scene, windows[i].Start, windows[i].End, file,
                                   Uses(file, seen) + 1, coverage, treatment, rng)
                        : Interference(0, scene, windows[i].Start, windows[i].End, file,
                                       Uses(file, seen) + 1, coverage, treatment, rng));
                }
            }
        }

        return others
            .Concat(rebuilt)
            .OrderBy(c => c.SceneIndex).ThenBy(c => c.Start)
            .Select((c, i) => c with { Index = i })
            .ToArray();
    }

    /// The file this cue already used, if it is still on disk.
    static string? Keep(string? file, IReadOnlyList<string> files) =>
        file is not null && files.Contains(file, StringComparer.OrdinalIgnoreCase) ? file : null;

    static int Uses(string file, IReadOnlyList<ImageCue> cues) =>
        cues.Count(c => c.File.Equals(file, StringComparison.OrdinalIgnoreCase));

    /// The picture the plan has leaned on least. Uniqueness is still the rule when
    /// a scene is picked by hand, not only when the whole plan is built.
    static string LeastUsed(IReadOnlyList<string> files, IReadOnlyList<ImageCue> cues, Random rng) =>
        files.OrderBy(f => Uses(f, cues)).ThenBy(_ => rng.Next()).First();

    /// Whether anything in this scene draws the image itself, rather than having
    /// it composited in. A post pass counts: the image is bound for every pass of
    /// the scene, so a grade built around one is as much a consumer as a shader is.
    static bool DrawsImage(StoryScene scene, EffectRegistry registry) =>
        (registry.Get(scene.EffectId)?.UsesImage ?? false) ||
        scene.Post.Any(p => registry.Get(p.EffectId)?.UsesImage ?? false);

    /// The scenes with the most room for a picture, kept apart from each other and
    /// from the ones already carrying one.
    static List<StoryScene> ChooseHosts(
        StoryScene[] hosts, IReadOnlyCollection<int> claimed,
        EffectRegistry registry, Random rng, int want)
    {
        if (want <= 0 || hosts.Length == 0) return [];

        var scored = hosts
            .Select(s => (Scene: s, Desire: Desire(s, registry) + (rng.NextDouble() - 0.5) * 0.5))
            .OrderByDescending(x => x.Desire)
            .ThenBy(x => x.Scene.Index)      // a tie must not depend on sort stability
            .ToList();

        var picked = new List<int>(claimed);
        var chosen = new List<StoryScene>();
        foreach (var (scene, _) in scored)
        {
            if (chosen.Count >= want) break;
            if (picked.Any(i => Math.Abs(i - scene.Index) < 2)) continue;
            picked.Add(scene.Index);
            chosen.Add(scene);
        }

        return chosen.OrderBy(s => s.Index).ToList();
    }

    /// How much this shot wants a picture in it.
    static double Desire(StoryScene scene, EffectRegistry registry)
    {
        var effect = registry.Get(scene.EffectId);
        double coverage = effect?.Coverage ?? 0.6;

        // Room in the frame is most of it. An empty picture is a picture waiting
        // for something to be in it.
        double desire = 1.6 * (1.0 - coverage);

        // Room for more than one hit. A scene long enough to take three of them is
        // worth more than one that can only take a single pass, because three is
        // where this stops reading as a photograph and starts reading as a mix.
        desire += 0.9 * Math.Min(1.0, scene.Duration / 24.0);

        // What the shot is doing. A still or sideways-travelling picture shares a
        // frame with a photograph; a flight into the screen is already telling the
        // eye where to go and a second image in the same frame fights it.
        desire += effect?.Motion switch
        {
            "still" => 0.5,
            "planar" => 0.35,
            "churn" => -0.15,
            _ => 0.0,       // depth-in / depth-out
        };

        return desire;
    }

    /// An image handed to the scene, which draws it itself.
    ///
    /// Nothing is composited: the cue exists to say which picture this shot is of
    /// and to bind it for every pass of the scene. Placing it behind or over as
    /// well would put the same image on screen twice. It covers a slice of the
    /// scene rather than a window inside it - the effect has nothing to render
    /// between slices - so the slices tile the shot and the picture changes at the
    /// seams while the effect keeps running.
    static ImageCue Drawn(
        int index, StoryScene scene, double start, double end, string file, int uses) =>
        new(Index: index,
            SceneIndex: scene.Index,
            Start: Math.Round(start, 3),
            End: Math.Round(end, 3),
            File: file,
            Placement: "effect",
            Treatment: "none",
            Blend: "normal",
            Opacity: "1",
            Params: [],
            Why: $"{scene.EffectId} draws it - {Path.GetFileNameWithoutExtension(file)}{UseNote(uses)}");

    /// A hit of image behind the effect.
    static ImageCue Backdrop(
        int index, StoryScene scene, double start, double end,
        string file, int uses, double coverage, string treatment, Random rng)
    {
        double span = Math.Max(0.4, end - start);

        // A third of the hit swelling in and a third going: it arrives and leaves
        // rather than switching on. At these lengths there is no "hold" left, and
        // that is the point - there is nothing to go stale.
        var f = Fmt(Math.Round(Math.Clamp(span * 0.34, 0.5, 1.6) / span, 3));

        return new ImageCue(
            Index: index,
            SceneIndex: scene.Index,
            Start: Math.Round(start, 3),
            End: Math.Round(end, 3),
            File: file,
            Placement: "behind",
            Treatment: treatment,
            Blend: "screen",       // unused by "behind"; kept honest rather than blank
            Opacity: $"smoothstep(0,{f},imageT)*smoothstep(0,{f},1-imageT)*(0.72+0.24*rms)",
            Params: new Dictionary<string, string>
            {
                // A push, direction picked per cue. Faster than a backdrop would
                // want because it is only on screen for a few seconds.
                ["zoom"] = rng.NextDouble() < 0.5
                    ? "1.02 + 0.16*imageT + 0.05*beatPulse"
                    : "1.22 - 0.16*imageT + 0.05*beatPulse",
                ["drift"] = "0.05",
                // Always doing something, harder on the hit. A treatment that only
                // appears on the beat leaves a still photograph the rest of the time.
                ["warp"] = Fmt(0.30 + (1.0 - coverage) * 0.25) + " + 0.30*rms + 0.40*beatPulse",
                ["speed"] = Fmt(0.65 + scene.Energy * 0.9),
                // The scene's own edges push the picture about, so the two are
                // mixed rather than stacked.
                ["displace"] = "0.5 + 0.6*beatPulse",
                // Pulled towards the run's palette so it belongs to this video's
                // colour world rather than to whatever camera took it.
                ["tone"] = "0.34 + 0.14*rms",
                // A sparse effect has less to punch through with, so it needs less
                // help getting in front of the photo.
                ["key"] = Fmt(0.45 + (1.0 - coverage) * 0.35),
            },
            Why: $"sparse frame (coverage {coverage:0.00}) - {Path.GetFileNameWithoutExtension(file)} " +
                 $"swells behind it, {treatment}, {span:0.0}s{UseNote(uses)}");
    }

    /// A hit of image over the effect.
    static ImageCue Interference(
        int index, StoryScene scene, double start, double end,
        string file, int uses, double coverage, string treatment, Random rng)
    {
        var pool = scene.Energy > 0.6 ? HotBlends : CoolBlends;
        var blend = pool[rng.Next(pool.Length)];

        double span = Math.Max(0.4, end - start);
        var f = Fmt(Math.Round(Math.Clamp(span * 0.28, 0.35, 1.2) / span, 3));

        return new ImageCue(
            Index: index,
            SceneIndex: scene.Index,
            Start: Math.Round(start, 3),
            End: Math.Round(end, 3),
            File: file,
            Placement: "over",
            Treatment: treatment,
            Blend: blend,
            Opacity: $"smoothstep(0,{f},imageT)*smoothstep(0,{f},1-imageT)*(0.42+0.38*rms)",
            Params: new Dictionary<string, string>
            {
                ["zoom"] = "1.06 + 0.10*imageT + 0.07*beatPulse",
                ["drift"] = "0.06",
                // Interference is where the picture is allowed to be violent: it
                // is over a full frame for a few seconds, not underneath one.
                ["warp"] = "0.45 + 0.35*rms + 0.55*beatPulse + 0.25*onset",
                ["speed"] = Fmt(0.9 + scene.Energy * 1.3),
                ["displace"] = "0.8 + 0.8*beatPulse",
                ["tone"] = "0.55 + 0.20*rms",
                ["key"] = "0",
            },
            Why: $"busy frame (coverage {coverage:0.00}) - {Path.GetFileNameWithoutExtension(file)} " +
                 $"cuts across it, {treatment}/{blend}, {span:0.0}s{UseNote(uses)}");
    }

    static string UseNote(int uses) => uses == 1 ? "" : $", {Ordinal(uses)} use";

    static string Ordinal(int n) => n switch
    {
        2 => "2nd", 3 => "3rd", _ => $"{n}th",
    };

    /// Numbers that go into an expression the browser parses are always formatted
    /// invariantly - on a machine with a comma decimal separator, "0,083" inside a
    /// smoothstep() would silently become two arguments.
    static string Fmt(double v) => v.ToString("0.####", System.Globalization.CultureInfo.InvariantCulture);

    /// Hands out images so every one is used before any is used twice.
    ///
    /// "Prefer uniqueness over reuse" is the whole rule: a shuffled reel dealt in
    /// order gives each picture one appearance before any gets two, and reshuffles
    /// when it runs out. The seam is checked so a reshuffle cannot deal the same
    /// image twice in a row, which is the one case a plain reshuffle gets wrong and
    /// is also the most visible - two consecutive hits of the same photograph read
    /// as one long hold, which is what all of this is trying to avoid.
    sealed class Reel(IReadOnlyList<string> files, Random rng)
    {
        readonly Dictionary<string, int> _uses = new(StringComparer.OrdinalIgnoreCase);
        List<string> _remaining = [];
        string? _last;

        public (string File, int Uses) Next()
        {
            if (_remaining.Count == 0) _remaining = Shuffled();

            var file = _remaining[^1];
            _remaining.RemoveAt(_remaining.Count - 1);
            _last = file;

            int uses = _uses[file] = _uses.GetValueOrDefault(file) + 1;
            return (file, uses);
        }

        List<string> Shuffled()
        {
            var list = files.ToList();
            for (int i = list.Count - 1; i > 0; i--)
            {
                int j = rng.Next(i + 1);
                (list[i], list[j]) = (list[j], list[i]);
            }

            // Dealt from the end, so the last element is the next one out.
            if (list.Count > 1 && list[^1] == _last)
                (list[^1], list[0]) = (list[0], list[^1]);

            return list;
        }
    }
}
