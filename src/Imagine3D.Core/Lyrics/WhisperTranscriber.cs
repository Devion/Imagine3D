using System.Diagnostics;
using System.Text.Json;
using System.Text.Json.Serialization;
using Imagine3D.Media;

namespace Imagine3D.Lyrics;

public sealed record WordStamp(
    [property: JsonPropertyName("word")] string Word,
    [property: JsonPropertyName("start")] double Start,
    [property: JsonPropertyName("end")] double End,
    /// Whisper's own probability that its segment contains no speech at all.
    /// High values mark passages where it invented words over instrumental music.
    [property: JsonPropertyName("noSpeech")] double NoSpeech = 0,
    /// Average log-probability of the segment; very negative means it was guessing.
    [property: JsonPropertyName("logprob")] double LogProb = 0,
    /// Per-word confidence.
    [property: JsonPropertyName("prob")] double Prob = 1);

sealed record WhisperResult(
    [property: JsonPropertyName("device")] string Device,
    [property: JsonPropertyName("model")] string Model,
    [property: JsonPropertyName("words")] WordStamp[] Words);

/// Runs openai-whisper for word-level timestamps.
///
/// Uses ComfyUI's embedded Python, which already has whisper and a CUDA torch -
/// no separate environment to install or keep in sync.
public sealed class WhisperTranscriber(Ffmpeg ffmpeg)
{
    /// Where the model weights land. Whisper downloads on first use.
    public const string DefaultModel = "medium";

    public static string? FindPython()
    {
        string[] candidates =
        [
            @"D:\AI\ComfyUI\python_embeded\python.exe",
            @"C:\AI\ComfyUI\python_embeded\python.exe",
        ];
        foreach (var c in candidates)
            if (File.Exists(c)) return c;
        return null;
    }

    public static bool IsAvailable => FindPython() is not null;

    static string ScriptPath()
    {
        // Ships next to the assembly; also findable from the source tree in dev.
        var local = Path.Combine(AppContext.BaseDirectory, "whisper_align.py");
        if (File.Exists(local)) return local;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "src", "Imagine3D.Core", "Lyrics", "whisper_align.py");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("whisper_align.py not found");
    }

    /// Transcribe with word timestamps. `promptText` biases decoding toward the
    /// song's actual vocabulary, which markedly improves how many words land.
    public async Task<WordStamp[]> TranscribeAsync(
        string mp3Path, string workDir, string model, string? promptText,
        bool isolateVocals, CancellationToken ct = default)
    {
        var python = FindPython()
            ?? throw new InvalidOperationException(
                "No Python with whisper found. Expected ComfyUI's embedded interpreter.");

        Directory.CreateDirectory(workDir);
        var wav = Path.Combine(workDir, "align_16k.wav");

        // Stereo so the centre-channel trick has something to work with.
        ffmpeg.Exec($"-y -hide_banner -loglevel error -i \"{mp3Path}\" " +
                    $"-ac 2 -ar 16000 -c:a pcm_s16le \"{wav}\"");

        var promptFile = "";
        if (!string.IsNullOrWhiteSpace(promptText))
        {
            promptFile = Path.Combine(workDir, "align_prompt.txt");
            await File.WriteAllTextAsync(promptFile, promptText, ct);
        }

        var psi = new ProcessStartInfo(python)
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add(ScriptPath());
        psi.ArgumentList.Add(wav);
        psi.ArgumentList.Add(model);
        psi.ArgumentList.Add("en");
        psi.ArgumentList.Add(promptFile);
        psi.ArgumentList.Add(isolateVocals ? "1" : "0");

        using var p = Process.Start(psi)
            ?? throw new InvalidOperationException($"could not start {python}");

        var so = p.StandardOutput.ReadToEndAsync(ct);
        var se = p.StandardError.ReadToEndAsync(ct);
        await Task.WhenAll(so, se);
        await p.WaitForExitAsync(ct);

        if (p.ExitCode != 0)
            throw new InvalidOperationException(
                $"whisper failed ({p.ExitCode}): {Trunc(se.Result.ReplaceLineEndings(" "), 300)}");

        // Whisper writes progress bars to stderr; stdout is only our JSON, but be
        // defensive and take the object.
        var text = so.Result;
        int a = text.IndexOf('{'), b = text.LastIndexOf('}');
        if (a < 0 || b <= a)
            throw new InvalidOperationException("whisper produced no JSON output");

        var result = JsonSerializer.Deserialize<WhisperResult>(text[a..(b + 1)]);
        return result?.Words ?? [];
    }

    static string Trunc(string s, int n) => s.Length <= n ? s : s[..n] + "...";
}
