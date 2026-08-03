namespace Imagine3D.App;

/// Where the app finds its own files. Web assets are served from the source tree
/// when it can be found, so editing a shader and hitting reload is enough - no
/// rebuild. A published build falls back to the copied wwwroot.
public static class AppPaths
{
    public static string WebRoot { get; } = ResolveWebRoot();
    public static bool ServingFromSource { get; private set; }

    public static string WorkflowsDir { get; } = ResolveWorkflows();

    public static string DefaultProjectsRoot { get; } = ResolveProjectsRoot();

    /// Converted, decimated meshes. Sibling of the projects root so both are
    /// gitignored together and neither is inside the published output.
    public static string AssetsRoot { get; } =
        Path.Combine(Path.GetDirectoryName(ResolveProjectsRoot())!, "assets");

    static string ResolveWebRoot()
    {
        // Walk up from bin/Debug/net10.0/win-x64 looking for the source web project.
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "src", "Imagine3D.Web");
            if (File.Exists(Path.Combine(candidate, "index.html")))
            {
                ServingFromSource = true;
                return candidate;
            }
        }

        return Path.Combine(AppContext.BaseDirectory, "wwwroot");
    }

    static string ResolveWorkflows()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "workflows");
        if (Directory.Exists(local)) return local;

        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "workflows");
            if (Directory.Exists(candidate)) return candidate;
        }
        return local;
    }

    static string ResolveProjectsRoot()
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
            if (File.Exists(Path.Combine(dir.FullName, "Imagine3D.slnx")))
                return Path.Combine(dir.FullName, "projects");

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments), "Imagine3D", "projects");
    }
}
