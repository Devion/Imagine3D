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

    /// Scale to cover then centre-crop, so an image is never stretched out of shape.
    public void FitImage(string src, string outPng, int w, int h)
    {
        Exec($"-y -i \"{src}\" -vf \"scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h}\" " +
             $"-update 1 -frames:v 1 \"{outPng}\"");
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
