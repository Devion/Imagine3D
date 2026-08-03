using Imagine3D.Audio;

namespace Imagine3D.Lyrics;

/// The sidecar .txt carries no timestamps, so lyrics are placed structurally:
/// bracketed [markers] are treated as section headers the author already wrote and
/// are anchored to detected section boundaries; the plain lines between two markers
/// are then spread linearly across that span.
///
/// This is deliberately approximate. Whisper forced alignment is the upgrade path
/// when word-accurate timing is wanted; for choosing *which scene plays when*, the
/// structural mapping is enough.
public static class LyricAligner
{
    /// Split the sidecar body into the sung lines and the bracketed markers,
    /// preserving their original order.
    public static (string Text, bool IsMarker)[] Entries(SongText song) =>
        song.Lyrics.Replace("\r\n", "\n").Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .Select(l => (Text: l, IsMarker: l.StartsWith('[') && l.EndsWith(']')))
            .ToArray();

    /// Time the lyrics against Whisper's word timeline.
    ///
    /// Only the sung lines are aligned - bracketed markers are stage directions
    /// that are never sung, so they are placed between their neighbouring lines
    /// afterwards rather than competing for anchors.
    public static (LyricLine[] Lines, double Coverage) AlignForced(
        SongText song, WordStamp[] heard, double duration)
    {
        var entries = Entries(song);
        var sungIdx = Enumerable.Range(0, entries.Length).Where(i => !entries[i].IsMarker).ToArray();
        var sung = sungIdx.Select(i => entries[i].Text).ToList();

        if (sung.Count == 0 || heard.Length == 0) return ([], 0);

        var result = ForcedAligner.AlignLines(sung, heard, duration);
        var timed = new LyricLine?[entries.Length];

        for (int k = 0; k < sungIdx.Length; k++)
        {
            var l = result.Lines[k];
            timed[sungIdx[k]] = new LyricLine(l.Start, l.End, l.Text, false);
        }

        // Markers sit just before the next sung line they precede, so a section
        // tag still lands where its passage begins.
        for (int i = 0; i < entries.Length; i++)
        {
            if (timed[i] is not null) continue;
            double next = duration;
            for (int j = i + 1; j < entries.Length; j++)
                if (timed[j] is { } t) { next = t.Start; break; }
            double prev = 0;
            for (int j = i - 1; j >= 0; j--)
                if (timed[j] is { } t) { prev = t.End; break; }

            double at = Math.Clamp(next - 0.35, prev, duration);
            timed[i] = new LyricLine(at, Math.Min(duration, at + 1.2), entries[i].Text, true);
        }

        return (timed.Select(t => t!).OrderBy(l => l.Start).ToArray(), result.Coverage);
    }

    public static LyricLine[] Align(SongText song, Section[] sections)
    {
        if (sections.Length == 0 || string.IsNullOrWhiteSpace(song.Lyrics)) return [];
        double duration = sections[^1].End;

        var entries = song.Lyrics
            .Replace("\r\n", "\n").Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.Length > 0)
            .Select(l => (Text: l, IsMarker: l.StartsWith('[') && l.EndsWith(']')))
            .ToList();
        if (entries.Count == 0) return [];

        // Baseline: spread every entry evenly over the song. This alone is a decent
        // first approximation and is what a song with no markers gets.
        double Baseline(int i) => duration * i / entries.Count;

        // Then pull each marker toward the nearest section boundary, but only when
        // that boundary is close to where the marker already wanted to be and the
        // move keeps the anchors properly spaced.
        //
        // Anchoring markers *directly* onto section starts (the obvious approach)
        // fails badly when markers outnumber sections - several markers land on the
        // same start and the lyrics between them get crushed into a fraction of a
        // second. Snapping-with-tolerance degrades gracefully instead.
        double snapTolerance = Math.Max(6.0, duration / Math.Max(1, entries.Count) * 3);
        double minSpacing = 0.4;

        var anchors = new SortedDictionary<int, double> { [0] = 0 };
        double prev = 0;

        for (int i = 0; i < entries.Count; i++)
        {
            if (!entries[i].IsMarker) continue;

            double want = Baseline(i);
            double nearest = want;
            double bestDist = double.MaxValue;
            foreach (var s in sections)
            {
                double d = Math.Abs(s.Start - want);
                if (d < bestDist) { bestDist = d; nearest = s.Start; }
            }

            double t = bestDist <= snapTolerance ? nearest : want;
            t = Math.Max(prev + minSpacing, t);
            if (t >= duration - minSpacing) break; // out of song; leave the rest to the tail

            anchors[i] = t;
            prev = t;
        }

        anchors[entries.Count] = duration;

        var lines = new List<LyricLine>();
        var keys = anchors.Keys.ToList();
        for (int a = 0; a < keys.Count - 1; a++)
        {
            int i0 = keys[a], i1 = keys[a + 1];
            double t0 = anchors[i0], t1 = anchors[i1];
            int span = Math.Max(1, i1 - i0);

            for (int i = i0; i < i1 && i < entries.Count; i++)
            {
                double f0 = (i - i0) / (double)span;
                double f1 = (i - i0 + 1) / (double)span;
                lines.Add(new LyricLine(
                    t0 + (t1 - t0) * f0,
                    t0 + (t1 - t0) * f1,
                    entries[i].Text,
                    entries[i].IsMarker));
            }
        }

        return lines.OrderBy(l => l.Start).ToArray();
    }

    /// Fold the aligned lines back into their sections, so the director can read a
    /// section's lyrics and markers without re-scanning the timeline.
    public static Section[] AttachToSections(Section[] sections, LyricLine[] lines)
    {
        return sections.Select(s =>
        {
            var inSection = lines.Where(l => l.Start >= s.Start && l.Start < s.End).ToArray();
            return s with
            {
                Markers = inSection.Where(l => l.IsMarker).Select(l => l.Text).ToArray(),
                Lyrics = inSection.Where(l => !l.IsMarker).Select(l => l.Text).ToArray(),
            };
        }).ToArray();
    }
}
