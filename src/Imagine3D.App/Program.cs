using System.Net;
using System.Net.WebSockets;
using System.Text.Json;
using Imagine3D.App;
using Imagine3D.Assets;
using Imagine3D.Direct;
using Imagine3D.Media;
using Imagine3D.Pipeline;
using Imagine3D.Projects;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.Extensions.FileProviders;
using Photino.NET;

// --serve runs the backend without opening a window, so the UI can be driven from
// an ordinary browser with devtools - the only practical way to debug WebGL.
bool headless = args.Contains("--serve");

AppPaths.ValidateWebRoot();

// WebRootPath is deliberately not set: when it points outside the content root
// the framework can still fall back to <contentroot>/wwwroot and throw on a
// directory that was never meant to exist. The web assets are served through an
// explicit file provider below instead, the same way /media and /assets are.
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args = args });

builder.Logging.ClearProviders();
builder.Logging.AddSimpleConsole(o => o.SingleLine = true);
builder.Logging.SetMinimumLevel(LogLevel.Warning);

// Loopback only, ephemeral port - this server is an implementation detail of the
// desktop app and must never be reachable from the network.
builder.WebHost.ConfigureKestrel(k =>
{
    k.Listen(IPAddress.Loopback, 0);
    k.Limits.MaxRequestBodySize = null;
});

var projectsRoot = AppPaths.DefaultProjectsRoot;
Directory.CreateDirectory(projectsRoot);

var assetsRoot = AppPaths.AssetsRoot;
Directory.CreateDirectory(assetsRoot);

builder.Services.AddSingleton(new ProjectStore(projectsRoot));
builder.Services.AddSingleton(new AssetCatalog(assetsRoot));
builder.Services.AddSingleton(new EffectRegistryProvider(AppPaths.WebRoot));
builder.Services.AddSingleton(new Ffmpeg());
builder.Services.AddSingleton<Session>();
builder.Services.AddSingleton<GenerationPipeline>();

var app = builder.Build();

app.UseWebSockets(new WebSocketOptions { KeepAliveInterval = TimeSpan.FromSeconds(30) });
var webFiles = new PhysicalFileProvider(AppPaths.WebRoot);

app.UseDefaultFiles(new DefaultFilesOptions { FileProvider = webFiles });
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = webFiles,
    ServeUnknownFileTypes = true,
    // When the web root is the source tree, this is a live-editing session:
    // caching an engine module or shader means an edit silently does nothing
    // until the cache expires, which is a genuinely confusing failure.
    OnPrepareResponse = ctx =>
    {
        if (AppPaths.ServingFromSource)
            ctx.Context.Response.Headers.CacheControl = "no-store, no-cache, must-revalidate";
    },
});

// Project media (source MP3, LTX clips, finished MP4) lives outside wwwroot.
// Serving it through the static-file middleware gives HTTP range requests for
// free, which is what <video> needs in order to seek.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(projectsRoot),
    RequestPath = "/media",
    ServeUnknownFileTypes = true,
    DefaultContentType = "application/octet-stream",
});

// Converted meshes, served to the webview. Large OBJs, so range requests matter.
app.UseStaticFiles(new StaticFileOptions
{
    FileProvider = new PhysicalFileProvider(assetsRoot),
    RequestPath = "/assets",
    ServeUnknownFileTypes = true,
    DefaultContentType = "text/plain",
});

// ---------------------------------------------------------------- API

app.MapGet("/api/health", (EffectRegistryProvider reg, Session session) => Results.Json(new
{
    ok = true,
    webRoot = AppPaths.WebRoot,
    servingFromSource = AppPaths.ServingFromSource,
    projectsRoot,
    effects = reg.Current.All.Count,
    ffmpeg = Ffmpeg.Locate(),
    // Whether the page has attached its render channel. Without this, a stalled
    // run is indistinguishable from a page that never loaded.
    pageConnected = session.Channel is { IsOpen: true },
    busy = session.IsBusy,
    lastError = session.LastError,
    log = session.RecentLog(),
}, Json.Options));

app.MapGet("/api/effects", (EffectRegistryProvider reg) => Results.Json(reg.Current.All, Json.Options));

app.MapGet("/api/projects", (ProjectStore store) => Results.Json(store.List(), Json.Options));

app.MapGet("/api/assets", (AssetCatalog catalog) => Results.Json(catalog.Load(), Json.Options));

// Converting the model library takes minutes (Blender runs headless per asset),
// so this is fire-and-forget with progress over the WebSocket.
app.MapPost("/api/assets/build", (AssetCatalog catalog, Session session, string? source, bool force = false) =>
{
    var src = source ?? @"D:\Downloads\mod";
    var progress = session.ProgressSink();

    _ = Task.Run(() =>
    {
        try { catalog.Build(src, progress, force: force); }
        catch (Exception e)
        {
            session.Fail($"asset build: {e.Message}");
            Console.Error.WriteLine($"[assets] {e}");
        }
    });

    return Results.Accepted();
});

app.MapPost("/api/projects", (ProjectStore store, CreateRequest req) =>
{
    if (string.IsNullOrWhiteSpace(req.Name)) return Results.BadRequest(new { error = "Name is required." });
    try
    {
        var paths = store.Create(req.Name);
        return Results.Json(store.Load(paths), Json.Options);
    }
    catch (Exception e) { return Results.BadRequest(new { error = e.Message }); }
});

app.MapGet("/api/projects/{name}", (ProjectStore store, string name) =>
{
    try
    {
        var paths = store.Open(name);
        var settings = store.Load(paths);
        return Results.Json(new
        {
            settings,
            mp3 = paths.FindMp3() is { } m ? Path.GetFileName(m) : null,
            txt = paths.FindTxt() is { } t ? Path.GetFileName(t) : null,
            hasAnalysis = File.Exists(paths.AnalysisFile),
            hasStoryboard = File.Exists(paths.StoryboardFile),
            output = File.Exists(paths.OutputVideo(settings))
                ? $"/media/{name}/output/{Path.GetFileName(paths.OutputVideo(settings))}"
                : null,
            mediaBase = $"/media/{name}",
        }, Json.Options);
    }
    catch (Exception e) { return Results.NotFound(new { error = e.Message }); }
});

app.MapPut("/api/projects/{name}/settings", (ProjectStore store, string name, ProjectSettings incoming) =>
{
    var paths = store.Open(name);
    var current = store.Load(paths);

    // Only the user-facing fields are writable; source filenames are owned by import.
    current.Aspect = incoming.Aspect;
    current.Fps = incoming.Fps;
    current.Seed = incoming.Seed;
    current.Encoder = incoming.Encoder;
    current.Crf = incoming.Crf;
    current.Supersample = incoming.Supersample;
    current.SaveTrimmedCopy = incoming.SaveTrimmedCopy;
    current.TrimMinutes = incoming.TrimMinutes;
    current.TrimTargetMb = incoming.TrimTargetMb;
    current.BpmOverride = incoming.BpmOverride;
    current.DownbeatOffsetOverride = incoming.DownbeatOffsetOverride;
    current.LyricAlignment = incoming.LyricAlignment;
    current.WhisperModel = incoming.WhisperModel;
    current.Ltx = incoming.Ltx;
    // Aspect drives resolution, so clear any stale explicit size.
    current.Width = 0;
    current.Height = 0;

    store.Save(paths, current);
    return Results.Json(current, Json.Options);
});

app.MapPost("/api/projects/{name}/import", (ProjectStore store, string name, ImportRequest req) =>
{
    try
    {
        var paths = store.Open(name);
        var (mp3, txt) = store.ImportMp3(paths, req.Path);
        return Results.Json(new
        {
            mp3 = Path.GetFileName(mp3),
            txt = txt is null ? null : Path.GetFileName(txt),
        }, Json.Options);
    }
    catch (Exception e) { return Results.BadRequest(new { error = e.Message }); }
});

app.MapPost("/api/projects/{name}/analyze",
    async (ProjectStore store, GenerationPipeline pipeline, Session session, string name) =>
{
    var paths = store.Open(name);
    var settings = store.Load(paths);
    try
    {
        var progress = session.ProgressSink();
        var (analysis, _) = await Task.Run(() => pipeline.Analyze(paths, settings, progress));
        return Results.Json(analysis, Json.Options);
    }
    catch (Exception e) { return Results.BadRequest(new { error = e.Message }); }
});

app.MapGet("/api/projects/{name}/analysis", (ProjectStore store, string name) =>
{
    var paths = store.Open(name);
    return File.Exists(paths.AnalysisFile)
        ? Results.Text(File.ReadAllText(paths.AnalysisFile), "application/json")
        : Results.NotFound(new { error = "No analysis yet." });
});

app.MapGet("/api/projects/{name}/waveform", (ProjectStore store, string name) =>
{
    var paths = store.Open(name);
    return File.Exists(paths.WaveformFile)
        ? Results.Text(File.ReadAllText(paths.WaveformFile), "application/json")
        : Results.NotFound(new { error = "No waveform yet." });
});

app.MapGet("/api/projects/{name}/storyboard", (ProjectStore store, string name) =>
{
    var paths = store.Open(name);
    return File.Exists(paths.StoryboardFile)
        ? Results.Text(File.ReadAllText(paths.StoryboardFile), "application/json")
        : Results.NotFound(new { error = "No storyboard yet." });
});

app.MapPost("/api/projects/{name}/generate",
    (GenerationPipeline pipeline, Session session, string name, GenerateRequest req) =>
{
    var cts = session.TryBeginRun();
    if (cts is null) return Results.Conflict(new { error = "A generation run is already in progress." });

    session.CurrentProject = name;
    var progress = session.ProgressSink();

    // Fire and forget: the HTTP call returns at once and every subsequent update
    // reaches the UI over the WebSocket.
    _ = Task.Run(async () =>
    {
        try
        {
            await pipeline.RunAsync(name,
                new PipelineOptions(req.UseLlm, req.GenerateLtx, req.Force, req.UseExistingStoryboard, req.PlanOnly),
                progress, cts.Token);
        }
        catch (OperationCanceledException)
        {
            session.Fail("Cancelled");
            progress.Report(new StageProgress(PipelineStage.Done, 0, "Cancelled", Failed: true));
        }
        catch (Exception e)
        {
            // Also to the console and the session log: when the page is not
            // attached, the WebSocket report goes nowhere and the run looks hung.
            session.Fail(e.ToString());
            Console.Error.WriteLine($"[generate] FAILED: {e}");
            progress.Report(new StageProgress(PipelineStage.Done, 0, e.Message, Failed: true));
        }
        finally { session.EndRun(); }
    });

    return Results.Accepted();
});

app.MapPost("/api/cancel", (Session session) => { session.Cancel(); return Results.Ok(); });

// Ask the connected page to render the contact sheet and report where it landed.
app.MapPost("/api/devsheet",
    async (Session session, string? kind, string? palette, bool reload = true) =>
{
    var channel = session.Channel;
    if (channel is null || !channel.IsOpen)
        return Results.BadRequest(new { error = "The page is not connected." });

    // Reload first by default: the engine modules are cached for the lifetime of
    // the document, so without this the sheet renders the code as it was when the
    // window opened, not as it is on disk.
    if (reload)
    {
        var previous = channel;
        await channel.SendJsonAsync(new { cmd = "reload" });
        channel = await session.WaitForNewChannelAsync(previous, TimeSpan.FromSeconds(25));
        if (channel is null)
            return Results.BadRequest(new { error = "The page did not come back after reloading." });
    }

    await channel.SendJsonAsync(new { cmd = "sheet", kind = kind ?? "all", palette = palette ?? "neon" });

    // The sheet renders every shader in the library, so allow a generous window.
    var msg = await channel.ReadAsync(TimeSpan.FromMinutes(3));
    return Results.Text(msg.Text, "application/json");
});

// Development aid: preview.html renders a contact sheet of every effect and posts
// it here so the shader library can be reviewed without launching a full render.
app.MapPost("/api/devshot", async (HttpContext ctx, Session session) =>
{
    var dir = Path.Combine(Path.GetTempPath(), "imagine3d-shots");
    Directory.CreateDirectory(dir);

    var name = ctx.Request.Query["name"].ToString();
    if (string.IsNullOrWhiteSpace(name)) name = "shot";
    var file = Path.Combine(dir, $"{ProjectPaths.Sanitize(name)}.png");

    await using var fs = File.Create(file);
    await ctx.Request.Body.CopyToAsync(fs);

    session.Log($"[devshot] wrote {file}");
    return Results.Json(new { path = file }, Json.Options);
});

// The page reports its own errors here. Without this a failure inside the webview
// is invisible - there is no console to read when the app runs as a window.
app.MapPost("/api/clientlog", (Session session, ClientLog entry) =>
{
    var line = $"[page] {entry.Level}: {entry.Message}";
    session.Log(line);
    Console.Error.WriteLine(line);
    if (!string.IsNullOrWhiteSpace(entry.Stack))
        Console.Error.WriteLine(entry.Stack);
    if (entry.Level == "error") session.Fail(entry.Message);
    return Results.Ok();
});

// ---------------------------------------------------------------- WebSocket

app.Map("/ws", async (HttpContext ctx, Session session) =>
{
    if (!ctx.WebSockets.IsWebSocketRequest)
    {
        ctx.Response.StatusCode = 400;
        return;
    }

    using var socket = await ctx.WebSockets.AcceptWebSocketAsync();
    var channel = new RenderChannel(socket);
    session.Channel = channel;
    channel.Start(ctx.RequestAborted);

    await channel.SendJsonAsync(new { cmd = "hello", project = session.CurrentProject });

    // Hold the request open for the socket's lifetime; the render loop borrows this
    // same channel while it runs.
    try
    {
        while (channel.IsOpen && !ctx.RequestAborted.IsCancellationRequested)
            await Task.Delay(500, ctx.RequestAborted);
    }
    catch (OperationCanceledException) { /* window closed */ }
    finally
    {
        if (ReferenceEquals(session.Channel, channel)) session.Channel = null;
        channel.Dispose();
    }
});

// ---------------------------------------------------------------- start

await app.StartAsync();

var addresses = app.Services.GetRequiredService<IServer>()
    .Features.Get<IServerAddressesFeature>()!.Addresses;
var url = addresses.First().Replace("http://[::]", "http://127.0.0.1");

Console.WriteLine($"Imagine3D backend  {url}");
Console.WriteLine($"  web root   {AppPaths.WebRoot}{(AppPaths.ServingFromSource ? "  (live from source)" : "")}");
Console.WriteLine($"  projects   {projectsRoot}");
Console.WriteLine($"  effects    {app.Services.GetRequiredService<EffectRegistryProvider>().Current.All.Count}");

if (headless)
{
    Console.WriteLine("\nHeadless mode - open the URL above in a browser. Ctrl+C to stop.");
    await app.WaitForShutdownAsync();
    return;
}

// WebView2 requires an STA apartment. Top-level statements resume on a thread-pool
// thread after `await app.StartAsync()`, which is MTA - there the native window is
// created but the webview never initialises and the window just stays blank. So the
// UI gets its own explicitly-STA thread.
var uiThread = new Thread(RunWindow, 16 * 1024 * 1024);
if (OperatingSystem.IsWindows()) uiThread.SetApartmentState(ApartmentState.STA);
uiThread.Start();
uiThread.Join();

await app.StopAsync();
return;

void RunWindow()
{
    var window = new PhotinoWindow()
        .SetTitle("Imagine3D")
        .SetUseOsDefaultSize(false)
        .SetSize(1600, 1000)
        .Center()
        .SetResizable(true)
        .SetDevToolsEnabled(true)
        .SetContextMenuEnabled(true)
        .RegisterWebMessageReceivedHandler((sender, message) =>
        {
            // The only thing the native side is needed for is the file picker - a
            // browser cannot hand us a real path, and import needs one to copy from.
            var self = (PhotinoWindow)sender!;
            try
            {
                using var doc = JsonDocument.Parse(message);
                if (doc.RootElement.GetProperty("cmd").GetString() != "pickMp3") return;

                var picked = self.ShowOpenFile("Select an MP3", multiSelect: false,
                    filters: [("Audio", ["mp3"])]);

                self.SendWebMessage(JsonSerializer.Serialize(new
                {
                    cmd = "pickedMp3",
                    path = picked is { Length: > 0 } ? picked[0] : null,
                }, Json.Options));
            }
            catch (Exception e)
            {
                self.SendWebMessage(JsonSerializer.Serialize(
                    new { cmd = "pickedMp3", error = e.Message }, Json.Options));
            }
        })
        .Load(url);

    window.WaitForClose();
}

// ---------------------------------------------------------------- DTOs

record ClientLog(string Level, string Message, string? Stack);
record CreateRequest(string Name);
record ImportRequest(string Path);
record GenerateRequest(
    bool UseLlm = true,
    bool GenerateLtx = false,
    bool Force = false,
    bool UseExistingStoryboard = false,
    bool PlanOnly = false);
