using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Text.Json;

namespace Imagine3D.Comfy;

/// Drives ComfyUI over its HTTP API: load an API-format workflow, substitute
/// %TOKENS%, queue it, poll history, download the result.
/// Ported from Mp3ToVid, with Console output replaced by a log callback.
public sealed class ComfyClient : IDisposable
{
    readonly HttpClient _http;
    readonly string _url;
    readonly string _root;
    readonly string _inputDir;
    readonly string _workflowDir;
    readonly Action<string> _log;
    readonly string _clientId = Guid.NewGuid().ToString("N");

    public ComfyClient(string url, string comfyRoot, string workflowDir, Action<string>? log = null)
    {
        _url = url.TrimEnd('/');
        _root = comfyRoot;
        _inputDir = Path.Combine(comfyRoot, "input");
        _workflowDir = workflowDir;
        _log = log ?? (_ => { });
        _http = new HttpClient { Timeout = TimeSpan.FromMinutes(30) };
    }

    public async Task EnsureUpAsync(CancellationToken ct = default)
    {
        if (await PingAsync(ct)) return;

        // Not running: launch it with ComfyUI's own embedded python, the same
        // invocation as run_nvidia_gpu.bat, in its own window so its logs show.
        var baseDir = Directory.GetParent(_root)?.FullName
            ?? throw new Exception($"can't find ComfyUI base dir from {_root}");
        var python = Path.Combine(baseDir, "python_embeded", "python.exe");
        if (!File.Exists(python))
            throw new Exception(
                $"ComfyUI is not responding at {_url} and there is no embedded python at {python}. " +
                "Start ComfyUI manually (run_nvidia_gpu.bat) and retry.");

        _log($"ComfyUI not up - launching {python}");
        Process.Start(new ProcessStartInfo(python,
            $"-s {Path.GetFileName(_root)}\\main.py --windows-standalone-build --enable-manager")
        {
            WorkingDirectory = baseDir,
            UseShellExecute = true,
        });

        for (int s = 0; s < 300; s += 3)
        {
            await Task.Delay(3000, ct);
            if (await PingAsync(ct)) { _log($"ComfyUI is up ({s}s)"); return; }
            if (s % 30 == 0 && s > 0) _log($"waiting for ComfyUI... ({s}s)");
        }
        throw new Exception("ComfyUI did not respond within 5 minutes - check its console window.");
    }

    async Task<bool> PingAsync(CancellationToken ct)
    {
        try { return (await _http.GetAsync($"{_url}/system_stats", ct)).IsSuccessStatusCode; }
        catch { return false; }
    }

    /// Copy a file into ComfyUI/input and return the basename that LoadImage /
    /// LoadAudio expect to be given.
    public string StageInput(string path)
    {
        Directory.CreateDirectory(_inputDir);
        var name = Path.GetFileName(path);
        File.Copy(path, Path.Combine(_inputDir, name), true);
        return name;
    }

    public async Task<string> RunAsync(
        string workflowFile, Dictionary<string, object> tokens, bool isVideo,
        CancellationToken ct = default)
    {
        var path = Path.Combine(_workflowDir, workflowFile);
        if (!File.Exists(path))
            throw new FileNotFoundException($"workflow not found: {path}");

        string json = Substitute(File.ReadAllText(path), tokens);

        using var doc = ParseOrExplain(json, workflowFile);
        if (doc.RootElement.TryGetProperty("_placeholder", out var ph) && ph.GetBoolean())
            throw new Exception(
                $"{workflowFile} is a placeholder. Export a working graph from ComfyUI " +
                "(Save -> Save (API Format)) and insert the %TOKENS%.");

        string promptId = await QueueAsync(json, ct);
        _log($"queued {promptId} ({workflowFile})");

        var outputs = await WaitForOutputsAsync(promptId, ct);
        var file = PickOutput(outputs, isVideo)
            ?? throw new Exception($"{workflowFile} produced no {(isVideo ? "video" : "image")} output");

        return await DownloadAsync(file, ct);
    }

    internal static string Substitute(string json, Dictionary<string, object> tokens)
    {
        // String values are JSON-serialised (quoted + escaped); numbers stay bare.
        foreach (var (k, v) in tokens)
        {
            string rep = v switch
            {
                string s => JsonSerializer.Serialize(s),
                bool b => b ? "true" : "false",
                int n => n.ToString(CultureInfo.InvariantCulture),
                double d => d.ToString(CultureInfo.InvariantCulture),
                _ => JsonSerializer.Serialize(v.ToString()),
            };
            json = json.Replace(k, rep);
        }
        return json;
    }

    static JsonDocument ParseOrExplain(string json, string file)
    {
        try { return JsonDocument.Parse(json); }
        catch (JsonException e)
        {
            throw new Exception($"{file} is not valid JSON after token substitution: {e.Message}");
        }
    }

    async Task<string> QueueAsync(string workflowJson, CancellationToken ct)
    {
        var body = $"{{\"prompt\":{workflowJson},\"client_id\":\"{_clientId}\"}}";
        var resp = await _http.PostAsync($"{_url}/prompt",
            new StringContent(body, Encoding.UTF8, "application/json"), ct);
        var text = await resp.Content.ReadAsStringAsync(ct);
        if (!resp.IsSuccessStatusCode)
            throw new Exception($"ComfyUI /prompt rejected the workflow:\n{text}");
        using var d = JsonDocument.Parse(text);
        return d.RootElement.GetProperty("prompt_id").GetString()!;
    }

    async Task<JsonElement> WaitForOutputsAsync(string promptId, CancellationToken ct)
    {
        var start = DateTime.UtcNow;
        while (true)
        {
            await Task.Delay(1500, ct);
            var text = await _http.GetStringAsync($"{_url}/history/{promptId}", ct);
            using var d = JsonDocument.Parse(text);
            if (!d.RootElement.TryGetProperty(promptId, out var entry)) continue;

            if (entry.TryGetProperty("status", out var st) &&
                st.TryGetProperty("status_str", out var s) && s.GetString() == "error")
                throw new Exception($"ComfyUI job failed:\n{entry}");

            if (entry.TryGetProperty("outputs", out var outputs) && outputs.EnumerateObject().Any())
            {
                _log($"done in {(DateTime.UtcNow - start).TotalSeconds:F0}s");
                return outputs.Clone();
            }
        }
    }

    static (string Filename, string Subfolder, string Type)? PickOutput(JsonElement outputs, bool isVideo)
    {
        string[] vid = [".mp4", ".webm", ".mkv", ".mov", ".gif"];
        string[] img = [".png", ".jpg", ".jpeg", ".webp"];
        var wanted = isVideo ? vid : img;

        (string, string, string)? found = null;
        foreach (var node in outputs.EnumerateObject())
        foreach (var arr in node.Value.EnumerateObject())
        {
            if (arr.Value.ValueKind != JsonValueKind.Array) continue;
            foreach (var item in arr.Value.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.Object) continue;
                if (!item.TryGetProperty("filename", out var fn)) continue;
                var name = fn.GetString() ?? "";
                if (!wanted.Any(e => name.EndsWith(e, StringComparison.OrdinalIgnoreCase))) continue;
                var sub = item.TryGetProperty("subfolder", out var sf) ? sf.GetString() ?? "" : "";
                var typ = item.TryGetProperty("type", out var tp) ? tp.GetString() ?? "output" : "output";
                found = (name, sub, typ); // keep the last - the final/upscaled stage
            }
        }
        return found;
    }

    async Task<string> DownloadAsync((string Filename, string Subfolder, string Type) f, CancellationToken ct)
    {
        var q = $"filename={Uri.EscapeDataString(f.Filename)}" +
                $"&subfolder={Uri.EscapeDataString(f.Subfolder)}&type={f.Type}";
        var bytes = await _http.GetByteArrayAsync($"{_url}/view?{q}", ct);
        var tmp = Path.Combine(Path.GetTempPath(), "i3d_" + f.Filename);
        await File.WriteAllBytesAsync(tmp, bytes, ct);
        return tmp;
    }

    public void Dispose() => _http.Dispose();
}
