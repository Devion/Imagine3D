namespace Imagine3D.Direct;

/// What the LLM stage produces: *intent*, never effect ids. The registry resolves
/// intent into concrete effects, so an offline or rambling LLM degrades to the
/// deterministic scorer instead of breaking the run.
public sealed record Intent(
    string Mood,
    string Palette,
    string Story,
    string[] GlobalTags,
    SectionIntent[] Sections)
{
    public static Intent Empty => new("", "", "", [], []);

    public SectionIntent? For(int index) => Sections.FirstOrDefault(s => s.Index == index);
}

public sealed record SectionIntent(
    int Index,
    string[] Tags,
    string Mood,
    double Intensity,
    string[] TextLines);

/// Derives section tags from the lyrics when no LLM is available. Crude by design -
/// it only has to be better than random, because the energy fit and repetition
/// rules do most of the work in picking a scene.
public static class TagInference
{
    static readonly (string[] Words, string[] Tags)[] Map =
    [
        (["star", "space", "cosmic", "galaxy", "orbit", "moon", "sky", "heaven", "sun"],
            ["space", "cosmic", "vast"]),
        (["fire", "burn", "flame", "ash", "smoke", "heat"],
            ["fire", "warm", "organic"]),
        (["water", "ocean", "sea", "rain", "river", "wave", "drown", "tide"],
            ["water", "fluid", "organic"]),
        (["city", "street", "tower", "empire", "wall", "temple", "build", "concrete"],
            ["city", "urban", "structure"]),
        (["machine", "steel", "metal", "wire", "circuit", "engine", "iron"],
            ["mechanical", "industrial", "retro"]),
        (["dark", "shadow", "night", "black", "grave", "dread", "fear", "cold", "frost"],
            ["dark", "cold", "ominous"]),
        (["light", "bright", "glow", "shine", "dawn", "white", "gold"],
            ["bright", "warm", "glow"]),
        (["dream", "mind", "soul", "spirit", "ghost", "vision", "trance"],
            ["psychedelic", "abstract", "dream"]),
        (["heart", "blood", "bone", "breath", "body", "hand", "eye"],
            ["organic", "intimate"]),
        (["time", "clock", "old", "ancient", "forever", "eternal", "age"],
            ["abstract", "geometric", "vast"]),
        (["war", "fight", "blade", "strike", "break", "shatter"],
            ["aggressive", "glitch", "sharp"]),
    ];

    public static string[] FromText(IEnumerable<string> lines)
    {
        var text = string.Join(" ", lines).ToLowerInvariant();
        var tags = new List<string>();
        foreach (var (words, t) in Map)
            if (words.Any(w => text.Contains(w, StringComparison.Ordinal)))
                foreach (var tag in t)
                    if (!tags.Contains(tag)) tags.Add(tag);
        return tags.ToArray();
    }

    /// Structural markers the author wrote are a strong signal about intensity -
    /// "[drop]" should not render like "[outro]".
    public static string[] FromMarkers(IEnumerable<string> markers)
    {
        var text = string.Join(" ", markers).ToLowerInvariant();
        var tags = new List<string>();
        void Add(params string[] t) { foreach (var x in t) if (!tags.Contains(x)) tags.Add(x); }

        if (text.Contains("drop") || text.Contains("heavy") || text.Contains("intensif"))
            Add("aggressive", "strobe", "high-energy");
        if (text.Contains("build") || text.Contains("rising") || text.Contains("pre-chorus"))
            Add("build", "tension");
        if (text.Contains("intro") || text.Contains("quiet") || text.Contains("whisper"))
            Add("calm", "sparse", "minimal");
        if (text.Contains("outro") || text.Contains("resolv") || text.Contains("fade"))
            Add("calm", "resolve", "soft");
        if (text.Contains("solo") || text.Contains("instrumental") || text.Contains("break"))
            Add("showcase", "abstract");
        if (text.Contains("glitch") || text.Contains("fractur") || text.Contains("metallic"))
            Add("glitch", "sharp", "mechanical");
        if (text.Contains("choir") || text.Contains("ensemble") || text.Contains("string"))
            Add("vast", "cinematic");

        return tags.ToArray();
    }
}
