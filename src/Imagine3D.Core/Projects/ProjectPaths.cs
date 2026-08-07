namespace Imagine3D.Projects;

/// The on-disk layout of a single project. Every stage of the pipeline reads and
/// writes plain files here, so a run is inspectable, resumable and re-renderable
/// without the app.
public sealed class ProjectPaths(string root)
{
    public string Root { get; } = root;

    public string SettingsFile => Path.Combine(Root, "project.json");

    public string SourceDir => Path.Combine(Root, "source");

    /// Images the project supplies for the director to work with. Not derived
    /// from anything, so nothing downstream may ever delete them.
    public string ImagesDir => Path.Combine(Root, "images");

    public string AnalysisDir => Path.Combine(Root, "analysis");
    public string PlanDir => Path.Combine(Root, "plan");
    public string LtxDir => Path.Combine(Root, "ltx");
    public string CacheDir => Path.Combine(Root, "cache");
    public string KeyframeDir => Path.Combine(CacheDir, "keyframes");
    public string OutputDir => Path.Combine(Root, "output");
    public string LogDir => Path.Combine(Root, "logs");

    public string AnalysisFile => Path.Combine(AnalysisDir, "analysis.json");

    /// Whisper's word timeline, cached so re-analysis does not repeat a GPU pass.
    public string WordsFile => Path.Combine(AnalysisDir, "words.json");
    public string WaveformFile => Path.Combine(AnalysisDir, "waveform.json");
    public string IntentFile => Path.Combine(PlanDir, "intent.json");
    public string StoryboardFile => Path.Combine(PlanDir, "storyboard.json");
    public string LtxPromptsFile => Path.Combine(LtxDir, "prompts.json");

    public string Name => Path.GetFileName(Root.TrimEnd(Path.DirectorySeparatorChar));

    public void EnsureCreated()
    {
        foreach (var d in new[]
                 { Root, SourceDir, ImagesDir, AnalysisDir, PlanDir, LtxDir, CacheDir, KeyframeDir, OutputDir, LogDir })
            Directory.CreateDirectory(d);
    }

    /// What counts as an image. Anything a browser can decode into a texture -
    /// the renderer uploads these through an <img> element, so this list is
    /// exactly the formats WebGL can be handed.
    public static readonly string[] ImageExtensions =
        [".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".avif"];

    public static bool IsImage(string path) =>
        ImageExtensions.Contains(Path.GetExtension(path), StringComparer.OrdinalIgnoreCase);

    /// The project's images, by name, sorted.
    ///
    /// Sorted rather than in directory order because the director shuffles this
    /// list from the project seed: a plan has to come out the same twice, and the
    /// order the filesystem happens to enumerate in is not something to build on.
    public IReadOnlyList<string> ListImages() =>
        Directory.Exists(ImagesDir)
            ? Directory.EnumerateFiles(ImagesDir)
                .Where(IsImage)
                .Select(f => Path.GetFileName(f))
                .OrderBy(n => n, StringComparer.OrdinalIgnoreCase)
                .ToList()
            : [];

    /// The imported MP3, whatever it was called originally.
    public string? FindMp3() => FirstOrNull(SourceDir, "*.mp3");

    /// Sibling lyrics/style file - same stem as the MP3.
    public string? FindTxt()
    {
        var mp3 = FindMp3();
        if (mp3 is null) return null;
        var txt = Path.ChangeExtension(mp3, ".txt");
        return File.Exists(txt) ? txt : null;
    }

    public string OutputVideo(ProjectSettings s)
    {
        var stem = Path.GetFileNameWithoutExtension(FindMp3() ?? Name);
        var tag = s.Aspect.Replace(':', 'x');
        return Path.Combine(OutputDir, $"{Sanitize(stem)}_{tag}.mp4");
    }

    /// The shortened copy, named with its length so the two never get confused.
    public string OutputVideoTrimmed(ProjectSettings s)
    {
        var full = OutputVideo(s);
        var minutes = s.TrimMinutes;
        // "4min" reads better than "4.0min" for the common whole-minute case.
        var label = Math.Abs(minutes - Math.Round(minutes)) < 0.01
            ? $"{minutes:0}min"
            : $"{minutes:0.##}min".Replace('.', '_');
        return Path.Combine(OutputDir,
            $"{Path.GetFileNameWithoutExtension(full)}_{label}.mp4");
    }

    static string? FirstOrNull(string dir, string pattern) =>
        Directory.Exists(dir) ? Directory.EnumerateFiles(dir, pattern).FirstOrDefault() : null;

    public static string Sanitize(string name)
    {
        var bad = Path.GetInvalidFileNameChars();
        var cleaned = new string(name.Select(c => bad.Contains(c) ? '_' : c).ToArray()).Trim();
        return cleaned.Length == 0 ? "project" : cleaned;
    }
}
