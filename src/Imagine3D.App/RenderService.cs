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

        // Every run is identified so the page's replies can be attributed. Without
        // it a leftover "ready" from an earlier run is indistinguishable from this
        // one's, and the frame loop starts while the page is still loading - which
        // shows up as the page drawing with no storyboard.
        var runId = Guid.NewGuid().ToString("N")[..8];

        progress.Report(new StageProgress(PipelineStage.Render, 0,
            $"Preparing page - {renderW}x{renderH} -> {outW}x{outH} @ {fps}fps, {total} frames"));

        // Nothing the page sent before this point can be an answer to anything we
        // are about to ask.
        int stale = channel.Drain();
        if (stale > 0)
            progress.Report(new StageProgress(PipelineStage.Render, 0,
                $"Discarded {stale} stale message(s) left over from an earlier run"));

        await channel.SendJsonAsync(new
        {
            cmd = "renderBegin",
            runId,
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
        await WaitForReadyAsync(channel, runId, ct);

        using var pipe = new FramePipe(
            ffmpeg, outPath, renderW, renderH, outW, outH, fps, mp3,
            settings.Encoder, settings.Crf);

        var sw = Stopwatch.StartNew();
        int thumbEvery = Math.Max(1, fps * 2); // one preview per ~2s of video
        string? lastThumb = null;

        for (int n = 0; n < total; n++)
        {
            ct.ThrowIfCancellationRequested();

            await channel.SendJsonAsync(
                new { cmd = "frame", runId, n, thumb = n % thumbEvery == 0 }, ct);

            var rgba = await channel.ReadBinaryAsync(FrameTimeout, runId,
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

        await channel.SendJsonAsync(new { cmd = "renderEnd", runId }, ct);

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

    /// Wait for the page to report that it has *this* run's storyboard loaded and
    /// can draw. Anything else on the wire - a frame from an interrupted run, a
    /// late thumbnail, a ready meant for a run that no longer exists - is skipped
    /// rather than mistaken for the answer.
    static async Task WaitForReadyAsync(RenderChannel channel, string runId, CancellationToken ct)
    {
        var deadline = DateTime.UtcNow + SetupTimeout;
        while (true)
        {
            var remaining = deadline - DateTime.UtcNow;
            if (remaining <= TimeSpan.Zero)
                throw new TimeoutException(
                    $"The render page did not become ready within {SetupTimeout.TotalSeconds:F0}s. " +
                    "It most likely threw while loading the storyboard - check the devtools console.");

            var msg = await channel.ReadAsync(remaining, ct);
            if (msg.IsBinary) continue;

            var type = RenderChannel.Peek(msg.Text, "type");
            var owner = RenderChannel.Peek(msg.Text, "runId");

            if (type == "error" && (owner is null || owner == runId))
                throw new Exception("Render page failed to initialise: " +
                    (RenderChannel.Peek(msg.Text, "message") ?? Trunc(msg.Text, 400)));

            // An untagged ready can only come from a page old enough to predate
            // run ids, and such a page cannot also be sending tagged ones.
            if (type == "ready" && (owner is null || owner == runId)) return;
        }
    }

    /// The shortened upload copy. Returns a fragment for the progress line.
    ///
    /// The work itself lives in VideoTrimmer, shared with the panel's on-demand
    /// button; only the failure policy differs here - the copy is a convenience,
    /// and losing it must never fail a render that has already finished.
    string WriteTrimmedCopy(
        string source, ProjectPaths paths, ProjectSettings settings,
        double duration, IProgress<StageProgress> progress)
    {
        try
        {
            var r = new VideoTrimmer(ffmpeg).Run(source, paths, settings, duration, progress);
            return r.Wrote ? $"  (+ {r.Summary})" : $"  ({r.Summary})";
        }
        catch (Exception e)
        {
            progress.Report(new StageProgress(PipelineStage.Encode, 0.95,
                $"Trimmed copy failed: {e.Message}"));
            return $"  (trimmed copy failed: {Trunc(e.Message, 70)})";
        }
    }

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
