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

    /// How much of the frame this effect lights up, 0..1. `apollonian` is 0.29,
    /// `spectrum` 0.70, `ifstunnel` 0.72.
    ///
    /// Nothing to do with energy or quality - it is area and brightness, and it
    /// exists because a cut from a frame that is full of light to one that is
    /// mostly black reads as the lights going out however good the transition
    /// is. Half the picture was never there to be wiped. The director cannot see
    /// what an effect looks like, so this is where the effect says.
    ///
    /// Measured rather than guessed: render the effect off-screen with mid-energy
    /// music values and take 0.6 * the fraction of the frame meaningfully above
    /// its own darkest tenth, plus 0.4 * mean luminance, averaged over two
    /// palettes and four moments. Neither half is enough alone: `water` is a
    /// full-frame ripple with almost no local contrast, `ifsmorph` a small solid
    /// on a bright wash.
    ///
    /// Re-measure whenever a shader changes character. Hand-written values drift
    /// badly - before the last sweep the declared numbers were out by up to 0.44,
    /// and one effect declared 0.10 while rendering black on every frame, which
    /// is exactly the kind of thing a number nobody checks will hide.
    public double Coverage { get; init; } = 0.6;

    /// What the picture does over a second: depth-in | depth-out | planar |
    /// churn | still. See Flow, which pairs this with the outgoing scene's to
    /// decide whether a boundary can be dissolved or wants a cut.
    ///
    /// Measured rather than guessed: render two frames a third of a second
    /// apart and ask which camera move best explains the difference. An effect
    /// that changes a great deal and travels nowhere is `churn`, and the
    /// distinction matters - the eye tracks travel, not change.
    public string Motion { get; init; } = "churn";

    /// How the frame is organised: centre | spread | horizon. Where the eye is
    /// when a mix starts, which is the other half of whether the mix reads.
    public string Focus { get; init; } = "spread";

    /// low | medium | high - render cost, used to stay inside a frame budget.
    public string Cost { get; init; } = "low";

    /// How much screen time this effect should get relative to how well it scores,
    /// as a multiplier on its odds of being picked. 1 is neutral, 0.25 is a quarter
    /// as often, 2 is twice.
    ///
    /// Fit and rarity are different questions and the scorer cannot answer the
    /// second from the first. `lightning` - since removed - was the library's
    /// high-energy specialist, and roughly half of every song analysed here sits
    /// above 0.8, so it correctly won loud sections; correctly winning them in
    /// every video is still wrong, because it was an accent, not a scene you hold
    /// for twenty seconds. This is where an effect says so, next to the shader,
    /// rather than the director carrying a list of ids it has opinions about.
    public double Rarity { get; init; } = 1.0;

    /// This effect draws one of the project's images rather than merely being
    /// allowed to - uImage is bound for every pass of a scene that has a cue, so
    /// any effect *may* sample it, and this is the ones that fall apart without.
    ///
    /// Two consequences, both of which are the point of declaring it. The director
    /// will not pick the effect at all for a project with no images, because an
    /// image effect with no image renders a black frame. And when it does pick it,
    /// that scene is given a cue whether or not the density asked for one, and the
    /// cue composites nothing on its own: the effect is already showing the
    /// picture, so laying it behind or over as well would show it twice.
    public bool UsesImage { get; init; }

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

    /// Rarity as a score offset. The director samples in proportion to
    /// exp(score / temperature), so adding this multiplies the odds of being picked
    /// by exactly Rarity - which is what makes the manifest number mean something
    /// you can predict rather than a knob that has to be tuned by eye.
    public double RarityBias(double temperature) =>
        temperature * Math.Log(Math.Clamp(Rarity, 0.02, 5.0));

    [JsonIgnore] public double EnergyLo => EnergyRange.Length > 0 ? EnergyRange[0] : 0;
    [JsonIgnore] public double EnergyHi => EnergyRange.Length > 1 ? EnergyRange[1] : 1;

    public bool FitsEnergy(double energy, double slack = 0.15) =>
        energy >= EnergyLo - slack && energy <= EnergyHi + slack;

    /// How far outside its declared band this energy sits. 0 when inside.
    public double EnergyMiss(double energy) =>
        energy < EnergyLo ? EnergyLo - energy
        : energy > EnergyHi ? energy - EnergyHi
        : 0;
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
