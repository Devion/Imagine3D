using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using Imagine3D.Pipeline;

namespace Imagine3D.Assets;

public sealed record AssetEntry(
    string Id,
    string Name,
    string File,
    int Triangles,
    float[] Min,
    float[] Max,
    string[] Tags,
    string Source);

/// Converts the model library into something a webview can actually load.
///
/// The raw library is 244 MB of Castelia City across 777 files plus several
/// hundred-megabyte .blend files - none of which a browser can read. Everything is
/// normalised to a single decimated OBJ per asset, once, and cached.
public sealed class AssetCatalog(string assetsRoot)
{
    public string Root { get; } = assetsRoot;
    public string CatalogFile => Path.Combine(Root, "catalog.json");
    public string MeshDir => Path.Combine(Root, "meshes");

    static readonly JsonSerializerOptions Json = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    public List<AssetEntry> Load()
    {
        if (!File.Exists(CatalogFile)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<AssetEntry>>(File.ReadAllText(CatalogFile), Json) ?? [];
        }
        catch (JsonException) { return []; }
    }

    void Save(List<AssetEntry> entries) =>
        File.WriteAllText(CatalogFile, JsonSerializer.Serialize(entries, Json));

    /// Blender is needed for .blend files and for decimation. It ships without
    /// being added to PATH, so look where the installer actually puts it.
    public static string? FindBlender()
    {
        var roots = new[]
        {
            @"C:\Program Files\Blender Foundation",
            @"D:\Program Files\Blender Foundation",
            @"C:\Program Files (x86)\Blender Foundation",
        };
        foreach (var root in roots)
        {
            if (!Directory.Exists(root)) continue;
            // Newest version first.
            foreach (var dir in Directory.GetDirectories(root).OrderByDescending(d => d))
            {
                var exe = Path.Combine(dir, "blender.exe");
                if (File.Exists(exe)) return exe;
            }
        }
        return null;
    }

    /// Tags are inferred from the file/folder name. Crude, but it only has to be
    /// good enough for the director to pick a city for a city-tagged section.
    static string[] InferTags(string path)
    {
        var t = path.ToLowerInvariant();
        var tags = new List<string> { "model" };
        void Add(params string[] xs) { foreach (var x in xs) if (!tags.Contains(x)) tags.Add(x); }

        if (t.Contains("city") || t.Contains("castelia") || t.Contains("future") || t.Contains("building"))
            Add("city", "urban", "structure", "vast");
        if (t.Contains("spaceship") || t.Contains("intergalactic") || t.Contains("station") || t.Contains("space"))
            Add("space", "scifi", "mechanical", "cosmic");
        if (t.Contains("dragon") || t.Contains("wolf") || t.Contains("hand") || t.Contains("basemodel"))
            Add("creature", "organic", "showcase");
        if (t.Contains("mclaren") || t.Contains("senna") || t.Contains("car") || t.Contains("bus"))
            Add("vehicle", "mechanical", "showcase");
        if (t.Contains("plant") || t.Contains("tree"))
            Add("organic", "prop");
        if (t.Contains("map") || t.Contains("terrain") || t.Contains("scene"))
            Add("structure", "vast");

        return tags.ToArray();
    }

    /// Build (or refresh) the catalogue from a source directory of raw models.
    public List<AssetEntry> Build(
        string sourceRoot, IProgress<StageProgress>? progress = null,
        int targetTriangles = 120_000, bool force = false)
    {
        Directory.CreateDirectory(MeshDir);
        var existing = Load().ToDictionary(e => e.Id, StringComparer.OrdinalIgnoreCase);
        var result = new List<AssetEntry>();

        void Report(double f, string msg) =>
            progress?.Report(new StageProgress(PipelineStage.Storyboard, f, msg));

        if (!Directory.Exists(sourceRoot))
        {
            Report(1, $"Asset source {sourceRoot} not found - skipping");
            return result;
        }

        var blender = FindBlender();

        // One candidate per asset folder, preferring formats we can read directly.
        //
        // The root is scanned last and only for files it holds directly: recursing
        // from the root as well would rediscover every subfolder's model and
        // register it a second time under a different id.
        var candidates = new List<string>();
        foreach (var loose in Directory.EnumerateFiles(sourceRoot, "*.obj", SearchOption.TopDirectoryOnly))
            candidates.Add(loose);

        foreach (var dir in Directory.GetDirectories(sourceRoot))
        {
            var obj = Directory.EnumerateFiles(dir, "*.obj", SearchOption.AllDirectories)
                .OrderByDescending(f => new FileInfo(f).Length).FirstOrDefault();
            if (obj is not null) { candidates.Add(obj); continue; }

            var blend = Directory.EnumerateFiles(dir, "*.blend", SearchOption.AllDirectories)
                .OrderByDescending(f => new FileInfo(f).Length).FirstOrDefault();
            if (blend is not null) candidates.Add(blend);
        }

        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (int i = 0; i < candidates.Count; i++)
        {
            var src = candidates[i];
            var id = MakeId(src, sourceRoot);
            if (!seen.Add(id)) continue;
            var outFile = Path.Combine(MeshDir, $"{id}.obj");
            double frac = i / (double)Math.Max(1, candidates.Count);

            if (!force && existing.TryGetValue(id, out var cached) &&
                File.Exists(Path.Combine(MeshDir, cached.File)))
            {
                Report(frac, $"{id} - cached");
                result.Add(cached);
                continue;
            }

            try
            {
                Report(frac, $"converting {Path.GetFileName(src)}");

                bool needsBlender = !src.EndsWith(".obj", StringComparison.OrdinalIgnoreCase)
                                    || new FileInfo(src).Length > 12 * 1024 * 1024;

                if (needsBlender)
                {
                    if (blender is null)
                    {
                        Report(frac, $"skipping {Path.GetFileName(src)} - Blender not found");
                        continue;
                    }
                    RunBlenderConvert(blender, src, outFile, targetTriangles);
                }
                else
                {
                    File.Copy(src, outFile, overwrite: true);
                }

                if (!File.Exists(outFile)) continue;

                var (tris, min, max) = MeasureObj(outFile);
                if (tris == 0) { File.Delete(outFile); continue; }

                var entry = new AssetEntry(
                    id, Path.GetFileNameWithoutExtension(src), Path.GetFileName(outFile),
                    tris, min, max, InferTags(src), src);

                result.Add(entry);
                Report(frac, $"{id} - {tris:N0} triangles");
            }
            catch (Exception e)
            {
                // A single unconvertible model must not abort the whole catalogue.
                Report(frac, $"{Path.GetFileName(src)} failed: {Trunc(e.Message, 90)}");
            }
        }

        Save(result);
        Report(1, $"{result.Count} assets ready");
        return result;
    }

    static string MakeId(string path, string root)
    {
        var rel = Path.GetRelativePath(root, path);
        var dir = Path.GetDirectoryName(rel);
        var name = string.IsNullOrEmpty(dir) || dir == "."
            ? Path.GetFileNameWithoutExtension(rel)
            : dir.Split(Path.DirectorySeparatorChar)[0];

        var cleaned = new string(name.ToLowerInvariant()
            .Select(c => char.IsLetterOrDigit(c) ? c : '-').ToArray());
        while (cleaned.Contains("--")) cleaned = cleaned.Replace("--", "-");
        return cleaned.Trim('-');
    }

    /// Import anything Blender reads, join it, decimate to a triangle budget and
    /// write a plain OBJ. Runs headless so nothing appears on screen.
    static void RunBlenderConvert(string blender, string src, string outFile, int targetTriangles)
    {
        var script = Path.Combine(Path.GetTempPath(), $"i3d_conv_{Guid.NewGuid():N}.py");
        var srcPy = src.Replace("\\", "/");
        var outPy = outFile.Replace("\\", "/");
        var ext = Path.GetExtension(src).ToLowerInvariant();

        var load = ext switch
        {
            ".blend" => $"bpy.ops.wm.open_mainfile(filepath=r'{srcPy}')",
            ".obj" => $"bpy.ops.wm.read_factory_settings(use_empty=True)\n" +
                      $"bpy.ops.wm.obj_import(filepath=r'{srcPy}')",
            ".fbx" => $"bpy.ops.wm.read_factory_settings(use_empty=True)\n" +
                      $"bpy.ops.import_scene.fbx(filepath=r'{srcPy}')",
            _ => throw new NotSupportedException($"cannot import {ext}"),
        };

        File.WriteAllText(script, $"""
            import bpy, sys

            {load}

            # Drop everything that is not renderable geometry - cameras, lights and
            # empties would otherwise survive into the export as stray objects.
            for ob in list(bpy.data.objects):
                if ob.type != 'MESH':
                    bpy.data.objects.remove(ob, do_unlink=True)

            meshes = [o for o in bpy.data.objects if o.type == 'MESH']
            if not meshes:
                sys.exit(0)

            for ob in meshes:
                ob.hide_viewport = False
                ob.hide_set(False)

            total = sum(len(o.data.polygons) for o in meshes)
            target = {targetTriangles}

            # Decimate proportionally so the whole asset lands inside the budget.
            if total > target:
                ratio = max(0.02, target / float(total))
                for ob in meshes:
                    if len(ob.data.polygons) < 200:
                        continue
                    m = ob.modifiers.new('i3d_decimate', 'DECIMATE')
                    m.ratio = ratio
                    bpy.context.view_layer.objects.active = ob
                    try:
                        bpy.ops.object.modifier_apply(modifier=m.name)
                    except Exception:
                        pass

            bpy.ops.object.select_all(action='SELECT')
            bpy.ops.wm.obj_export(
                filepath=r'{outPy}',
                export_selected_objects=True,
                export_materials=False,
                export_uv=False,
                export_normals=True,
                export_triangulated_mesh=True,
                forward_axis='NEGATIVE_Z',
                up_axis='Y')
            """);

        var psi = new ProcessStartInfo(blender,
            $"--background --factory-startup --python \"{script}\"")
        {
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
            CreateNoWindow = true,
        };

        using var p = Process.Start(psi) ?? throw new Exception("could not start Blender");
        var so = p.StandardOutput.ReadToEndAsync();
        var se = p.StandardError.ReadToEndAsync();

        // Blender occasionally hangs on a corrupt file; do not wait forever.
        if (!p.WaitForExit(10 * 60 * 1000))
        {
            try { p.Kill(entireProcessTree: true); } catch { }
            throw new Exception("Blender timed out after 10 minutes");
        }

        Task.WaitAll(so, se);
        File.Delete(script);

        if (p.ExitCode != 0)
            throw new Exception($"Blender exited {p.ExitCode}: {Trunc(se.Result, 200)}");
    }

    /// Count triangles and find the bounding box without loading the whole file
    /// into memory - these OBJs run to tens of megabytes.
    static (int Triangles, float[] Min, float[] Max) MeasureObj(string path)
    {
        int tris = 0;
        var min = new[] { float.MaxValue, float.MaxValue, float.MaxValue };
        var max = new[] { float.MinValue, float.MinValue, float.MinValue };

        foreach (var line in File.ReadLines(path))
        {
            if (line.StartsWith("v ", StringComparison.Ordinal))
            {
                var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length < 4) continue;
                for (int k = 0; k < 3; k++)
                {
                    if (!float.TryParse(parts[k + 1], NumberStyles.Float, CultureInfo.InvariantCulture, out var v))
                        continue;
                    if (v < min[k]) min[k] = v;
                    if (v > max[k]) max[k] = v;
                }
            }
            else if (line.StartsWith("f ", StringComparison.Ordinal))
            {
                int verts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries).Length - 1;
                if (verts >= 3) tris += verts - 2;   // fan triangulation
            }
        }

        if (tris == 0) return (0, [0, 0, 0], [0, 0, 0]);
        return (tris, min, max);
    }

    static string Trunc(string s, int n) =>
        string.IsNullOrEmpty(s) ? "" : s.Length <= n ? s : s[..n] + "...";
}
