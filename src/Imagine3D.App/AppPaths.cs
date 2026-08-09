namespace Imagine3D.App;

/// Where the app finds its own files. Web assets are served from the source tree
/// when it can be found, so editing a shader and hitting reload is enough - no
/// rebuild. A published build falls back to the copied wwwroot.
///
/// Everything the app *writes* - projects, converted assets - goes under DataRoot,
/// which for a published build is the executable's own directory. A deployed copy
/// therefore never reads or writes above itself, and never guesses at a location
/// outside the install.
public static class AppPaths
{
    public static string WebRoot { get; } = ResolveWebRoot();
    public static bool ServingFromSource { get; private set; }

    public static string WorkflowsDir { get; } = ResolveWorkflows();

    /// Everything the app writes lives under here. A deployed build keeps it next
    /// to the executable, so the install is self-contained and portable: nothing
    /// is ever written to a directory above the exe, and nothing depends on the
    /// working directory the shortcut happened to start us in.
    public static string DataRoot { get; } = ResolveDataRoot();

    public static string DefaultProjectsRoot { get; } = Path.Combine(DataRoot, "projects");

    /// Converted, decimated meshes. Sibling of the projects root so both are
    /// gitignored together and neither is inside the published output.
    public static string AssetsRoot { get; } = Path.Combine(DataRoot, "assets");

    static string ResolveWebRoot()
    {
        // Walk up from both the binary's location and the working directory:
        // `dotnet run` and Visual Studio start with the working directory set to
        // the project folder, which is a different tree from bin/.
        foreach (var start in new[] { AppContext.BaseDirectory, Directory.GetCurrentDirectory() })
        {
            var dir = new DirectoryInfo(start);
            for (int i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
            {
                var candidate = Path.Combine(dir.FullName, "src", "Imagine3D.Web");
                if (File.Exists(Path.Combine(candidate, "index.html")))
                {
                    ServingFromSource = true;
                    return candidate;
                }
            }
        }

        // Published layout: the web assets were copied next to the executable.
        return Path.Combine(AppContext.BaseDirectory, "wwwroot");
    }

    /// Fail with something actionable rather than a bare DirectoryNotFoundException
    /// from deep inside the static-file middleware.
    public static void ValidateWebRoot()
    {
        if (Directory.Exists(WebRoot) && File.Exists(Path.Combine(WebRoot, "index.html")))
            return;

        throw new DirectoryNotFoundException(
            $"Web assets not found at {WebRoot}.\n" +
            "Expected src/Imagine3D.Web/index.html somewhere above the executable or the " +
            "working directory, or a wwwroot next to the executable in a published build.\n" +
            $"  executable : {AppContext.BaseDirectory}\n" +
            $"  working dir: {Directory.GetCurrentDirectory()}");
    }

    static string ResolveWorkflows()
    {
        // Copied next to the exe by the build, so this is the normal answer for both
        // a dev run and a published one.
        var local = Path.Combine(AppContext.BaseDirectory, "workflows");
        if (Directory.Exists(local)) return local;

        // Only the source tree is searched as a fallback: a published install must
        // never pick up a `workflows` directory that happens to sit above it.
        if (SourceTreeRoot() is { } root)
        {
            var candidate = Path.Combine(root, "workflows");
            if (Directory.Exists(candidate)) return candidate;
        }

        return local;
    }

    /// Next to the executable, always - except during a source-tree run, where the
    /// exe sits in bin/ and a `dotnet clean` or a Debug/Release switch would take
    /// the projects with it. That case is already identified by the web assets
    /// having been found in the source tree, and it cannot arise in a published
    /// build, which serves from its own wwwroot.
    static string ResolveDataRoot() => SourceTreeRoot() ?? AppContext.BaseDirectory;

    /// The repository root, when this process is running against the source tree.
    /// Derived from the web root that was already located rather than by a second
    /// search, so the two can never disagree about which tree we are in.
    static string? SourceTreeRoot()
    {
        if (!ServingFromSource) return null;

        // WebRoot is <root>/src/Imagine3D.Web.
        var root = Directory.GetParent(WebRoot)?.Parent;
        return root is not null && File.Exists(Path.Combine(root.FullName, "Imagine3D.slnx"))
            ? root.FullName
            : null;
    }

    /// Called once at startup: the app should come up with somewhere to write
    /// already prepared, rather than failing on the first save.
    public static void EnsureDataDirs()
    {
        Directory.CreateDirectory(DefaultProjectsRoot);
        Directory.CreateDirectory(AssetsRoot);
    }
}
