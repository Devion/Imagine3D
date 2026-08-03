using System.Diagnostics;
using Imagine3D.Audio;
using Imagine3D.Lyrics;

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

        return failures;
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

        return fail;
    }

    static int Check(string name, bool ok, string detail)
    {
        Console.WriteLine($"  {(ok ? "PASS" : "FAIL")}  {name}{(ok ? "" : $"  -- {detail}")}");
        return ok ? 0 : 1;
    }

    static string Bar(double v) => new('#', (int)Math.Round(Math.Clamp(v, 0, 1) * 40));

    static string Trunc(string s, int n) =>
        s.Length <= n ? s : s[..Math.Max(0, n - 1)] + "\u2026";
}
