using System.Diagnostics;
using Imagine3D.Direct;
using Imagine3D.Media;
using Imagine3D.Pipeline;
using Imagine3D.Projects;

namespace Imagine3D.App;

/// Drives the browser through an offline, frame-exact render and pipes the result
/// into ffmpeg. Owns the lockstep loop; the page owns the drawing.
public sealed class RenderService(Ffmpeg ffmpeg)
{
    /// Generous: a heavy raymarched frame at 4K supersample can legitimately take
    /// many seconds, and stalling here would kill an otherwise fine render.
    static readonly TimeSpan FrameTimeout = TimeSpan.FromSeconds(120);
    static readonly TimeSpan SetupTimeout = TimeSpan.FromSeconds(180);

    public async Task<string> RenderAsync(
        RenderChannel channel,
        ProjectPaths paths,
        ProjectSettings settings,
        Storyboard storyboard,
        IProgress<StageProgress> progress,
        CancellationToken ct)
    {
        var (outW, outH) = settings.Resolution;
        var (renderW, renderH) = settings.RenderResolution;
        int fps = settings.Fps;
        int total = Math.Max(1, storyboard.TotalFrames);

        var mp3 = paths.FindMp3()
            ?? throw new InvalidOperationException("Project has no source MP3 to mux.");
        var outPath = paths.OutputVideo(settings);

        progress.Report(new StageProgress(PipelineStage.Render, 0,
            $"Preparing page - {renderW}x{renderH} -> {outW}x{outH} @ {fps}fps, {total} frames"));

        await channel.SendJsonAsync(new
        {
            cmd = "renderBegin",
            project = paths.Name,
            width = renderW,
            height = renderH,
            fps,
            totalFrames = total,
            aspect = settings.Aspect,
            seed = settings.Seed,
        }, ct);

        // The page fetches analysis.json and storyboard.json over HTTP itself -
        // they are megabytes of arrays and have no business going through the
        // control socket.
        var ready = await channel.ReadAsync(SetupTimeout, ct);
        if (ready.IsBinary || !ready.Text.Contains("\"ready\""))
            throw new Exception($"Render page failed to initialise: {Trunc(ready.Text, 400)}");

        using var pipe = new FramePipe(
            ffmpeg, outPath, renderW, renderH, outW, outH, fps, mp3,
            settings.Encoder, settings.Crf);

        var sw = Stopwatch.StartNew();
        int thumbEvery = Math.Max(1, fps * 2); // one preview per ~2s of video
        string? lastThumb = null;

        for (int n = 0; n < total; n++)
        {
            ct.ThrowIfCancellationRequested();

            await channel.SendJsonAsync(new { cmd = "frame", n, thumb = n % thumbEvery == 0 }, ct);

            var rgba = await channel.ReadBinaryAsync(FrameTimeout,
                onText: text =>
                {
                    var t = ExtractThumb(text);
                    if (t is not null) lastThumb = t;
                }, ct);

            await pipe.WriteFrameAsync(rgba, ct);

            if (n % 10 == 0 || n == total - 1)
            {
                double done = (n + 1) / (double)total;
                double rate = (n + 1) / Math.Max(0.001, sw.Elapsed.TotalSeconds);
                var eta = TimeSpan.FromSeconds((total - n - 1) / Math.Max(0.01, rate));
                progress.Report(new StageProgress(PipelineStage.Render, done,
                    $"frame {n + 1}/{total} - {rate:F1} fps - ETA {Format(eta)}", lastThumb));
            }
        }

        await channel.SendJsonAsync(new { cmd = "renderEnd" }, ct);

        progress.Report(new StageProgress(PipelineStage.Encode, 0.5,
            $"Encoding {outW}x{outH} and muxing audio"));

        var result = await pipe.FinishAsync();

        var size = new FileInfo(result).Length / (1024.0 * 1024.0);
        var detail = $"{Path.GetFileName(result)} - {size:F1} MB in {Format(sw.Elapsed)}";

        // Optional shortened copy alongside the full render.
        if (settings.SaveTrimmedCopy)
            detail += WriteTrimmedCopy(result, paths, settings, storyboard.Duration, progress);

        progress.Report(new StageProgress(PipelineStage.Encode, 1.0, detail));

        return result;
    }

    /// The shortened upload copy. Returns a fragment for the progress line.
    string WriteTrimmedCopy(
        string source, ProjectPaths paths, ProjectSettings settings,
        double duration, IProgress<StageProgress> progress)
    {
        double limit = settings.TrimMinutes * 60;
        double clipSeconds = Math.Min(duration, limit);
        bool needsTrim = duration > limit + 0.5;

        var target = settings.TrimTargetMb;
        var trimmed = paths.OutputVideoTrimmed(settings);

        // Nothing to do: short enough already and no size ceiling asked for.
        if (!needsTrim && target <= 0)
            return $"  (already under {settings.TrimMinutes:0.##} min, no copy needed)";

        // A stream copy is instant and lossless, so use it whenever the result
        // would already sit under the ceiling - re-encoding to reach a size you
        // are already below only loses quality.
        long fullBytes = new FileInfo(source).Length;
        double copyMb = fullBytes / (1024.0 * 1024.0) * (clipSeconds / Math.Max(0.001, duration));

        if (target <= 0 || copyMb <= target)
        {
            if (!needsTrim) return $"  (already under {settings.TrimMinutes:0.##} min and {target:0} MB)";
            progress.Report(new StageProgress(PipelineStage.Encode, 0.9,
                $"Copying a {settings.TrimMinutes:0.##} minute cut"));
            ffmpeg.TrimCopy(source, trimmed, clipSeconds);
            return $"  (+ {Path.GetFileName(trimmed)}, {Mb(trimmed):F0} MB, stream copy)";
        }

        progress.Report(new StageProgress(PipelineStage.Encode, 0.9,
            $"Re-encoding a {settings.TrimMinutes:0.##} minute copy to fit {target:0} MB " +
            $"(two-pass, ~{clipSeconds / 60:0.#} min of video)"));

        try
        {
            int kbps = ffmpeg.TrimToSize(source, trimmed, clipSeconds, target);
            double actual = Mb(trimmed);
            var verdict = actual <= target ? "" : $" - OVER by {actual - target:F0} MB";
            return $"  (+ {Path.GetFileName(trimmed)}, {actual:F0} MB at {kbps} kbps{verdict})";
        }
        catch (Exception e)
        {
            // The copy is a convenience; losing it must not fail a finished render.
            progress.Report(new StageProgress(PipelineStage.Encode, 0.95,
                $"Trimmed copy failed: {e.Message}"));
            return $"  (trimmed copy failed: {Trunc(e.Message, 70)})";
        }
    }

    static double Mb(string path) => new FileInfo(path).Length / (1024.0 * 1024.0);

    static string? ExtractThumb(string text)
    {
        // Cheap sniff - the thumbnail is the only message carrying a data URL and
        // parsing a multi-hundred-KB JSON document per frame would be wasteful.
        const string key = "\"data\":\"";
        if (!text.Contains("\"thumb\"")) return null;
        int i = text.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return null;
        int start = i + key.Length;
        int end = text.IndexOf('"', start);
        return end > start ? text[start..end] : null;
    }

    static string Format(TimeSpan t) =>
        t.TotalHours >= 1 ? $"{(int)t.TotalHours}h{t.Minutes:D2}m"
        : t.TotalMinutes >= 1 ? $"{t.Minutes}m{t.Seconds:D2}s"
        : $"{t.Seconds}s";

    static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "...";
}
