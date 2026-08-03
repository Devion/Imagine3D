namespace Imagine3D.Lyrics;

/// Parsed sidecar ".txt": the author's explicit Style:/Negative: directives split
/// out from the lyric body. Directives are AUTHORITATIVE - they are woven into
/// every prompt and palette decision so the look can't drift across the video.
/// Ported from Mp3ToVid, where this behaviour was already proven.
public sealed record SongText(string Style, string Negative, string Lyrics)
{
    static readonly string[] StyleKeys = ["style:", "look:", "aesthetic:", "visual:"];
    static readonly string[] NegKeys = ["negative:", "avoid:", "no:"];

    public static SongText Parse(string? raw)
    {
        var styles = new List<string>();
        var negs = new List<string>();
        var body = new List<string>();

        foreach (var line in (raw ?? "").Replace("\r\n", "\n").Split('\n'))
        {
            var t = line.TrimStart();

            var sk = StyleKeys.FirstOrDefault(k => t.StartsWith(k, StringComparison.OrdinalIgnoreCase));
            if (sk is not null) { Add(styles, t[sk.Length..]); continue; }

            var nk = NegKeys.FirstOrDefault(k => t.StartsWith(k, StringComparison.OrdinalIgnoreCase));
            if (nk is not null) { Add(negs, t[nk.Length..]); continue; }

            body.Add(line);
        }

        return new SongText(
            string.Join(", ", styles),
            string.Join(", ", negs),
            string.Join("\n", body).Trim());

        static void Add(List<string> list, string value)
        {
            value = value.Trim();
            if (value.Length > 0) list.Add(value);
        }
    }

    /// Layer style directives, broadest first: author (authoritative) -> global
    /// look -> this section's variation. The author's tokens are ALWAYS present.
    public static string ComposeStyle(params string?[] parts)
    {
        var kept = new List<string>();
        foreach (var raw in parts)
        {
            var p = (raw ?? "").Trim().TrimEnd('.', ' ');
            if (p.Length == 0) continue;
            if (kept.Any(k => k.Contains(p, StringComparison.OrdinalIgnoreCase))) continue;
            kept.RemoveAll(k => p.Contains(k, StringComparison.OrdinalIgnoreCase));
            kept.Add(p);
        }
        return string.Join(". ", kept);
    }

    public static string ComposeNegative(params string?[] parts)
    {
        var terms = new List<string>();
        foreach (var term in parts.SelectMany(p =>
                     (p ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)))
            if (!terms.Contains(term, StringComparer.OrdinalIgnoreCase))
                terms.Add(term);
        return string.Join(", ", terms);
    }
}
