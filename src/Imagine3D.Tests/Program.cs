using System.Diagnostics;
using System.Text.Json;
using System.Text.RegularExpressions;
using Imagine3D.Audio;
using Imagine3D.Direct;
using Imagine3D.Lyrics;
using Imagine3D.Projects;

namespace Imagine3D.Tests;

// Console harness: runs the analysis chain over a real song and prints what it
// found, so the DSP can be sanity-checked without the UI in the way.
//   dotnet run --project src/Imagine3D.Tests -- <song.mp3>
static class Program
{
    static int Main(string[] args)
    {
        if (args.Length > 0 && args[0] == "--align")
            return AlignmentReport(args.Skip(1).ToArray()).GetAwaiter().GetResult();

        if (args.Length > 0 && args[0] == "--trim")
            return TrimReport(args.Skip(1).ToArray());

        if (args.Length > 0 && args[0] == "--variety")
            return VarietyReport(args.Skip(1).ToArray());

        if (args.Length > 0 && args[0] == "--flow")
            return FlowReport(args.Skip(1).ToArray());

        if (args.Length > 0 && args[0] == "--lyrics")
            return LyricReport(args.Skip(1).ToArray());

        int failures = 0;
        failures += UnitTests();

        var mp3 = args.FirstOrDefault() ?? @"D:\Dev\Mp3ToVid\mp3\Time.mp3";
        if (!File.Exists(mp3))
        {
            Console.WriteLine($"\n(skipping song analysis - {mp3} not found)");
            return failures;
        }

        Console.WriteLine($"\n=== Analysing {Path.GetFileName(mp3)} ===");
        var txt = Path.ChangeExtension(mp3, ".txt");
        var lyrics = File.Exists(txt) ? File.ReadAllText(txt) : null;

        var sw = Stopwatch.StartNew();
        var (a, wave) = new AudioAnalyzer().Analyze(
            mp3, lyrics, new AudioAnalyzer.Options(null, null),
            new Progress<Imagine3D.Pipeline.StageProgress>(p =>
                Console.WriteLine($"  [{p.Fraction,5:P0}] {p.Detail}")));
        sw.Stop();

        Console.WriteLine($"\nAnalysed in {sw.Elapsed.TotalSeconds:F1}s");
        Console.WriteLine($"  duration    {a.Duration:F1}s @ {a.SampleRate} Hz, {a.FrameRate:F1} frames/s");
        Console.WriteLine($"  tempo       {a.Bpm:F1} BPM  confidence {a.BpmConfidence:P0}  " +
                          $"(alternate {a.BpmAlternate:F1})  grid reliable: {a.BeatGridReliable}");
        Console.WriteLine($"  beats       {a.Beats.Length} ({a.Downbeats.Length} downbeats)");
        Console.WriteLine($"  onsets      {a.Onsets.Length}");
        Console.WriteLine($"  waveform    {wave.Buckets} buckets");

        // Beat spacing regularity - the honest check on whether the grid is real.
        if (a.Beats.Length > 2)
        {
            var gaps = a.Beats.Zip(a.Beats.Skip(1), (x, y) => y - x).ToArray();
            double mean = gaps.Average();
            double sd = Math.Sqrt(gaps.Sum(g => (g - mean) * (g - mean)) / gaps.Length);
            Console.WriteLine($"  beat gap    {mean:F3}s +/- {sd:F3}s  ({60 / mean:F1} BPM implied)");
        }

        Console.WriteLine($"\n  {a.Sections.Length} sections:");
        foreach (var s in a.Sections)
        {
            var marker = s.Markers.FirstOrDefault() ?? "";
            var lyric = s.Lyrics.FirstOrDefault() ?? "";
            Console.WriteLine($"    {s.Index,2}. {s.Start,6:F1}s-{s.End,6:F1}s  [{s.Label}] " +
                              $"energy {s.Energy:F2}  {Trunc(marker, 28),-28} {Trunc(lyric, 30)}");
        }

        Console.WriteLine($"\n  {a.Lyrics.Length} lyric lines aligned, first 8:");
        foreach (var l in a.Lyrics.Take(8))
            Console.WriteLine($"    {l.Start,6:F1}s {(l.IsMarker ? "M" : " ")} {Trunc(l.Text, 60)}");

        // What matters for a modulation source is how much it MOVES, not its mean.
        // A band pinned near 1.0 with no spread drives nothing.
        Console.WriteLine($"\n  band dynamics (p10 / median / p90, spread):");
        for (int i = 0; i < a.Bands.Length; i++)
        {
            var v = (float[])a.Bands[i].Clone();
            Array.Sort(v);
            float P(double p) => v[Math.Clamp((int)(v.Length * p), 0, v.Length - 1)];
            double mean = a.Bands[i].Average();
            double sd = Math.Sqrt(a.Bands[i].Sum(x => (x - mean) * (x - mean)) / v.Length);
            Console.WriteLine($"    {a.BandNames[i],-8} {P(0.10):F2} / {P(0.50):F2} / {P(0.90):F2}" +
                              $"   sd {sd:F3}  {Bar(P(0.90) - P(0.10))}");
        }

        SpectrumReport(a);

        return failures;
    }

    /// How much the spectrum bands actually say that the level does not.
    ///
    /// Band *level* is the wrong thing to drive a visual with on its own, and the
    /// numbers here are why: every band rises and falls with the arrangement, so
    /// they correlate with the RMS envelope and with each other, and an effect
    /// bound to one of them ends up pulsing on the beat like everything else -
    /// which is the complaint that prompted the fine bands existing at all.
    ///
    /// Subtracting the instantaneous mean across the bands leaves the spectral
    /// *shape* - which way the energy is leaning right now - and that is very
    /// nearly uncorrelated with loudness. The engine derives its `*Rel` sources
    /// exactly this way (see engine/modulation.js); this measures the property
    /// they depend on, on real material, rather than assuming it.
    static void SpectrumReport(AudioAnalysis a)
    {
        if (a.FineBands is not { Length: > 0 } fine) { Console.WriteLine("\n  (no fine bands)"); return; }
        int n = fine.Length, frames = fine[0].Length;

        Console.WriteLine($"\n  fine spectrum ({n} bands, {a.FineBandHz?[0]:F0}-{a.FineBandHz?[n]:F0} Hz):");
        for (int i = 0; i < n; i++)
        {
            var v = (float[])fine[i].Clone();
            Array.Sort(v);
            float P(double p) => v[Math.Clamp((int)(v.Length * p), 0, v.Length - 1)];
            Console.WriteLine($"    {a.FineBandHz?[i],7:F0}-{a.FineBandHz?[i + 1],-7:F0} " +
                              $"{P(0.10):F2} / {P(0.50):F2} / {P(0.90):F2}  {Bar(P(0.90) - P(0.10))}");
        }

        // Shape: each band against the mean across bands at that instant.
        var shape = new float[n][];
        for (int i = 0; i < n; i++) shape[i] = new float[frames];
        for (int f = 0; f < frames; f++)
        {
            double mean = 0;
            for (int i = 0; i < n; i++) mean += fine[i][f];
            mean /= n;
            for (int i = 0; i < n; i++) shape[i][f] = (float)(fine[i][f] - mean);
        }

        double MeanPairwise(float[][] x)
        {
            double sum = 0; int c = 0;
            for (int i = 0; i < n; i++)
                for (int j = i + 1; j < n; j++) { sum += Math.Abs(Corr(x[i], x[j])); c++; }
            return sum / Math.Max(1, c);
        }
        double MeanVsRms(float[][] x)
        {
            double sum = 0;
            for (int i = 0; i < n; i++) sum += Math.Abs(Corr(x[i], a.Rms));
            return sum / n;
        }

        Console.WriteLine("\n  decorrelation (mean |r|, lower is more independent):");
        Console.WriteLine($"    band level  vs each other {MeanPairwise(fine),5:F2}   vs rms {MeanVsRms(fine),5:F2}");
        Console.WriteLine($"    band shape  vs each other {MeanPairwise(shape),5:F2}   vs rms {MeanVsRms(shape),5:F2}");
    }

    static double Corr(float[] a, float[] b)
    {
        int n = Math.Min(a.Length, b.Length);
        if (n == 0) return 0;
        double ma = 0, mb = 0;
        for (int i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
        ma /= n; mb /= n;
        double num = 0, va = 0, vb = 0;
        for (int i = 0; i < n; i++)
        {
            double da = a[i] - ma, db = b[i] - mb;
            num += da * db; va += da * da; vb += db * db;
        }
        return va < 1e-12 || vb < 1e-12 ? 0 : num / Math.Sqrt(va * vb);
    }

    /// Measures how well Whisper + forced alignment times a real song's lyrics.
    ///   dotnet run --project src/Imagine3D.Tests -- --align [song.mp3] [model...]
    static async Task<int> AlignmentReport(string[] args)
    {
        var mp3 = args.FirstOrDefault(a => a.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase))
                  ?? @"D:\Dev\Mp3ToVid\mp3\Time.mp3";
        var models = args.Where(a => !a.EndsWith(".mp3", StringComparison.OrdinalIgnoreCase)).ToArray();
        if (models.Length == 0) models = ["small", "medium"];

        var txt = Path.ChangeExtension(mp3, ".txt");
        if (!File.Exists(mp3) || !File.Exists(txt))
        {
            Console.WriteLine($"need {mp3} and {txt}");
            return 1;
        }

        var song = SongText.Parse(File.ReadAllText(txt));
        var lines = song.Lyrics.Replace("\r\n", "\n").Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0 && !(l.StartsWith('[') && l.EndsWith(']')))
            .ToList();

        var ffmpeg = new Imagine3D.Media.Ffmpeg();
        double duration = ffmpeg.GetDuration(mp3);
        var work = Path.Combine(Path.GetTempPath(), "i3d_align_test");
        var transcriber = new WhisperTranscriber(ffmpeg);

        Console.WriteLine($"song  : {Path.GetFileName(mp3)}  {duration:F1}s");
        Console.WriteLine($"lyrics: {lines.Count} lines, {lines.Sum(l => l.Split(' ').Length)} words");
        Console.WriteLine($"python: {WhisperTranscriber.FindPython() ?? "NOT FOUND"}\n");

        foreach (var model in models)
        foreach (var isolate in new[] { false, true })
        {
            var sw = Stopwatch.StartNew();
            WordStamp[] words;
            try
            {
                words = await transcriber.TranscribeAsync(mp3, work, model, song.Lyrics, isolate);
            }
            catch (Exception e)
            {
                Console.WriteLine($"{model,-7} isolate={isolate,-5}  FAILED: {Trunc(e.Message, 100)}");
                continue;
            }
            sw.Stop();

            var r = ForcedAligner.AlignLines(lines, words, duration);
            Console.WriteLine(
                $"{model,-7} isolate={isolate,-5}  {sw.Elapsed.TotalSeconds,5:F1}s  " +
                $"heard={r.TranscribedWords,4}  anchored words={r.MatchedWords,4}  " +
                $"lines with an anchor={r.AnchoredLines,3}/{r.TotalLines}  ({r.Coverage:P0})");
        }

        // Show the best configuration's actual line timings for eyeballing.
        Console.WriteLine("\nSample timings (medium, isolated):");
        var best = await transcriber.TranscribeAsync(mp3, work, "medium", song.Lyrics, true);
        var final = ForcedAligner.AlignLines(lines, best, duration);
        foreach (var l in final.Lines.Take(18))
            Console.WriteLine($"  {l.Start,7:F2}s {(l.Anchored ? "*" : " ")} {Trunc(l.Text, 52)}");

        return 0;
    }

    /// Checks that the size-targeted trim actually lands under its ceiling.
    ///   dotnet run --project src/Imagine3D.Tests -- --trim <video.mp4> [minutes] [targetMb]
    static int TrimReport(string[] args)
    {
        var src = args.ElementAtOrDefault(0)
                  ?? @"D:\Dev\Imagine3D\projects\Time\output\Time_16x9.mp4";
        double minutes = double.TryParse(args.ElementAtOrDefault(1), out var mm) ? mm : 4;
        double targetMb = double.TryParse(args.ElementAtOrDefault(2), out var tt) ? tt : 185;

        if (!File.Exists(src)) { Console.WriteLine($"not found: {src}"); return 1; }

        var ffmpeg = new Imagine3D.Media.Ffmpeg();
        double duration = ffmpeg.GetDuration(src);
        double seconds = Math.Min(duration, minutes * 60);
        var dst = Path.Combine(Path.GetTempPath(), "i3d_trim_test.mp4");

        Console.WriteLine($"source : {Path.GetFileName(src)}  {duration:F0}s  " +
                          $"{new FileInfo(src).Length / 1048576.0:F0} MB");
        Console.WriteLine($"target : first {seconds:F0}s, under {targetMb:F0} MB\n");

        var sw = Stopwatch.StartNew();
        int kbps = ffmpeg.TrimToSize(src, dst, seconds, targetMb);
        sw.Stop();

        double actual = new FileInfo(dst).Length / 1048576.0;
        double outDur = ffmpeg.GetDuration(dst);

        Console.WriteLine($"video bitrate : {kbps} kbps");
        Console.WriteLine($"encode time   : {sw.Elapsed.TotalSeconds:F0}s");
        Console.WriteLine($"result        : {actual:F1} MB, {outDur:F1}s");
        Console.WriteLine($"vs target     : {actual - targetMb:+0.0;-0.0} MB " +
                          $"({actual / targetMb:P1} of the ceiling)");

        bool ok = actual <= targetMb && Math.Abs(outDur - seconds) < 1.0;
        Console.WriteLine(ok ? "\nPASS - under the ceiling and the right length"
                             : "\nFAIL - over the ceiling or the wrong length");
        return ok ? 0 : 1;
    }

    /// How evenly the director spends the effect library.
    ///
    /// Replans every project that has an analysis on disk, over a spread of seeds,
    /// and reports what got picked. The complaint this answers is not a crash - it is
    /// "the same effect is in every video" - and the only way to see that is in
    /// aggregate, across projects, which no single render shows.
    ///   dotnet run --project src/Imagine3D.Tests -- --variety [seeds] [projectsRoot]
    /// Prints the flow mapping: which scenes can be dissolved into which, and
    /// which pairs want a hard cut.
    ///
    /// The mapping is derived, not stored - see Flow. Every effect declares what
    /// its picture does (`motion`) and how it is organised (`focus`), and the
    /// score for a pair falls out of those plus the coverage gap. This report is
    /// how you read the result without running a render: pass an effect id for
    /// its own row, or nothing for the whole library.
    ///
    ///   dotnet run --project src/Imagine3D.Tests -- --flow [effectId]
    static int FlowReport(string[] args)
    {
        var registry = EffectRegistry.Load(FindWebRoot());
        var scenes = registry.OfKind("scene2d", "scene3d", "raymarch")
            .OrderBy(e => e.Id, StringComparer.Ordinal).ToList();

        if (scenes.Count == 0) { Console.WriteLine("no scene effects found"); return 1; }

        var only = args.FirstOrDefault();

        Console.WriteLine("=== Flow mapping ===");
        Console.WriteLine($"{scenes.Count} scene effects. Score is how well the incoming scene can be");
        Console.WriteLine("mixed out of the outgoing one: 0.82+ flows, 0.58+ blends, under 0.42 wants a cut.\n");

        // --- the classes the score is built from ---------------------------
        Console.WriteLine("  motion x focus");
        foreach (var g in scenes.GroupBy(e => $"{e.Motion,-9} {e.Focus,-7}").OrderBy(g => g.Key))
            Console.WriteLine($"    {g.Key}  {g.Count(),2}  {string.Join(" ", g.Select(e => e.Id))}");
        Console.WriteLine();

        // --- per-effect rows ------------------------------------------------
        foreach (var from in scenes)
        {
            if (only is not null && !from.Id.Equals(only, StringComparison.OrdinalIgnoreCase)) continue;

            var scored = scenes
                .Where(t => !t.Id.Equals(from.Id, StringComparison.OrdinalIgnoreCase))
                .Select(t => (Id: t.Id, Score: Flow.Affinity(from, t)))
                .OrderByDescending(x => x.Score)
                .ToList();

            Console.WriteLine($"  {from.Id}  ({from.Motion}/{from.Focus}, coverage {from.Coverage:0.00})");
            Console.WriteLine($"    flows into   {string.Join("  ", scored.Take(6).Select(x => $"{x.Id} {x.Score:0.00}"))}");
            Console.WriteLine($"    cut to       {string.Join("  ", scored.TakeLast(6).Reverse().Select(x => $"{x.Id} {x.Score:0.00}"))}");

            if (only is not null)
            {
                Console.WriteLine("\n    full row, best first:");
                foreach (var x in scored)
                    Console.WriteLine($"      {x.Score:0.00}  {Flow.Describe(x.Score),-28}  {x.Id}");
            }
            Console.WriteLine();
        }

        if (only is null)
        {
            // How the library divides overall - the number that says whether the
            // director has room to choose, or whether everything wants a cut.
            int pairs = 0, flows = 0, blends = 0, shorts = 0, cuts = 0;
            foreach (var a in scenes)
                foreach (var b in scenes)
                {
                    if (ReferenceEquals(a, b)) continue;
                    double s = Flow.Affinity(a, b);
                    pairs++;
                    if (s >= 0.82) flows++;
                    else if (s >= Flow.BlendFloor) blends++;
                    else if (s >= Flow.CutBelow) shorts++;
                    else cuts++;
                }

            Console.WriteLine($"  {pairs} ordered pairs");
            Console.WriteLine($"    flows (long dissolve or layer)  {flows,5}  {100.0 * flows / pairs,5:0.0}%");
            Console.WriteLine($"    blends                          {blends,5}  {100.0 * blends / pairs,5:0.0}%");
            Console.WriteLine($"    short dissolve                  {shorts,5}  {100.0 * shorts / pairs,5:0.0}%");
            Console.WriteLine($"    hard cut                        {cuts,5}  {100.0 * cuts / pairs,5:0.0}%");
        }

        return 0;
    }

    static int VarietyReport(string[] args)
    {
        int seeds = int.TryParse(args.ElementAtOrDefault(0), out var s) ? s : 8;
        var root = args.ElementAtOrDefault(1) ?? FindProjectsRoot();

        if (!Directory.Exists(root)) { Console.WriteLine($"no projects at {root}"); return 1; }

        var webRoot = FindWebRoot();
        var registry = EffectRegistry.Load(webRoot);
        var director = new Director(registry);
        var sceneKinds = new[] { "scene2d", "scene3d", "raymarch" };
        // Effects that draw one of the project's images are not eligible here: this
        // report plans from analysis.json alone, with no image library, and the
        // director correctly refuses to pick them. Counting them would list two
        // effects as "never picked" forever, which is a diagnostic saying something
        // is wrong about a thing that is right.
        var library = registry.OfKind(sceneKinds)
            .Where(e => !e.UsesImage)
            .Select(e => e.Id).ToHashSet(StringComparer.OrdinalIgnoreCase);

        var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        var sceneUses = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var postUses = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        // How many of the planned videos each effect turns up in at all - the number
        // the "it is in every video" complaint is actually about.
        var sceneVideos = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var openers = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        int totalScenes = 0, videos = 0;
        double distinctShare = 0;
        var cliffEdits = new EditStats();
        var levelEdits = new EditStats();

        Console.WriteLine($"=== Variety over {seeds} seeds ===");
        Console.WriteLine($"library : {library.Count} scene effects, {registry.All.Count} total");
        Console.WriteLine($"projects: {root}\n");

        foreach (var dir in Directory.EnumerateDirectories(root).OrderBy(d => d))
        {
            var file = Path.Combine(dir, "analysis", "analysis.json");
            if (!File.Exists(file)) continue;

            var analysis = JsonSerializer.Deserialize<AudioAnalysis>(File.ReadAllText(file), json);
            if (analysis is null) continue;

            var perProject = new List<string>();
            for (int i = 0; i < seeds; i++)
            {
                // Spread the seeds rather than using 1..n: consecutive seeds are a
                // realistic reroll, but they are not a realistic sample of the space.
                var settings = new ProjectSettings { Seed = 1 + i * 7919, Aspect = "16:9" };
                var sb = director.Build(analysis, settings, null);

                videos++;
                var ids = sb.Scenes.Select(x => x.EffectId).ToArray();
                totalScenes += ids.Length;
                distinctShare += ids.Distinct(StringComparer.OrdinalIgnoreCase).Count() / (double)ids.Length;
                perProject.AddRange(ids);

                Bump(openers, ids[0]);
                foreach (var id in ids) Bump(sceneUses, id);
                foreach (var id in ids.Distinct(StringComparer.OrdinalIgnoreCase)) Bump(sceneVideos, id);
                foreach (var scene in sb.Scenes)
                    foreach (var p in scene.Post) Bump(postUses, p.EffectId);

                // How each boundary was handled, split by whether the frame had to
                // empty out across it. A cut from something full-frame to something
                // sparse is the edit that reads as damage however good the
                // transition is, and this is the only place it is visible: one
                // render shows you a bad cut, it does not show you that a tenth of
                // them are bad.
                for (int b = 1; b < sb.Scenes.Length; b++)
                {
                    var from = registry.Get(sb.Scenes[b - 1].EffectId);
                    var to = registry.Get(sb.Scenes[b].EffectId);
                    if (from is null || to is null) continue;

                    bool cliff = from.Coverage - to.Coverage > 0.22;
                    var bucket = cliff ? cliffEdits : levelEdits;
                    bucket.Count++;

                    if (sb.Scenes[b].Blend is not null) bucket.Blended++;
                    else
                    {
                        double dur = sb.Scenes[b].TransitionDuration;
                        bucket.Duration += dur;
                        if (dur < 0.4) bucket.Snapped++;
                        var t = registry.Get(sb.Scenes[b].TransitionIn);
                        if (t is not null && t.Tags.Contains("wipe")) bucket.Wiped++;
                    }
                }
            }

            Console.WriteLine($"  {Path.GetFileName(dir),-26} {perProject.Count / seeds,3} scenes/plan, " +
                              $"{perProject.Distinct(StringComparer.OrdinalIgnoreCase).Count(),3} distinct across seeds");
        }

        if (videos == 0) { Console.WriteLine("\nno analyses found"); return 1; }

        Console.WriteLine($"\n{videos} plans, {totalScenes} scenes");
        Console.WriteLine($"  distinct effects within one plan : {distinctShare / videos:P0} of its scenes");

        var ranked = sceneUses.OrderByDescending(kv => kv.Value).ToArray();
        double top4 = ranked.Take(4).Sum(kv => kv.Value) / (double)totalScenes;
        Console.WriteLine($"  share carried by the top 4       : {top4:P0}");
        var unused = library.Where(id => !sceneUses.ContainsKey(id)).OrderBy(x => x).ToArray();
        Console.WriteLine($"  scene effects never picked       : {(unused.Length == 0 ? "none" : string.Join(", ", unused))}");

        Console.WriteLine("\n  effect            scenes   share   in plans   opens");
        foreach (var (id, uses) in ranked)
            Console.WriteLine($"  {id,-16} {uses,6} {uses / (double)totalScenes,7:P1} " +
                              $"{sceneVideos.GetValueOrDefault(id) / (double)videos,9:P0} " +
                              $"{openers.GetValueOrDefault(id),7}");

        int totalPost = postUses.Values.Sum();
        Console.WriteLine("\n  post              uses     share");
        foreach (var (id, uses) in postUses.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"  {id,-16} {uses,6} {uses / (double)Math.Max(1, totalPost),7:P1}");

        Console.WriteLine("\n  boundary          count   blended   wiped   under 0.4s   mean cut");
        Report("emptying out", cliffEdits);
        Report("level", levelEdits);

        return 0;

        static void Bump(Dictionary<string, int> d, string k) => d[k] = d.GetValueOrDefault(k) + 1;

        static void Report(string label, EditStats s)
        {
            int cuts = s.Count - s.Blended;
            Console.WriteLine($"  {label,-16} {s.Count,5} {s.Blended / (double)Math.Max(1, s.Count),9:P0} " +
                              $"{s.Wiped / (double)Math.Max(1, cuts),7:P0} " +
                              $"{s.Snapped / (double)Math.Max(1, cuts),12:P0} " +
                              $"{s.Duration / Math.Max(1, cuts),9:F2}s");
        }
    }

    /// Which lyric treatment the director hands each section, across every project
    /// and several seeds.
    ///
    /// The treatments are not interchangeable and the report is here to show that
    /// they are not being handed out as if they were. A cascade steps a word per
    /// beat and wants a grid worth stepping on; a karaoke wipe wants a line long
    /// enough for the wipe to be a wipe. So this prints what the section actually
    /// was - its energy, the song's tempo, the spectral tilt - beside what it got,
    /// and the cue lengths each style ends up carrying. A style whose mean line is
    /// under a second is a style that is being asked to do something it cannot.
    static int LyricReport(string[] args)
    {
        int seeds = int.TryParse(args.ElementAtOrDefault(0), out var s) ? s : 6;
        var root = args.ElementAtOrDefault(1) ?? FindProjectsRoot();
        if (!Directory.Exists(root)) { Console.WriteLine($"no projects at {root}"); return 1; }

        var director = new Director(EffectRegistry.Load(FindWebRoot()));
        var json = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

        var uses = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
        var seconds = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        var shortest = new Dictionary<string, double>(StringComparer.OrdinalIgnoreCase);
        int plans = 0, cues = 0;

        Console.WriteLine($"=== Lyric treatments over {seeds} seeds ===\n");

        foreach (var dir in Directory.EnumerateDirectories(root).OrderBy(d => d))
        {
            var file = Path.Combine(dir, "analysis", "analysis.json");
            if (!File.Exists(file)) continue;

            var analysis = JsonSerializer.Deserialize<AudioAnalysis>(File.ReadAllText(file), json);
            if (analysis is null || analysis.Lyrics.Length == 0) continue;

            var perProject = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            for (int i = 0; i < seeds; i++)
            {
                var sb = director.Build(analysis, new ProjectSettings { Seed = 1 + i * 7919, Aspect = "16:9" }, null);
                plans++;
                foreach (var cue in sb.Texts)
                {
                    cues++;
                    Bump(uses, cue.Style);
                    Bump(perProject, cue.Style);
                    double len = cue.End - cue.Start;
                    seconds[cue.Style] = seconds.GetValueOrDefault(cue.Style) + len;
                    shortest[cue.Style] = Math.Min(shortest.GetValueOrDefault(cue.Style, double.MaxValue), len);
                }
            }

            var mix = perProject.OrderByDescending(kv => kv.Value)
                                .Select(kv => $"{kv.Key} {kv.Value / seeds}");
            Console.WriteLine($"  {Path.GetFileName(dir),-26} {analysis.Bpm,5:F0} bpm  " +
                              $"grid {(analysis.BeatGridReliable ? "ok " : "weak")}  " +
                              $"{string.Join(", ", mix)}");
        }

        if (cues == 0) { Console.WriteLine("\nno analysed project has lyrics"); return 1; }

        Console.WriteLine($"\n{plans} plans, {cues} lyric cues\n");
        Console.WriteLine("  style        cues    share   mean line   shortest");
        foreach (var (style, n) in uses.OrderByDescending(kv => kv.Value))
            Console.WriteLine($"  {style,-11} {n,5} {n / (double)cues,8:P1} " +
                              $"{seconds[style] / n,10:F2}s {shortest[style],10:F2}s");

        return 0;

        static void Bump(Dictionary<string, int> d, string k) => d[k] = d.GetValueOrDefault(k) + 1;
    }

    /// How one class of scene boundary got edited, across every plan.
    sealed class EditStats
    {
        public int Count, Blended, Wiped, Snapped;
        public double Duration;
    }

    /// Both roots are found the same way the app finds them: walk up for the solution.
    static string FindProjectsRoot() => Path.Combine(SolutionDir(), "projects");
    static string FindWebRoot() => Path.Combine(SolutionDir(), "src", "Imagine3D.Web");

    static string SolutionDir()
    {
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
                if (File.Exists(Path.Combine(dir.FullName, "Imagine3D.slnx")))
                    return dir.FullName;
        }
        return Directory.GetCurrentDirectory();
    }

    static int UnitTests()
    {
        int fail = 0;
        Console.WriteLine("=== Unit tests ===");

        // FFT of a pure tone must put its energy in the matching bin.
        {
            const int n = 1024, binWanted = 64;
            var re = new float[n];
            var im = new float[n];
            for (int i = 0; i < n; i++) re[i] = MathF.Sin(2 * MathF.PI * binWanted * i / n);
            Fft.Forward(re, im);
            int peak = 1;
            for (int b = 1; b < n / 2; b++)
                if (re[b] * re[b] + im[b] * im[b] > re[peak] * re[peak] + im[peak] * im[peak]) peak = b;
            fail += Check("FFT locates a pure tone", peak == binWanted, $"peak bin {peak}, wanted {binWanted}");
        }

        // A synthetic click track at a known tempo must be recovered.
        {
            const int rate = 22050;
            const double bpm = 128, seconds = 30;
            var sig = new float[(int)(rate * seconds)];
            double period = 60.0 / bpm;
            for (double t = 0; t < seconds; t += period)
            {
                int s = (int)(t * rate);
                for (int i = 0; i < 400 && s + i < sig.Length; i++)
                    sig[s + i] = MathF.Sin(2 * MathF.PI * 1200 * i / rate) * MathF.Exp(-i / 60f);
            }
            var spec = new Spectrogram(sig, rate);
            var env = OnsetEnvelope.Compute(spec);
            var tempo = TempoEstimator.Estimate(env, spec.FrameRate);
            fail += Check($"Tempo of a {bpm} BPM click track",
                Math.Abs(tempo.Bpm - bpm) < 2.0, $"got {tempo.Bpm:F2} BPM");

            var beats = BeatTracker.Track(env, spec.FrameRate, tempo.Bpm, spec.EventTimeOffset);
            int expected = (int)(seconds / period);
            fail += Check("Beat count on click track",
                Math.Abs(beats.Length - expected) <= 2, $"got {beats.Length}, expected ~{expected}");

            // Every tracked beat should sit close to a real click.
            double worst = 0;
            foreach (var b in beats)
            {
                double nearest = Math.Round(b / period) * period;
                worst = Math.Max(worst, Math.Abs(b - nearest));
            }
            fail += Check("Beat grid phase accuracy", worst < 0.06, $"worst offset {worst * 1000:F0}ms");
        }

        // Style:/Negative: must be lifted out of the lyric body.
        {
            var s = SongText.Parse("Style: burning, fast\nAvoid: text\nDo you feel it\n[drop]");
            fail += Check("SongText extracts directives",
                s.Style == "burning, fast" && s.Negative == "text" &&
                s.Lyrics == "Do you feel it\n[drop]", $"got style='{s.Style}' neg='{s.Negative}'");
        }

        // Lyric alignment must stay inside the song and stay ordered.
        {
            var sections = new[]
            {
                new Section(0, 0, 30, "A", 0.4, 1, [], []),
                new Section(1, 30, 60, "B", 0.8, 0.7, [], []),
            };
            var song = SongText.Parse("[intro]\nline one\nline two\n[drop]\nline three");
            var lines = LyricAligner.Align(song, sections);
            bool ordered = lines.Zip(lines.Skip(1), (x, y) => y.Start >= x.Start).All(b => b);
            bool inRange = lines.All(l => l.Start >= 0 && l.End <= 60.001);
            fail += Check("Lyric alignment ordered and in range",
                lines.Length == 5 && ordered && inRange, $"got {lines.Length} lines");
        }

        // Generate renders the storyboard the user reviewed, so the rule that decides
        // when a plan is thrown away and re-planned has to be narrow: only things that
        // move the scenes, never a setting the director never saw.
        {
            var analysis = Silence(180);
            var settings = new ProjectSettings
            {
                Aspect = "16:9", Fps = 30, Seed = 7, RandomSeedEachRun = false,
            };
            var plan = PlanOf(seed: 7, aspect: "16:9", fps: 30, duration: 180);

            fail += Check("A plan of this song at these settings is reused",
                plan.StaleBecause(settings, analysis) is null,
                plan.StaleBecause(settings, analysis) ?? "");

            fail += Check("Re-planned when the video changes shape",
                plan.StaleBecause(new ProjectSettings
                {
                    Aspect = "9:16", Fps = 30, Seed = 7, RandomSeedEachRun = false,
                }, analysis) is not null, "9:16 reused a 16:9 plan");

            fail += Check("Re-planned when the frame rate changes",
                plan.StaleBecause(new ProjectSettings
                {
                    Aspect = "16:9", Fps = 60, Seed = 7, RandomSeedEachRun = false,
                }, analysis) is not null, "60 fps reused a 30 fps plan");

            fail += Check("Re-planned when the song is a different length",
                plan.StaleBecause(settings, Silence(240)) is not null,
                "a 180s plan was reused for a 240s song");

            // A seed typed by hand is a request; one rolled fresh at every plan is not
            // something the plan on disk can disagree with.
            fail += Check("Re-planned for a seed asked for by hand",
                plan.StaleBecause(new ProjectSettings
                {
                    Aspect = "16:9", Fps = 30, Seed = 99, RandomSeedEachRun = false,
                }, analysis) is not null, "seed 99 rendered seed 7's plan");

            fail += Check("Not re-planned for the rolling seed",
                plan.StaleBecause(new ProjectSettings
                {
                    Aspect = "16:9", Fps = 30, Seed = 99, RandomSeedEachRun = true,
                }, analysis) is null, "the plan on screen was replaced by a new roll");

            // Encoding settings live downstream of the director. Re-planning for one
            // is exactly the bug this rule exists to prevent.
            fail += Check("Not re-planned for a setting the director never saw",
                plan.StaleBecause(new ProjectSettings
                {
                    Aspect = "16:9", Fps = 30, Seed = 7, RandomSeedEachRun = false,
                    Encoder = "h264_nvenc", Crf = 24, SaveTrimmedCopy = true,
                }, analysis) is null, "a re-encode setting threw away the plan");
        }

        // No effect may drive a *rate* from an impulse source.
        //
        // beatPulse, onset and the per-band hits are spikes: they jump and decay
        // within a few frames, which is exactly what a brightness or a scale
        // wants and exactly what a speed cannot have. Effects animate as
        // `uTime * p_speed`, so a spike in the speed is not a surge, it is a
        // jump in *position* the size of uTime - and the picture stops being
        // fast and starts being random. Six manifests had one and they were the
        // effects that read as obnoxious.
        //
        // The fix in every case was the same: swap the impulse for its level or
        // shape sibling (midHit -> midRel), which still follows the same part of
        // the mix without spiking. Put the impulse on something the effect can
        // move instantly instead - see tunnel's wall pump.
        {
            var impulse = new Regex(@"\b(beatPulse|barPulse|onset|\w*Hit)\b", RegexOptions.IgnoreCase);
            var rate = new Regex(
                @"^(speed|travel|flow|spin|rate|drift|orbit|walk|scroll|swirl|churn|cycle|advance|climb|roll|turn)$",
                RegexOptions.IgnoreCase);

            // Named like a rate, used as a distance. inkbloom spends p_flow on
            // `uv + (noise - 0.5) * p_flow`, which is how far the bleed reaches
            // and not how fast it travels, so a spike in it is a spike in the
            // spread - instant, bounded, and exactly what the impulse is for.
            // The check is on the name because nothing here can read GLSL; this
            // is the one place where the name and the use disagree.
            string[] exempt = ["inkbloom.flow"];

            var offenders = new List<string>();
            foreach (var e in EffectRegistry.Load(FindWebRoot()).All)
                foreach (var (key, spec) in e.Params)
                    if (rate.IsMatch(key) && impulse.IsMatch(spec.Default ?? "") &&
                        !exempt.Contains($"{e.Id}.{key}", StringComparer.OrdinalIgnoreCase))
                        offenders.Add($"{e.Id}.{key} = {spec.Default}");

            fail += Check("No effect drives a rate from an impulse source",
                offenders.Count == 0, string.Join("; ", offenders));
        }

        return fail;
    }

    /// The least analysis that is still a song of a given length - enough for the
    /// rules that only care about how long it is.
    static AudioAnalysis Silence(double seconds) => new(
        Duration: seconds, SampleRate: 44100, FrameRate: 100,
        Bpm: 120, BpmConfidence: 1, BpmAlternate: 60, BpmPinned: true,
        Beats: [], Downbeats: [], Onsets: [],
        Sections: [new Section(0, 0, seconds, "A", 0.5, 1, [], [])],
        Lyrics: [], BandNames: [], Rms: [], Bands: [], Onset: []);

    /// A one-scene plan, standing in for whatever the director would have produced.
    static Storyboard PlanOf(int seed, string aspect, int fps, double duration) => new(
        Version: Storyboard.CurrentVersion, Seed: seed, Aspect: aspect, Fps: fps,
        Duration: duration, Mood: "", Palette: "neon", Notes: "",
        Scenes: [new StoryScene(0, 0, duration, "starnest", [], [], "cut", 0.5, "A", 0.5, "test")],
        Texts: [], Ltx: []);

    static int Check(string name, bool ok, string detail)
    {
        Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(ok ? "" : $"  -- {detail}")}");
        return ok ? 0 : 1;
    }

    static string Bar(double v) => new('#', (int)Math.Round(Math.Clamp(v, 0, 1) * 40));

    static string Trunc(string s, int n) =>
        s.Length <= n ? s : s[..Math.Max(0, n - 1)] + "\u2026";
}
