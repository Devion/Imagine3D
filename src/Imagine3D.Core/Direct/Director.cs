using Imagine3D.Audio;
using Imagine3D.Projects;

namespace Imagine3D.Direct;

/// Turns the analysis (plus optional LLM intent) into a concrete storyboard.
/// Entirely deterministic given the project seed: the same project always renders
/// the same video, and "reroll" is an explicit bump of that seed.
public sealed class Director(EffectRegistry registry)
{
    /// Kinds that can carry a scene. Post, transition and text effects are layers
    /// over one, never the thing itself.
    public static readonly string[] SceneKinds = ["scene2d", "scene3d", "raymarch"];

    /// Sections shorter than this get folded into their neighbour - a 3-second
    /// scene reads as a glitch, not as a scene.
    const double MinSceneSeconds = 6.0;

    /// How many scenes must pass before an effect may be reused.
    const int RepeatWindow = 4;

    /// Cost of reusing an effect, charged as ReuseCost * uses^2 and never decaying.
    ///
    /// The repeat window above only keeps an effect off the screen it just left. On
    /// its own it did not produce variety, it produced a rotation: the moment the
    /// best-scoring effect aged out of the window it was the best-scoring effect
    /// again, so four or five ids took turns for an entire video.
    ///
    /// A flat per-use cost was the first fix and it was not enough either - at 1.1 a
    /// point of tag or energy advantage simply bought the leader another two scenes,
    /// and the worst storyboards in this repo still spent 25 scenes on 12 effects.
    /// Squaring it makes each additional scene cost more than the last: a second use
    /// is cheap, a fourth is most of a point of advantage, a sixth is out of reach
    /// unless the eligible pool is genuinely that small - in which case every
    /// candidate pays the same and the term cancels out of the sampler, which is the
    /// behaviour a short library wants.
    const double ReuseCost = 0.75;

    /// Half-width of the per-project cast bias, in score units.
    ///
    /// See BuildCast. Wide enough to move an effect several places up or down the
    /// ranking for one video, not so wide that it overrules the energy gate.
    const double CastSpread = 1.3;

    /// What a tag the director inferred from energy alone is worth, relative to one
    /// the song actually asked for. See BuildTags.
    const double DerivedTagWeight = 0.3;

    /// How many recent picks the family term compares against, and what a candidate
    /// sharing all of its tags with the scene just gone costs. See Score.
    const int SimilarWindow = 3;
    const double SimilarCost = 2.4;

    /// Spread of the weighted sampler, in score units.
    ///
    /// Selection used to be argmax over the scores plus a jitter of up to 0.45. The
    /// typical gap between the best and fifth-best candidate is ~1.4, so the jitter
    /// could never actually reorder them and the director only ever saw the top of
    /// its own leaderboard - the scores said "these thirty fit", the pick said "these
    /// four". Sampling in proportion to exp(score / T) keeps the scores meaningful (a
    /// point of extra score is still ~3x more likely to be picked) while letting the
    /// rest of the library appear. Still seeded, so a project renders the same way twice.
    const double Temperature = 0.9;

    /// `previous` is the plan already on disk, if any. Only its hand-picked scenes are
    /// read from it - everything else is chosen fresh - so re-planning stays a re-plan
    /// rather than an edit of the last one.
    ///
    /// `images` is the project's own image library, by filename. Empty is the normal
    /// case and costs nothing.
    public Storyboard Build(
        AudioAnalysis analysis, ProjectSettings settings, Intent? intent,
        Storyboard? previous = null, IReadOnlyList<string>? images = null)
    {
        intent ??= Intent.Empty;
        var rng = new Random(settings.Seed);

        // Drawn from its own stream, so which effects this project favours does not
        // shift every later draw when the scoring around it is tuned.
        var cast = BuildCast(new Random(settings.Seed ^ 0x5EED));

        var sections = MergeShort(analysis.Sections, analysis.Duration);
        var scenes = new List<StoryScene>();
        var recent = new List<string>();
        var recentPost = new List<string>();
        var recentTransitions = new List<string>();

        // An effect that draws one of the project's images has nothing to draw when
        // the project has none - it would render black. So the library available to
        // a project genuinely depends on what the user put in images/.
        bool useImages = settings.Images.Enabled && (images?.Count ?? 0) > 0;

        var candidates = registry.OfKind(SceneKinds)
            .Where(e => e.SupportsAspect(settings.Aspect))
            .Where(e => useImages || !e.UsesImage)
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

            // What the scene before this one looked like, and whether the music
            // wants this boundary to be a break. Both feed the pick: where
            // nothing is breaking, a scene the edit can flow into is worth a
            // little; where something is, it is worth nothing.
            var previousEffect = i > 0 ? registry.Get(scenes[i - 1].EffectId) : null;
            double prevSectionEnergy = i > 0 ? sections[i - 1].Energy : 0;
            bool wantsBreak = intensity - prevSectionEnergy > 0.15 || sec.BoundaryStrength > 0.72;

            // The auto pick is drawn even when the opener is pinned, so the two
            // paths consume the same number of RNG draws. That is all it buys:
            // the pinned id goes into `recent` and reweights every later scene,
            // so roughly half the storyboard still moves. Pinning the opener is
            // not a way to keep the rest of a plan you liked.
            var pick = PickScene(candidates, tags, intensity, recent, cast, rng,
                                 previousEffect, wantsBreak);

            // A scene the user picked by hand outranks the opening-effect setting:
            // both are the user's intent, but one is about this scene of this plan
            // and the other is a standing preference about first impressions.
            var held = FindLocked(previous, i, sec, candidates);
            var pinned = held is null && i == 0
                ? FindOpener(candidates, settings.OpeningEffect)
                : null;
            if (held is not null) pick = held;
            else if (pinned is not null) pick = pinned;
            recent.Add(pick.Id);

            var post = PickPost(pick, tags, intensity, settings.Aspect, recentPost, cast, rng, useImages);

            double prevEnergy = i > 0 ? sections[i - 1].Energy : 0;
            double delta = intensity - prevEnergy;

            // What the scene before this one looked like. The edit is a question
            // about two pictures, and until this was passed down the director was
            // only ever told about one of them.
            var outgoing = i > 0 ? registry.Get(scenes[i - 1].EffectId) : null;

            // A scene either blends with the one before it or cuts to it. Blending
            // is the more interesting edit when nothing in the music demands a
            // hard break, so it is offered first.
            var blend = PickBlend(i, sec, pick, outgoing, delta, intensity, rng);
            var (transition, transitionDur) = blend is not null
                ? ("fade", 0.0)   // the blend's own ramp is the transition
                : PickTransition(i, sec, delta, recentTransitions, cast, rng, outgoing, pick);
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
                Why: (held is not null ? "chosen by hand"
                      : pinned is not null ? "pinned as the opening effect"
                      : Explain(pick, tags, intensity))
                     + (outgoing is null ? ""
                        : $" | out of {outgoing.Id}: {outgoing.Motion}/{outgoing.Focus} -> " +
                          $"{pick.Motion}/{pick.Focus}, flow {Flow.Affinity(outgoing, pick):0.00} " +
                          $"({Flow.Describe(Flow.Affinity(outgoing, pick))})")
                     + (blend is null ? "" : $" - blended ({blend.Mode})"),
                Blend: blend,
                Locked: held is not null));
        }

        var texts = BuildTexts(analysis, sections);
        var built = scenes.ToArray();

        // Downbeats where the grid can be trusted, beats otherwise, nothing if
        // neither: image hits are snapped to it, which is most of what makes one
        // read as part of the music rather than as a timer going off.
        var grid = analysis.Downbeats.Length > 4 ? analysis.Downbeats
                 : analysis.BpmConfidence >= 0.4 ? analysis.Beats
                 : [];

        // Its own RNG stream, for the same reason the cast has one: whether this
        // video uses the user's photographs must not shift every scene pick that
        // comes after it.
        var imageCues = ImageDirector.Place(
            images ?? [], built, registry, settings, grid, new Random(settings.Seed ^ 0x1A6E));

        return new Storyboard(
            Version: Storyboard.CurrentVersion,
            Seed: settings.Seed,
            Aspect: settings.Aspect,
            Fps: settings.Fps,
            Duration: analysis.Duration,
            Mood: intent.Mood,
            Palette: string.IsNullOrWhiteSpace(intent.Palette) ? DerivePalette(analysis, rng) : intent.Palette,
            Notes: intent.Story,
            Scenes: built,
            Texts: texts,
            Ltx: [],  // filled in by the LTX stage when it runs
            Images: imageCues);
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

    /// A tag the section is asking for, and how much a candidate naming it earns.
    readonly record struct TagWeight(string Tag, double Weight);

    static TagWeight[] BuildTags(Section sec, SectionIntent? si, Intent intent)
    {
        var tags = new List<TagWeight>();
        void Add(IEnumerable<string> t, double weight = 1.0)
        {
            foreach (var x in t)
                if (!tags.Any(e => e.Tag.Equals(x, StringComparison.OrdinalIgnoreCase)))
                    tags.Add(new TagWeight(x, weight));
        }

        if (si is not null) Add(si.Tags);
        Add(intent.GlobalTags);
        Add(TagInference.FromMarkers(sec.Markers));
        Add(TagInference.FromText(sec.Lyrics));

        // Energy always contributes, so a section with no words still steers - but
        // it contributes at a fraction of a real tag, because the section's energy is
        // already scored on its own and scored heavily.
        //
        // At full weight these four words were the whole reason two effects appeared
        // in every video in this repo. `lightning` was the only scene effect naming
        // both "high-energy" and "aggressive", and `copperbars` one of very few naming
        // both "calm" and "sparse" - both have since been removed for other reasons,
        // but the shape of the problem is not about them - so each collected a free
        // two-tag match on every loud (respectively quiet) section of every song:
        // roughly a point of advantage, compounded by a sampler that is
        // exponential in score. The music
        // never asked for them; the director inferred them from the same number it was
        // about to score again.
        if (sec.Energy > 0.72) Add(["high-energy", "aggressive"], DerivedTagWeight);
        else if (sec.Energy < 0.32) Add(["calm", "sparse"], DerivedTagWeight);

        return tags.ToArray();
    }

    /// A per-project bias for every effect in the library.
    ///
    /// Every other term is a property of the effect and the section and nothing else,
    /// so the same effect won the same kind of section in every song: measured over
    /// the 17 projects in this repo, `lightning` appeared in 17 of 17 and `copperbars`
    /// opened 7 of them (both since removed), while five scene effects were never
    /// picked at all. The weighted sampler cannot fix that on its own - it draws
    /// from an identical distribution every time, so a candidate half a point ahead
    /// is favoured in every video rather than in half of them.
    ///
    /// Giving each project a cast drawn from its seed makes that half-point advantage
    /// local: an effect that leads one video sits near the bottom of the next, and
    /// rerolling the seed genuinely re-casts instead of reshuffling. Ordered by id so
    /// the draw does not depend on the order the registry happened to scan folders in.
    Dictionary<string, double> BuildCast(Random rng) =>
        registry.All
            .OrderBy(e => e.Id, StringComparer.Ordinal)
            .ToDictionary(
                e => e.Id,
                _ => (rng.NextDouble() - 0.5) * 2 * CastSpread,
                StringComparer.OrdinalIgnoreCase);

    /// The pinned opening effect, or null to let the director decide.
    ///
    /// An id that is not in the candidate list - deleted effect, renamed folder,
    /// or one that does not support this aspect - falls back to the normal pick
    /// rather than throwing. A pin is a preference about the first six seconds;
    /// it has no business failing a render.
    static EffectManifest? FindOpener(List<EffectManifest> candidates, string? id) =>
        string.IsNullOrWhiteSpace(id)
            ? null
            : candidates.FirstOrDefault(e => e.Id.Equals(id.Trim(), StringComparison.OrdinalIgnoreCase));

    /// The effect the user chose for this scene last time, if it still applies.
    ///
    /// Matched on both the index and the start time. A lock is a statement about a
    /// moment in the song, not about an array slot: re-analysing can move where the
    /// sections fall, and silently applying scene 7's pick to a different part of the
    /// music is worse than quietly letting it go. Same for an effect that has since
    /// been deleted or that this aspect ratio cannot render - the director just picks.
    static EffectManifest? FindLocked(
        Storyboard? previous, int index, Section sec, List<EffectManifest> candidates)
    {
        if (previous is null || index >= previous.Scenes.Length) return null;

        var was = previous.Scenes[index];
        if (!was.Locked || Math.Abs(was.Start - sec.Start) > 0.75) return null;

        return candidates.FirstOrDefault(
            e => e.Id.Equals(was.EffectId, StringComparison.OrdinalIgnoreCase));
    }

    /// What a scene that flows out of the one before it is worth, in score units.
    ///
    /// Small on purpose. Tags and energy still decide what a section gets; this
    /// only breaks ties between candidates that already fit, in favour of the one
    /// the edit can actually get to. Larger than about 1.2 and the whole video
    /// converges on one motion class, because every pick then reinforces the next.
    ///
    /// It deliberately pulls against SimilarCost, and the two are about different
    /// things: SimilarCost is content repetition - three fractals in a row read as
    /// one effect that would not stop - where this is continuity of form. Two
    /// corridor flights with nothing else in common flow into each other and do
    /// not read as a repeat.
    const double FlowBonus = 0.85;

    EffectManifest PickScene(
        List<EffectManifest> candidates, TagWeight[] tags, double energy,
        List<string> recent, IReadOnlyDictionary<string, double> cast, Random rng,
        EffectManifest? outgoing = null, bool wantsBreak = false)
    {
        // Energy is a hard gate, not a preference.
        //
        // It used to be one term among several, and a well-tagged effect could
        // out-argue it: the since-removed `lightning` (declared [0.5, 1.0]) would
        // win a section at energy 0.2 on tag overlap alone, which is exactly as
        // wrong as it sounds. A quiet passage now can only be given something that
        // says it suits a quiet passage.
        var eligible = candidates.Where(e => e.FitsEnergy(energy)).ToList();

        // Widen only if nothing at all is declared for this energy, so a library
        // with a gap still produces a video rather than throwing.
        if (eligible.Count == 0)
            eligible = candidates.Where(e => e.FitsEnergy(energy, 0.3)).ToList();
        if (eligible.Count == 0)
            eligible = candidates.OrderBy(e => e.EnergyMiss(energy)).Take(4).ToList();

        // Where the music is not asking for a break, prefer a picture the edit
        // can flow into. Where it is, this is switched off entirely - a scene
        // that arrives on a downbeat after a big lift is supposed to be a
        // different thing, and smoothing that over is the opposite of the job.
        var scored = eligible.Select(e => (
            Item: e,
            Score: Score(e, tags, energy, recent, cast)
                   + (wantsBreak || outgoing is null
                      ? 0.0
                      : FlowBonus * (Flow.Affinity(outgoing, e) - 0.5) * 2.0))).ToList();

        return SampleByScore(scored, rng, Temperature);
    }

    /// Pick in proportion to exp(score / temperature) rather than taking the maximum.
    ///
    /// A clearly better fit is still strongly favoured - the weights fall off fast -
    /// but a candidate a point or two behind is now reachable instead of unreachable,
    /// which is the difference between a library of sixty effects and a library of four.
    static T SampleByScore<T>(IReadOnlyList<(T Item, double Score)> scored, Random rng, double temperature)
    {
        // Offset by the best score before exponentiating, so a run of large negative
        // scores cannot underflow every weight to zero at once.
        double best = scored.Max(x => x.Score);

        var weights = new double[scored.Count];
        double total = 0;
        for (int i = 0; i < scored.Count; i++)
            total += weights[i] = Math.Exp((scored[i].Score - best) / temperature);

        double r = rng.NextDouble() * total;
        for (int i = 0; i < weights.Length; i++)
            if ((r -= weights[i]) <= 0) return scored[i].Item;

        return scored[^1].Item;   // only reachable through floating-point drift
    }

    double Score(
        EffectManifest e, TagWeight[] tags, double energy,
        List<string> recent, IReadOnlyDictionary<string, double> cast)
    {
        double score = 0;

        // Tag overlap is the main signal, normalised by how many tags the effect
        // declares. Raw overlap rewards breadth: an effect tagged with eight
        // moods matches almost any section and crowds out focused effects, which
        // is exactly what happened when the library grew.
        double overlap = 0;
        foreach (var t in tags)
            if (e.Tags.Contains(t.Tag, StringComparer.OrdinalIgnoreCase))
                overlap += t.Weight;
        score += overlap * 2.0 / Math.Sqrt(Math.Max(1, e.Tags.Length));

        // Energy fit. Outside the declared band the penalty is steep enough that
        // no amount of tag agreement rescues it; inside, being near the middle of
        // the band is rewarded, so a section at 0.9 prefers something built for
        // 0.9 over something merely tolerant of it.
        double miss = e.EnergyMiss(energy);
        if (miss > 0)
        {
            score -= 12.0 * miss;
        }
        else
        {
            double mid = (e.EnergyLo + e.EnergyHi) / 2;
            double halfWidth = Math.Max(0.01, (e.EnergyHi - e.EnergyLo) / 2);
            score += 2.5 * (1 - Math.Abs(energy - mid) / halfWidth);

            // A narrow band is a specific claim about where an effect belongs;
            // reward that over an effect declaring it suits almost anything.
            score += 1.2 * (1.0 - (e.EnergyHi - e.EnergyLo));
        }

        // Repetition, in two parts. The window term is about adjacency - the same
        // effect twice in a row reads as a stall - and decays with age. The reuse
        // term is about the video as a whole and never decays, and grows faster than
        // the count, so each further scene an effect carries costs more than the last.
        int uses = 0;
        foreach (var id in recent) if (id == e.Id) uses++;
        if (uses > 0)
        {
            int since = recent.Count - 1 - recent.LastIndexOf(e.Id);
            if (since < RepeatWindow)
                score -= 6.0 * (RepeatWindow - since) / RepeatWindow;

            score -= ReuseCost * uses * uses;
        }

        // Repetition by family, not just by id. Three fractal raymarchers in a row
        // are three different ids and read as one effect that would not stop: the
        // storyboards in this repo are full of kaliset into fractalpyramid into
        // apollonian, which share five of their six tags. Charging for tag overlap
        // with what just played is the cheapest way to say "something else now"
        // without inventing a family field every manifest would have to maintain.
        double crowding = 0;
        for (int k = Math.Max(0, recent.Count - SimilarWindow); k < recent.Count; k++)
        {
            var prev = registry.Get(recent[k]);
            if (prev is null || prev.Id.Equals(e.Id, StringComparison.OrdinalIgnoreCase))
                continue;   // an exact repeat is already priced above

            int age = recent.Count - k;   // 1 is the scene immediately before
            crowding += TagSimilarity(prev.Tags, e.Tags) * (SimilarWindow + 1 - age) / SimilarWindow;
        }
        score -= SimilarCost * crowding;

        score -= 0.25 * e.CostWeight;

        // What the effect itself says about how often it should appear.
        score += e.RarityBias(Temperature);

        // This project's taste. Constant for the whole video, so it tilts which
        // effects are in the running without ever overriding the energy gate.
        score += cast.GetValueOrDefault(e.Id);

        return score;
    }

    /// Jaccard overlap of two tag sets, 0 (nothing in common) to 1 (identical).
    static double TagSimilarity(string[] a, string[] b)
    {
        if (a.Length == 0 || b.Length == 0) return 0;
        int shared = a.Count(t => b.Contains(t, StringComparer.OrdinalIgnoreCase));
        return (double)shared / (a.Length + b.Length - shared);
    }

    PostEffect[] PickPost(
        EffectManifest scene, TagWeight[] tags, double energy, string aspect,
        List<string> recent, IReadOnlyDictionary<string, double> cast, Random rng,
        bool useImages)
    {
        var pool = registry.OfKind("post")
            .Where(e => e.SupportsAspect(aspect))
            .Where(e => useImages || !e.UsesImage)
            // Utility passes - scene blending, the lyric layer, LTX compositing - are
            // plumbing the renderer drives by id. They carry a manifest so the loader
            // finds them, not so the director may decorate a scene with one.
            .Where(e => !e.Tags.Contains("utility", StringComparer.OrdinalIgnoreCase))
            .Where(e => e.FitsEnergy(energy))
            .Where(e => !scene.Conflicts.Contains(e.Id) && !e.Conflicts.Contains(scene.Id))
            .ToList();
        if (pool.Count == 0) return [];

        // Busier sections carry more layers. A genuinely quiet passage gets
        // nothing on top at all - that emptiness is what gives the loud sections
        // somewhere to arrive from.
        int want = energy > 0.72 ? 3 : energy > 0.45 ? 2 : energy > 0.24 ? 1 : 0;
        if (want == 0) return [];

        // `recent` spans the whole storyboard, not just this scene. It used to be
        // passed as an empty list, which meant the post scorer had no memory at all
        // and simply re-derived the same ranking every scene: one shader sat on top
        // of 57% of the video and two of the twelve were never used.
        var chosen = new List<EffectManifest>();
        while (chosen.Count < want && pool.Count > 0)
        {
            var scored = pool.Select(e => (Item: e, Score: Score(e, tags, energy, recent, cast))).ToList();
            var pick = SampleByScore(scored, rng, Temperature);
            pool.Remove(pick);

            if (chosen.Any(c => c.Conflicts.Contains(pick.Id) || pick.Conflicts.Contains(c.Id))) continue;
            chosen.Add(pick);
            recent.Add(pick.Id);
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

    /// How much emptier the frame has to get before the boundary counts as one
    /// the picture cannot absorb on its own. See Emptying.
    const double EmptyingGap = 0.22;

    /// How much of the frame the outgoing scene fills and the incoming one does
    /// not. Positive only: arriving at a fuller frame is never the problem.
    ///
    /// This is the edit the complaint is about. A busy full-frame shader cut to
    /// something sparse - orbs floating in a void - falls off a cliff no matter
    /// which transition is running, because a wipe or a dissolve can only trade
    /// one picture for another and there is no second picture over most of the
    /// frame. Arriving somewhere fuller reads fine: things turn up.
    static double Emptying(EffectManifest? from, EffectManifest to) =>
        from is null ? 0 : Math.Max(0, from.Coverage - to.Coverage);

    /// Decide whether this scene layers over the previous one instead of cutting.
    ///
    /// Cutting every time makes a long video feel like a slideshow. Blending is
    /// held back where the music genuinely breaks - a big energy jump or a strong
    /// section boundary earns a cut - and used elsewhere.
    SceneBlend? PickBlend(
        int index, Section sec, EffectManifest scene, EffectManifest? outgoing,
        double energyDelta, double energy, Random rng)
    {
        if (index == 0) return null;

        // A real musical break should land as a break.
        if (energyDelta > 0.18 || sec.BoundaryStrength > 0.75) return null;

        // Two expensive scenes drawn every frame would halve the render rate.
        if (scene.Cost == "high" && rng.NextDouble() < 0.75) return null;

        // Too short to establish a layered look.
        if (sec.Duration < MinSceneSeconds * 1.5) return null;

        // Two pictures that share nothing must not be layered.
        //
        // A blend holds both on screen for seconds, so it asks far more of the
        // pair than a one-second dissolve does: the eye has to be able to read
        // them as one image. Where they disagree about which way the frame is
        // travelling - a flight into the screen over one falling away from it -
        // there is no reading, and the result is mush that looks like a bug.
        // Below the floor the boundary goes to PickTransition to be cut.
        //
        // LayerAffinity, not Affinity: it leaves the coverage gap out, because a
        // coverage gap is an argument *for* layering rather than against it. See
        // the note there.
        double affinity = Flow.LayerAffinity(outgoing, scene);
        if (affinity < Flow.BlendFloor) return null;

        // Emptying out is the one case where layering is clearly the right answer
        // rather than merely a nicer one: the outgoing scene stays underneath and
        // thins away, so the frame is never asked to be full and empty in the same
        // instant. At a full drop this takes the odds to near certain.
        //
        // Affinity is the other half of the same question. A pair that shares its
        // motion and its framing is what layering was invented for, and a pair
        // that only just clears the floor should get it occasionally rather than
        // half the time.
        double emptying = Emptying(outgoing, scene);
        if (rng.NextDouble() > 0.22 + affinity * 0.85 + emptying * 0.90) return null;

        var pool = energy > 0.55 ? HotBlends : CoolBlends;
        var mode = pool[rng.Next(pool.Length)];

        // Either layer for the whole scene, or bleed through for a few seconds
        // and resolve to the new scene alone. A big drop wants the sustained
        // version - a short bleed-through leaves the same cliff a few seconds
        // later, just with a longer run-up.
        bool wholeScene = rng.NextDouble() < 0.35 + emptying * 0.6;
        double duration = wholeScene ? 0 : Math.Min(sec.Duration * 0.7, 3.0 + rng.NextDouble() * 5.0);

        // The ramp has to be long enough to cover the drop it is hiding.
        double fade = Math.Min(2.6, Math.Max(0.6, sec.Duration * 0.12) + emptying * 2.0);
        fade = Math.Min(fade, sec.Duration * 0.35);

        // Sustained layering sits back so the new scene still reads; a short
        // bleed-through can afford to be strong.
        var amount = wholeScene
            ? "0.30 + 0.22*rms"
            : "0.55 + 0.35*rms";

        return new SceneBlend(mode, amount, Math.Round(duration, 2), Math.Round(fade, 2));
    }

    /// How many boundaries must pass before a transition may be used again.
    const int TransitionRepeatWindow = 5;

    /// Decays with age, so a transition used five boundaries ago is fair game, plus a
    /// per-use cost that does not - see ReuseCost for why the decaying term alone
    /// rotates a handful of ids rather than spending the library.
    static double RepetitionPenalty(string id, List<string> recent)
    {
        int last = recent.LastIndexOf(id);
        if (last < 0) return 0;

        int uses = 0;
        foreach (var r in recent) if (r == id) uses++;

        int since = recent.Count - 1 - last;
        double penalty = -ReuseCost * uses * uses;
        if (since < TransitionRepeatWindow)
            penalty -= 5.0 * (TransitionRepeatWindow - since) / TransitionRepeatWindow;

        return penalty;
    }

    (string Id, double Duration) PickTransition(
        int index, Section sec, double energyDelta, List<string> recent,
        IReadOnlyDictionary<string, double> cast, Random rng,
        EffectManifest? outgoing, EffectManifest incoming)
    {
        if (index == 0) return ("fadethrough", 1.4);

        var pool = registry.OfKind("transition").ToList();
        if (pool.Count == 0) return ("cut", 0);

        double emptying = Emptying(outgoing, incoming);
        bool cliff = emptying > EmptyingGap;

        // How well these two pictures can become one another. See Flow.
        double affinity = Flow.Affinity(outgoing, incoming);

        // A hard boundary into a louder section wants a cut; a gentle one into a
        // quieter section wants a dissolve. This is the single most audible way the
        // edit either matches the music or fights it.
        //
        // Except over a cliff. A hard cut is a statement that the two shots belong
        // next to each other, and when one of them cannot fill the frame the other
        // just left, it is not a statement, it is a hole - so the music no longer
        // gets to ask for one.
        //
        // The picture gets to ask for one, though. Two shots travelling opposite
        // ways share no optical flow for a dissolve to ride on, and mixing them
        // slowly just shows both at once for a second and a half. A cut says
        // "these are two different things", which is true and is also the easiest
        // thing for the eye to follow. Over a cliff the hole still outranks it.
        bool mismatch = !cliff && affinity < Flow.CutBelow;
        bool hard = !cliff && (mismatch || energyDelta > 0.15 || sec.BoundaryStrength > 0.72);

        // Conversely a pair that agrees about everything can take a long mix,
        // whatever the music is doing - the two shots are near enough the same
        // picture that a dissolve reads as one continuous move.
        bool soft = !hard && (energyDelta < -0.1 || affinity >= 0.82);

        var wanted = hard ? new[] { "hard", "impact", "glitch" }
                   : cliff ? ["soft", "dissolve", "cinematic"]
                   : soft ? ["soft", "dissolve", "fluid", "cinematic"]
                   : ["wipe", "geometric", "mechanical", "retro"];

        var scored = pool
            .Select(e => (Item: e, Score: e.Tags.Count(t => wanted.Contains(t)) * 2.0
                             + (e.FitsEnergy(sec.Energy) ? 0.8 : -1.5)
                             // Without this the best-matching transition wins every
                             // comparable boundary - one shader ends up carrying
                             // half the edits and the video reads as repetitive.
                             + RepetitionPenalty(e.Id, recent)
                             + e.RarityBias(Temperature)
                             + cast.GetValueOrDefault(e.Id)
                             // Over a cliff, the transition that never puts both
                             // scenes on screen at once is the honest one: it fades
                             // the full frame out and the sparse one in, so nothing
                             // ever has to sit next to a hole. Wipes are the worst
                             // answer here for the same reason - they hold the two
                             // side by side and show you the difference.
                             + (cliff && e.Id == "fadethrough" ? 2.6 : 0.0)
                             + (cliff && e.Tags.Contains("wipe") ? -2.2 : 0.0)))
            .ToList();

        var pick = SampleByScore(scored, rng, Temperature);

        // Duration varies per pick rather than per class, so repeated use of the
        // same wipe does not always take exactly the same time.
        double dur = hard ? 0.12 + rng.NextDouble() * 0.25
                   : soft ? 1.2 + rng.NextDouble() * 1.6
                   : 0.5 + rng.NextDouble() * 1.0;

        // A mix is only worth having for as long as the two shots have something
        // in common. Scaled by affinity rather than set by the music alone: a
        // well-matched pair can hold a long dissolve and look deliberate, and a
        // badly matched one looks like a fault the longer it runs.
        if (!hard) dur *= 0.65 + 0.75 * affinity;

        // However the music reads, the picture needs time in proportion to how far
        // it has to travel. A 0.5s wipe between two comparable frames is brisk;
        // the same 0.5s off a full frame onto a near-empty one is a light switch.
        dur = Math.Max(dur, emptying * 2.6);

        // A fade-through has to cover three phases, so give it room.
        if (pick.Id == "fadethrough") dur = Math.Max(dur, 1.1);

        // Never let a transition eat more than a third of the scene it opens.
        dur = Math.Min(dur, sec.Duration / 3);

        return (pick.Id, Math.Round(dur, 3));
    }

    /// A one-line reason, stored on the scene and shown in the UI. The director
    /// making an opaque choice is the thing that makes a generated video feel
    /// arbitrary; saying why it picked this scene is most of the fix.
    static string Explain(EffectManifest e, TagWeight[] tags, double energy)
    {
        // Only the tags the song actually asked for are worth naming: the ones the
        // director inferred from energy would have it explain the energy twice.
        var asked = tags.Where(t => t.Weight >= 1.0).Select(t => t.Tag).ToArray();
        var matched = e.Tags.Where(t => asked.Contains(t, StringComparer.OrdinalIgnoreCase)).ToArray();
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
