using System.Diagnostics;
using System.Globalization;
using System.Text.RegularExpressions;

namespace Imagine3D.Media;

/// ffmpeg wrapper. Location logic is ported from Mp3ToVid (this machine has no
/// standalone ffprobe, so duration comes from parsing ffmpeg's own stderr).
public sealed partial class Ffmpeg
{
    readonly string _exe;

    public string ExePath => _exe;

    public Ffmpeg(string? explicitPath = null)
    {
        _exe = explicitPath ?? Locate() ?? throw new FileNotFoundException(
            "ffmpeg not found. Set it explicitly in settings. (ComfyUI bundles one under " +
            "python_embeded/Lib/site-packages/imageio_ffmpeg/binaries/)");
    }

    public static string? Locate()
    {
        string[] roots =
        [
            @"D:\AI\ComfyUI\python_embeded\Lib\site-packages\imageio_ffmpeg\binaries",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                @"LTXDesktop\python\Lib\site-packages\imageio_ffmpeg\binaries"),
        ];
        foreach (var r in roots)
            if (Directory.Exists(r))
                foreach (var f in Directory.GetFiles(r, "ffmpeg*.exe"))
                    return f;
        return "ffmpeg"; // fall back to PATH; surfaces a clear error if absent
    }

    [GeneratedRegex(@"Duration:\s*(\d+):(\d+):(\d+\.\d+)")]
    private static partial Regex DurationRe();

    public double GetDuration(string file)
    {
        var (_, err) = Exec($"-i \"{file}\"", allowFail: true);
        var m = DurationRe().Match(err);
        if (!m.Success) throw new Exception($"could not read duration of {file}");
        return int.Parse(m.Groups[1].Value) * 3600
             + int.Parse(m.Groups[2].Value) * 60
             + double.Parse(m.Groups[3].Value, CultureInfo.InvariantCulture);
    }

    public void ExtractFrame(string video, double atSeconds, string outPng)
    {
        Exec($"-y -ss {atSeconds.ToString("0.###", CultureInfo.InvariantCulture)} -i \"{video}\" " +
             $"-update 1 -frames:v 1 \"{outPng}\"");
    }

    /// Write a video's final frame to a PNG.
    ///
    /// `-update 1` makes every decoded frame overwrite the same file, so seeking
    /// to a second before the end and letting it run to the end leaves the last
    /// frame behind. The obvious alternative - `-vf reverse -frames:v 1` - buffers
    /// the whole clip in memory to do the same job.
    public void ExtractLastFrame(string video, string outPng) =>
        Exec($"-y -hide_banner -loglevel error -sseof -1 -i \"{video}\" -update 1 \"{outPng}\"");

    /// Join clips end to end into one file at a fixed frame rate.
    ///
    /// Re-encoded rather than stream-copied, which is the whole reason this is
    /// here: the renderer drives the clip by setting `currentTime` one frame at a
    /// time, so `t - insert.start` has to land on the frame it names. A copy keeps
    /// whatever timestamps LTX wrote and leaves a keyframe only at each clip's
    /// start, and every seek in between then costs a decode from there. A short
    /// GOP is cheap here - the source is half-size - and it is what makes seeking
    /// through a minute-long run as quick as through a five second one.
    public void Concat(IReadOnlyList<string> parts, string dst, int fps)
    {
        if (parts.Count == 0) throw new ArgumentException("nothing to concatenate", nameof(parts));

        var listFile = Path.Combine(Path.GetTempPath(), $"i3d_concat_{Guid.NewGuid():N}.txt");
        // The concat demuxer's own quoting: forward slashes, and ' closed and
        // reopened around any literal quote in the path.
        File.WriteAllLines(listFile, parts.Select(p =>
            $"file '{p.Replace('\\', '/').Replace("'", @"'\''")}'"));

        try
        {
            // -an drops the audio LTX synthesises for every clip; the original MP3
            // is muxed over the finished video and this track is never heard.
            Exec($"-y -hide_banner -loglevel error -f concat -safe 0 -i \"{listFile}\" " +
                 $"-an -r {fps} -c:v libx264 -preset veryfast -crf 16 -pix_fmt yuv420p " +
                 $"-g {Math.Max(2, fps / 2)} -movflags +faststart \"{dst}\"");
        }
        finally
        {
            try { File.Delete(listFile); } catch { /* best effort */ }
        }
    }

    /// Scale to cover then centre-crop, so an image is never stretched out of shape.
    public void FitImage(string src, string outPng, int w, int h)
    {
        Exec($"-y -i \"{src}\" -vf \"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}\" " +
             $"-update 1 -frames:v 1 \"{outPng}\"");
    }

    /// Write the first `seconds` of a video to a new file.
    ///
    /// Stream copy, so it is near-instant and lossless. Trimming from the start
    /// means no keyframe hunting is needed - `-t` alone gives a clean cut, and
    /// re-encoding a five-minute 1080p file to shorten it would be wasteful.
    public void TrimCopy(string src, string dst, double seconds)
    {
        var t = seconds.ToString("0.###", CultureInfo.InvariantCulture);
        Exec($"-y -hide_banner -loglevel error -i \"{src}\" -t {t} " +
             $"-c copy -movflags +faststart \"{dst}\"");
    }

    /// Trim to `seconds` AND re-encode to land under `targetMb`.
    ///
    /// A stream copy inherits the source bitrate, so hitting a size target means
    /// re-encoding. Two-pass is used rather than single-pass ABR because the
    /// point of this is an upload limit: x264 given a full first-pass analysis
    /// lands within a percent or two of the requested size, where single-pass
    /// routinely overshoots on content whose complexity varies as much as a
    /// demo's does.
    ///
    /// Returns the video bitrate it chose, in kbps.
    public int TrimToSize(
        string src, string dst, double seconds, double targetMb, int audioKbps = 192)
    {
        // MiB -> kbit/s. 1 MiB = 8388.608 kbit, and 3% is left for container
        // overhead so the muxed result stays under the limit rather than on it.
        double totalKbps = targetMb * 8388.608 / Math.Max(1.0, seconds);
        int videoKbps = (int)Math.Floor(totalKbps * 0.97) - audioKbps;

        if (videoKbps < 250)
            throw new InvalidOperationException(
                $"{targetMb:0.#} MB over {seconds:0}s leaves only {videoKbps} kbps for video. " +
                "Shorten the clip or raise the size limit.");

        var t = seconds.ToString("0.###", CultureInfo.InvariantCulture);
        // Pass logs go to temp, not the working directory.
        var passLog = Path.Combine(Path.GetTempPath(), $"i3d_2pass_{Guid.NewGuid():N}");
        var common = $"-y -hide_banner -loglevel error -i \"{src}\" -t {t} " +
                     $"-c:v libx264 -preset medium -b:v {videoKbps}k " +
                     $"-passlogfile \"{passLog}\"";

        try
        {
            // Pass 1 analyses only; its output is discarded.
            Exec($"{common} -pass 1 -an -f mp4 NUL");
            Exec($"{common} -pass 2 -c:a aac -b:a {audioKbps}k " +
                 $"-pix_fmt yuv420p -movflags +faststart \"{dst}\"");
        }
        finally
        {
            foreach (var leftover in Directory.EnumerateFiles(
                         Path.GetTempPath(), Path.GetFileName(passLog) + "*"))
                try { File.Delete(leftover); } catch { /* best effort */ }
        }

        return videoKbps;
    }

    /// Extract the audio window an LTX clip should be conditioned on.
    public void ExtractAudioSegment(string mp3, double start, double duration, string outWav)
    {
        var s = start.ToString("0.###", CultureInfo.InvariantCulture);
        var d = duration.ToString("0.###", CultureInfo.InvariantCulture);
        Exec($"-y -ss {s} -t {d} -i \"{mp3}\" -ac 1 -ar 44100 \"{outWav}\"");
    }

    public (string outStd, string outErr) Exec(string args, bool allowFail = false)
    {
        var psi = new ProcessStartInfo(_exe, args)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        using var p = Process.Start(psi)!;
        p.StandardInput.Close(); // ffmpeg reads stdin interactively; give it EOF

        // Read both pipes concurrently, else a full stderr buffer deadlocks stdout.
        var soTask = p.StandardOutput.ReadToEndAsync();
        var seTask = p.StandardError.ReadToEndAsync();
        Task.WaitAll(soTask, seTask);
        p.WaitForExit();

        string so = soTask.Result, se = seTask.Result;
        if (p.ExitCode != 0 && !allowFail)
            throw new Exception($"ffmpeg failed ({p.ExitCode}):\n{se[^Math.Min(se.Length, 2000)..]}");
        return (so, se);
    }
}
