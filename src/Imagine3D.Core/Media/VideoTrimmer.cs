using Imagine3D.Pipeline;
using Imagine3D.Projects;

namespace Imagine3D.Media;

/// Writes the shortened upload copy that sits next to the full render.
///
/// Two callers share this: the tail of a render, and the panel's "Make shortened
/// copy" button for when the checkbox was forgotten. Keeping the naming, the size
/// arithmetic and the definition of "nothing to do" in one place is the point -
/// a second implementation would drift and start producing a differently named
/// file for the same settings.
public sealed class VideoTrimmer(Ffmpeg ffmpeg)
{
    /// Standalone: the full MP4 is already on disk. Its duration comes from the
    /// file itself, since there is no storyboard in hand to ask.
    public TrimResult Run(
        ProjectPaths paths, ProjectSettings settings, IProgress<StageProgress> progress)
    {
        var source = paths.OutputVideo(settings);
        if (!File.Exists(source))
            throw new FileNotFoundException(
                $"No rendered video to shorten - expected {Path.GetFileName(source)} in the " +
                "output folder. Render first, or check that the aspect ratio still matches " +
                "the one it was rendered at.", source);

        progress.Report(new StageProgress(PipelineStage.Encode, 0.1,
            $"Reading {Path.GetFileName(source)}"));

        return Run(source, paths, settings, ffmpeg.GetDuration(source), progress);
    }

    /// From the render, where the duration is already known exactly.
    public TrimResult Run(
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
            return new TrimResult(null,
                $"already under {settings.TrimMinutes:0.##} min, no copy needed");

        // A stream copy is instant and lossless, so use it whenever the result
        // would already sit under the ceiling - re-encoding to reach a size you
        // are already below only loses quality.
        long fullBytes = new FileInfo(source).Length;
        double copyMb = fullBytes / (1024.0 * 1024.0) * (clipSeconds / Math.Max(0.001, duration));

        if (target <= 0 || copyMb <= target)
        {
            if (!needsTrim)
                return new TrimResult(null,
                    $"already under {settings.TrimMinutes:0.##} min and {target:0} MB, no copy needed");

            progress.Report(new StageProgress(PipelineStage.Encode, 0.9,
                $"Copying a {settings.TrimMinutes:0.##} minute cut"));
            ffmpeg.TrimCopy(source, trimmed, clipSeconds);
            return new TrimResult(trimmed,
                $"{Path.GetFileName(trimmed)} - {Mb(trimmed):F0} MB, stream copy");
        }

        progress.Report(new StageProgress(PipelineStage.Encode, 0.9,
            $"Re-encoding a {settings.TrimMinutes:0.##} minute copy to fit {target:0} MB " +
            $"(two-pass, ~{clipSeconds / 60:0.#} min of video)"));

        int kbps = ffmpeg.TrimToSize(source, trimmed, clipSeconds, target);
        double actual = Mb(trimmed);
        // Two-pass lands within a fraction of a percent, so a few tens of KB over
        // is normal and reporting it as "OVER by 0 MB" only looks like a bug.
        var verdict = actual <= target + 0.1 ? "" : $" - OVER by {actual - target:F1} MB";
        return new TrimResult(trimmed,
            $"{Path.GetFileName(trimmed)} - {actual:F0} MB at {kbps} kbps{verdict}");
    }

    static double Mb(string path) => new FileInfo(path).Length / (1024.0 * 1024.0);
}

/// `Path` is null when the settings asked for nothing the full render does not
/// already satisfy; `Summary` explains either outcome in one line.
public sealed record TrimResult(string? Path, string Summary)
{
    public bool Wrote => Path is not null;
}
