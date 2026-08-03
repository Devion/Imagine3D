using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Imagine3D.Audio;
using Imagine3D.Lyrics;
using Imagine3D.Projects;

namespace Imagine3D.Direct;

/// Asks the local claude/codex CLI what the song is *about*, and gets back tags and
/// mood - never effect ids. Keeping the LLM on the intent side means the registry
/// stays the only thing that knows what effects exist, and a hallucinated name
/// can't break a render.
///
/// The subprocess plumbing (both-streams capture, transient-error backoff) is
/// ported from Mp3ToVid, where it was already hardened against 529s.
public static class IntentPlanner
{
    const int MaxAttempts = 4;

    public static async Task<Intent> PlanAsync(
        ProjectPaths paths, AudioAnalysis analysis, CancellationToken ct, string llm = "claude")
    {
        var txt = paths.FindTxt();
        var song = SongText.Parse(txt is not null ? File.ReadAllText(txt) : null);

        var prompt = BuildPrompt(analysis, song);
        var raw = await RunCliAsync(llm, prompt, ct);
        var json = ExtractJson(raw);

        var opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            AllowTrailingCommas = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
        };

        var intent = JsonSerializer.Deserialize<Intent>(json, opts)
            ?? throw new Exception("LLM returned no usable intent");

        intent = intent with
        {
            Mood = intent.Mood ?? "",
            Palette = intent.Palette ?? "",
            Story = intent.Story ?? "",
            GlobalTags = intent.GlobalTags ?? [],
            Sections = intent.Sections ?? [],
        };

        Directory.CreateDirectory(Path.GetDirectoryName(paths.IntentFile)!);
        File.WriteAllText(paths.IntentFile,
            JsonSerializer.Serialize(intent, new JsonSerializerOptions { WriteIndented = true }));

        return intent;
    }

    static string BuildPrompt(AudioAnalysis a, SongText song)
    {
        var sb = new StringBuilder();
        foreach (var s in a.Sections)
        {
            var marker = s.Markers.FirstOrDefault() ?? "";
            var lyric = string.Join(" / ", s.Lyrics.Take(2));
            sb.AppendLine(
                $"  {s.Index}: {s.Start:F0}-{s.End:F0}s  energy={s.Energy:F2}  label={s.Label}  " +
                $"{marker} {Trunc(lyric, 70)}".TrimEnd());
        }

        var styleBlock = string.IsNullOrWhiteSpace(song.Style)
            ? "The author gave no explicit style - choose one that fits the lyrics and mood."
            : $"The author REQUIRES this look and it must survive into your palette and tags: {song.Style}";

        return $$"""
        You are art-directing an Amiga-demoscene-style music video. It is abstract and
        visual: plasma, raster bars, tunnels, starfields, raymarched fractals, low-poly
        3D flyovers, scrolling text. There are no actors and no narrative footage.

        The song is {{a.Duration:F0}}s at {{a.Bpm:F0}} BPM and has been segmented into
        {{a.Sections.Length}} sections:

        {{sb}}

        {{styleBlock}}

        Decide what the song is ABOUT and translate that into visual direction. Return
        TAGS ONLY - never effect names, never shader names. Choose tags from this
        vocabulary (use several per section):

          space cosmic vast city urban structure mechanical industrial retro
          fire warm water fluid organic dark cold ominous bright glow
          psychedelic abstract dream geometric fractal glitch sharp aggressive
          calm sparse minimal build tension showcase cinematic strobe high-energy

        Tags must track the music: sparse and cold where energy is low, aggressive and
        strobing where it peaks, resolving toward the end.

        Respond with ONLY minified JSON, exactly this shape:
        {"mood":"one line","palette":"one of: frost ember void toxic neon sunset candy chrome",
        "story":"2-3 sentences on the visual arc","globalTags":["..."],
        "sections":[{"index":0,"tags":["..."],"mood":"one line","intensity":0.0,"textLines":[]}]}

        Give one entry per section, index matching the list above. "intensity" is 0..1
        and should broadly follow the energy column but may differ where the lyrics
        justify it.
        """;
    }

    static readonly Regex Transient = new(
        @"\b(429|500|502|503|504|529)\b|overload|rate.?limit|timed? ?out|temporar|try again|ECONNRESET|ETIMEDOUT|fetch failed",
        RegexOptions.IgnoreCase);

    static async Task<string> RunCliAsync(string llm, string prompt, CancellationToken ct)
    {
        for (int attempt = 1; ; attempt++)
        {
            var (code, outp, err) = await ExecAsync(llm, prompt, ct);
            if (code == 0) return outp;

            // BOTH streams: these CLIs print API errors to stdout and leave stderr
            // empty, so reporting stderr alone yields a blank failure message.
            var detail = string.Join("\n", new[] { outp, err }
                .Select(s => s.Trim()).Where(s => s.Length > 0));
            if (detail.Length == 0) detail = "(no output on stdout or stderr)";

            if (attempt >= MaxAttempts || !Transient.IsMatch(detail))
                throw new Exception($"{llm} failed ({code}): {Trunc(detail.ReplaceLineEndings(" "), 200)}");

            await Task.Delay(TimeSpan.FromSeconds(5 * Math.Pow(3, attempt - 1)), ct);
        }
    }

    static async Task<(int Code, string Out, string Err)> ExecAsync(
        string llm, string prompt, CancellationToken ct)
    {
        var psi = new ProcessStartInfo
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        switch (llm.ToLowerInvariant())
        {
            case "claude":
                psi.FileName = "claude";
                psi.ArgumentList.Add("-p");
                psi.ArgumentList.Add(prompt);
                break;
            case "codex":
                psi.FileName = "codex";
                psi.ArgumentList.Add("exec");
                psi.ArgumentList.Add(prompt);
                break;
            default:
                throw new Exception($"unknown llm '{llm}' (use claude or codex)");
        }

        using var p = Process.Start(psi) ?? throw new Exception($"could not launch '{llm}'");
        p.StandardInput.Close(); // EOF, so it can never block waiting on stdin

        // Drain both pipes concurrently - reading one to the end first deadlocks
        // against a full buffer on the other.
        var so = p.StandardOutput.ReadToEndAsync(ct);
        var se = p.StandardError.ReadToEndAsync(ct);
        await Task.WhenAll(so, se);
        await p.WaitForExitAsync(ct);
        return (p.ExitCode, so.Result, se.Result);
    }

    static string ExtractJson(string s)
    {
        int a = s.IndexOf('{');
        int b = s.LastIndexOf('}');
        if (a < 0 || b <= a) throw new Exception($"no JSON found in LLM output: {Trunc(s, 200)}");
        return s[a..(b + 1)];
    }

    static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "...";
}
