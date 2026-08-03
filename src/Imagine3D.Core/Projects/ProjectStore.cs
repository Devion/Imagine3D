using System.Text.Json;

namespace Imagine3D.Projects;

public sealed record ProjectSummary(
    string Name,
    string Root,
    string? Mp3,
    bool HasLyrics,
    bool HasAnalysis,
    bool HasStoryboard,
    string? Output,
    DateTime Modified);

/// Owns the projects root and the create/open/list operations over it.
public sealed class ProjectStore(string projectsRoot)
{
    public string Root { get; } = projectsRoot;

    static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public IReadOnlyList<ProjectSummary> List()
    {
        Directory.CreateDirectory(Root);
        var list = new List<ProjectSummary>();
        foreach (var dir in Directory.EnumerateDirectories(Root))
        {
            var p = new ProjectPaths(dir);
            if (!File.Exists(p.SettingsFile)) continue;
            ProjectSettings s;
            try { s = Load(p); }
            catch { continue; } // a half-written project.json shouldn't hide the rest
            var output = File.Exists(p.OutputVideo(s)) ? p.OutputVideo(s) : null;
            list.Add(new ProjectSummary(
                p.Name, dir, p.FindMp3(), p.FindTxt() is not null,
                File.Exists(p.AnalysisFile), File.Exists(p.StoryboardFile),
                output, Directory.GetLastWriteTime(dir)));
        }
        return list.OrderByDescending(x => x.Modified).ToList();
    }

    public ProjectPaths Create(string name)
    {
        name = ProjectPaths.Sanitize(name);
        var dir = Path.Combine(Root, name);
        if (Directory.Exists(dir))
            throw new InvalidOperationException($"A project named '{name}' already exists.");

        var paths = new ProjectPaths(dir);
        paths.EnsureCreated();
        Save(paths, new ProjectSettings { Name = name });
        return paths;
    }

    public ProjectPaths Open(string name)
    {
        var dir = Path.Combine(Root, ProjectPaths.Sanitize(name));
        if (!Directory.Exists(dir))
            throw new DirectoryNotFoundException($"No project named '{name}'.");
        var paths = new ProjectPaths(dir);
        paths.EnsureCreated(); // heal a project whose subdirs were deleted
        return paths;
    }

    public void Delete(string name)
    {
        var dir = Path.Combine(Root, ProjectPaths.Sanitize(name));
        // Guard against a traversal in `name` escaping the projects root entirely.
        if (!Path.GetFullPath(dir).StartsWith(Path.GetFullPath(Root), StringComparison.OrdinalIgnoreCase))
            throw new InvalidOperationException("Refusing to delete outside the projects root.");
        if (Directory.Exists(dir)) Directory.Delete(dir, recursive: true);
    }

    public ProjectSettings Load(ProjectPaths p)
    {
        if (!File.Exists(p.SettingsFile)) return new ProjectSettings { Name = p.Name };
        var s = JsonSerializer.Deserialize<ProjectSettings>(File.ReadAllText(p.SettingsFile), Json)
                ?? new ProjectSettings();
        if (string.IsNullOrWhiteSpace(s.Name)) s.Name = p.Name;
        s.Normalize();
        return s;
    }

    public void Save(ProjectPaths p, ProjectSettings s)
    {
        s.Normalize();
        p.EnsureCreated();
        File.WriteAllText(p.SettingsFile, JsonSerializer.Serialize(s, Json));
    }

    /// Copy an MP3 in as the project's root source, plus its sibling lyrics/style
    /// file if one exists. The originals are never touched again after this.
    public (string Mp3, string? Txt) ImportMp3(ProjectPaths p, string sourceMp3)
    {
        if (!File.Exists(sourceMp3))
            throw new FileNotFoundException($"MP3 not found: {sourceMp3}");

        p.EnsureCreated();

        // One MP3 per project - a re-import replaces the previous source and
        // invalidates everything derived from it.
        foreach (var old in Directory.EnumerateFiles(p.SourceDir))
            File.Delete(old);

        var mp3 = Path.Combine(p.SourceDir, Path.GetFileName(sourceMp3));
        File.Copy(sourceMp3, mp3, overwrite: true);

        string? txt = null;
        var srcTxt = Path.ChangeExtension(sourceMp3, ".txt");
        if (File.Exists(srcTxt))
        {
            txt = Path.ChangeExtension(mp3, ".txt");
            File.Copy(srcTxt, txt, overwrite: true);
        }

        // A new source makes the old analysis/plan meaningless - clear them rather
        // than leaving stale JSON that looks current.
        foreach (var f in new[] { p.AnalysisFile, p.WaveformFile, p.WordsFile, p.IntentFile, p.StoryboardFile })
            if (File.Exists(f)) File.Delete(f);

        var s = Load(p);
        s.SourceMp3 = Path.GetFileName(mp3);
        s.SourceTxt = txt is null ? null : Path.GetFileName(txt);
        Save(p, s);

        return (mp3, txt);
    }
}
