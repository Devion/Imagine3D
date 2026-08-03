using System.Text.Json;
using System.Text.Json.Serialization;

namespace Imagine3D.Direct;

/// What an effect declares about itself. The same effect.json is read by the
/// browser (to load the effect) and by the director (to decide whether to pick it),
/// so there is exactly one source of truth per effect.
public sealed record EffectManifest
{
    public string Id { get; init; } = "";
    public string Name { get; init; } = "";

    /// scene2d | scene3d | raymarch | post | transition | text | ltx
    public string Kind { get; init; } = "scene2d";

    public string[] Tags { get; init; } = [];

    /// Song energy this effect suits, 0..1. A gentle plasma is [0,0.6]; a strobing
    /// glitch is [0.7,1].
    public double[] EnergyRange { get; init; } = [0, 1];

    public string[] Aspects { get; init; } = ["16:9", "9:16"];

    /// low | medium | high - render cost, used to stay inside a frame budget.
    public string Cost { get; init; } = "low";

    public Dictionary<string, EffectParam> Params { get; init; } = [];

    public string Description { get; init; } = "";

    /// Effects that clash with this one and must not be stacked together.
    public string[] Conflicts { get; init; } = [];

    /// Fragment shader filename inside the effect's folder. The common case: an
    /// effect is a manifest plus a .frag and needs no JavaScript at all.
    public string Shader { get; init; } = "shader.frag";

    /// Set for effects that need real code (three.js scenes, geometry, feedback
    /// buffers). The loader then imports effects/<id>/effect.js instead.
    public bool Module { get; init; }

    /// Newest file timestamp in the effect's folder, as a cache-busting token.
    /// The browser caches ES modules and fetched shaders aggressively, so without
    /// this an edited effect keeps rendering its old code until a full reload.
    public long Rev { get; set; }

    [JsonIgnore]
    public double CostWeight => Cost switch { "high" => 3, "medium" => 1.6, _ => 1 };

    public bool SupportsAspect(string aspect) => Aspects.Length == 0 || Aspects.Contains(aspect);

    public bool FitsEnergy(double energy)
    {
        double lo = EnergyRange.Length > 0 ? EnergyRange[0] : 0;
        double hi = EnergyRange.Length > 1 ? EnergyRange[1] : 1;
        return energy >= lo - 0.15 && energy <= hi + 0.15;
    }
}

public sealed record EffectParam
{
    /// float | int | bool | color | string
    public string Type { get; init; } = "float";

    /// Default is an *expression* string, e.g. "1.0 + 0.3*beatPulse".
    public string Default { get; init; } = "0";

    public double Min { get; init; }
    public double Max { get; init; } = 1;
    public string Description { get; init; } = "";
}

/// Discovers effects by globbing effects/*/effect.json under the web root.
/// Adding an effect is one new folder - nothing here needs editing.
public sealed class EffectRegistry
{
    readonly Dictionary<string, EffectManifest> _byId = new(StringComparer.OrdinalIgnoreCase);

    public IReadOnlyCollection<EffectManifest> All => _byId.Values;

    public IEnumerable<EffectManifest> OfKind(params string[] kinds) =>
        _byId.Values.Where(e => kinds.Contains(e.Kind, StringComparer.OrdinalIgnoreCase));

    public EffectManifest? Get(string id) => _byId.GetValueOrDefault(id);

    public static EffectRegistry Load(string webRoot)
    {
        var reg = new EffectRegistry();
        var dir = Path.Combine(webRoot, "effects");
        if (!Directory.Exists(dir)) return reg;

        var opts = new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true,
            ReadCommentHandling = JsonCommentHandling.Skip,
            AllowTrailingCommas = true,
        };

        foreach (var manifestPath in Directory.EnumerateFiles(dir, "effect.json", SearchOption.AllDirectories))
        {
            try
            {
                var m = JsonSerializer.Deserialize<EffectManifest>(File.ReadAllText(manifestPath), opts);
                if (m is null || string.IsNullOrWhiteSpace(m.Id)) continue;

                // Newest file in the folder - covers the manifest, the shader and
                // the module, so editing any of them busts the browser's cache.
                var folder = Path.GetDirectoryName(manifestPath)!;
                long rev = 0;
                foreach (var f in Directory.EnumerateFiles(folder))
                {
                    var ticks = File.GetLastWriteTimeUtc(f).Ticks;
                    if (ticks > rev) rev = ticks;
                }
                m.Rev = rev;

                reg._byId[m.Id] = m;
            }
            catch (JsonException e)
            {
                // A broken manifest must not take the whole registry down - the
                // effect simply isn't available and the director works without it.
                Console.Error.WriteLine($"[effects] skipping {manifestPath}: {e.Message}");
            }
        }

        return reg;
    }
}
