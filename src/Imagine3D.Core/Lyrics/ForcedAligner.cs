using System.Text.RegularExpressions;

namespace Imagine3D.Lyrics;

public sealed record AlignedLine(int Index, double Start, double End, string Text, bool Anchored);

public sealed record AlignmentResult(
    AlignedLine[] Lines,
    int AnchoredLines,
    int TotalLines,
    int MatchedWords,
    int TranscribedWords)
{
    /// Fraction of lyric lines that got a real timestamp from the audio rather
    /// than an interpolated guess. Surfaced in the UI so the timing can be
    /// trusted or not on evidence.
    public double Coverage => TotalLines == 0 ? 0 : AnchoredLines / (double)TotalLines;
}

/// Times the author's lyrics against a Whisper transcript.
///
/// The transcript of a dense mix is unreliable - on the test song fewer than half
/// its words are right. That does not matter: the author's lyrics are the truth
/// for *what* is sung, and the transcript only has to be right often enough to
/// say *when*. Sequence alignment finds those agreements, they become anchors,
/// and everything between them is interpolated.
public static partial class ForcedAligner
{
    [GeneratedRegex(@"[a-z0-9']+")]
    private static partial Regex WordRe();

    static string[] Tokenize(string text) =>
        WordRe().Matches(text.ToLowerInvariant()).Select(m => m.Value).ToArray();

    /// Similarity of two words, tuned for mishearings rather than typos:
    /// exact match dominates, near-misses still count, everything else is a miss.
    static int Score(string a, string b)
    {
        if (a == b) return 6;
        if (a.Length >= 4 && b.Length >= 4 && a[..3] == b[..3]) return 3;

        int d = Levenshtein(a, b, max: 2);
        if (d == 1) return 3;
        if (d == 2 && Math.Min(a.Length, b.Length) >= 5) return 1;
        return -3;
    }

    static int Levenshtein(string a, string b, int max)
    {
        if (Math.Abs(a.Length - b.Length) > max) return max + 1;

        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;

        for (int i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            int rowMin = cur[0];
            for (int j = 1; j <= b.Length; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Math.Min(Math.Min(cur[j - 1] + 1, prev[j] + 1), prev[j - 1] + cost);
                rowMin = Math.Min(rowMin, cur[j]);
            }
            if (rowMin > max) return max + 1;   // early out
            (prev, cur) = (cur, prev);
        }
        return prev[b.Length];
    }

    /// Needleman-Wunsch over the two word sequences. Returns, for each authored
    /// word index, the transcript word index it aligned to, or -1.
    static int[] Align(string[] authored, string[] heard)
    {
        const int gap = -2;
        int n = authored.Length, m = heard.Length;

        // Score matrix as rows of ints; n*m is ~600x500 on a full song.
        var score = new int[n + 1, m + 1];
        var back = new byte[n + 1, m + 1];   // 0 diag, 1 up (gap in heard), 2 left

        for (int i = 1; i <= n; i++) { score[i, 0] = i * gap; back[i, 0] = 1; }
        for (int j = 1; j <= m; j++) { score[0, j] = j * gap; back[0, j] = 2; }

        for (int i = 1; i <= n; i++)
        for (int j = 1; j <= m; j++)
        {
            int diag = score[i - 1, j - 1] + Score(authored[i - 1], heard[j - 1]);
            int up = score[i - 1, j] + gap;
            int left = score[i, j - 1] + gap;

            if (diag >= up && diag >= left) { score[i, j] = diag; back[i, j] = 0; }
            else if (up >= left) { score[i, j] = up; back[i, j] = 1; }
            else { score[i, j] = left; back[i, j] = 2; }
        }

        var map = new int[n];
        Array.Fill(map, -1);

        int x = n, y = m;
        while (x > 0 && y > 0)
        {
            switch (back[x, y])
            {
                case 0:
                    // Only treat it as an anchor when the words genuinely agree;
                    // the traceback also runs through poor pairings.
                    if (Score(authored[x - 1], heard[y - 1]) >= 3) map[x - 1] = y - 1;
                    x--; y--;
                    break;
                case 1: x--; break;
                default: y--; break;
            }
        }

        return map;
    }

    /// Which transcribed words are trustworthy enough to anchor a lyric line.
    ///
    /// Whisper's absolute no-speech probability is useless on music - it sits
    /// around 0.84 for a *sung* track, because singing does not sound like
    /// speech to it. Only its spread within a song carries information, so the
    /// threshold is derived from this song's own distribution. Per-word
    /// probability and segment log-probability are meaningful on their own and
    /// are used directly.
    static bool[] Reliability(WordStamp[] heard)
    {
        var mask = new bool[heard.Length];
        if (heard.Length == 0) return mask;

        var sorted = heard.Select(h => h.NoSpeech).OrderBy(x => x).ToArray();
        double p80 = sorted[Math.Clamp((int)(sorted.Length * 0.80), 0, sorted.Length - 1)];

        for (int i = 0; i < heard.Length; i++)
        {
            var h = heard[i];
            if (h.Prob <= 0.35) continue;          // the model was guessing
            if (h.LogProb <= -0.9) continue;       // whole segment was a guess
            // Least speech-like passages in this song, and not a confident word:
            // most likely invented over an instrumental break.
            if (h.NoSpeech >= p80 && h.Prob < 0.75) continue;
            mask[i] = true;
        }
        return mask;
    }

    /// Drop anchors that disagree with the overall shape of the song.
    ///
    /// A single confidently-mistranscribed word in an instrumental passage will
    /// otherwise drag every line interpolated around it. Residuals are measured
    /// against a straight fit of time against word index and scaled by the
    /// median absolute deviation, so a song with long gaps is not punished for
    /// being non-linear - only genuine outliers are.
    static void RejectOutliers(double[] times, bool[] anchored)
    {
        for (int pass = 0; pass < 2; pass++)
        {
            var idx = Enumerable.Range(0, times.Length).Where(i => anchored[i]).ToArray();
            if (idx.Length < 6) return;

            double meanX = idx.Average(i => (double)i);
            double meanY = idx.Average(i => times[i]);
            double num = idx.Sum(i => (i - meanX) * (times[i] - meanY));
            double den = idx.Sum(i => (i - meanX) * (i - meanX));
            if (den < 1e-9) return;

            double slope = num / den;
            double intercept = meanY - slope * meanX;

            var residuals = idx.Select(i => Math.Abs(times[i] - (slope * i + intercept))).ToArray();
            var ordered = residuals.OrderBy(x => x).ToArray();
            double mad = ordered[ordered.Length / 2];
            double limit = Math.Max(8.0, mad * 3.0);

            bool dropped = false;
            for (int k = 0; k < idx.Length; k++)
                if (residuals[k] > limit) { anchored[idx[k]] = false; dropped = true; }

            if (!dropped) return;
        }
    }

    /// Nobody sings twelve words a second.
    ///
    /// Outlier rejection against a straight fit misses *clusters* of bad anchors
    /// that agree with each other, which show up as many lyric lines squeezed
    /// into a second of audio. Requiring a plausible minimum time per word
    /// between consecutive anchors catches exactly that, and the less confident
    /// of an implausible pair is the one dropped.
    static void EnforceRate(double[] times, bool[] anchored, int[] map, WordStamp[] heard)
    {
        const double MinSecondsPerWord = 0.10;

        bool changed = true;
        for (int pass = 0; pass < 4 && changed; pass++)
        {
            changed = false;
            var idx = Enumerable.Range(0, times.Length).Where(i => anchored[i]).ToArray();

            for (int k = 0; k + 1 < idx.Length; k++)
            {
                int i0 = idx[k], i1 = idx[k + 1];
                double needed = (i1 - i0) * MinSecondsPerWord;
                if (times[i1] - times[i0] >= needed) continue;

                // Keep whichever word the model was more sure of.
                double c0 = map[i0] >= 0 ? heard[map[i0]].Prob : 0;
                double c1 = map[i1] >= 0 ? heard[map[i1]].Prob : 0;
                anchored[c0 >= c1 ? i1 : i0] = false;
                changed = true;
                break;
            }
        }
    }

    /// <param name="lines">Author's lyric lines, in order, markers excluded.</param>
    /// <param name="heard">Whisper's word timeline.</param>
    /// <param name="duration">Song length, for clamping.</param>
    public static AlignmentResult AlignLines(
        IReadOnlyList<string> lines, WordStamp[] heard, double duration)
    {
        if (lines.Count == 0 || heard.Length == 0)
            return new AlignmentResult([], 0, lines.Count, 0, heard.Length);

        // Flatten the authored lines to a word stream, remembering which line
        // each word came from.
        var authored = new List<string>();
        var ownerLine = new List<int>();
        for (int i = 0; i < lines.Count; i++)
            foreach (var w in Tokenize(lines[i])) { authored.Add(w); ownerLine.Add(i); }

        if (authored.Count == 0)
            return new AlignmentResult([], 0, lines.Count, 0, heard.Length);

        var reliable = Reliability(heard);

        // Unreliable words stay in the sequence so the alignment keeps its shape,
        // but they are blanked so they cannot match anything and become anchors.
        var heardWords = heard
            .Select((h, i) => reliable[i] ? Tokenize(h.Word).FirstOrDefault() ?? "" : "")
            .ToArray();
        var map = Align(authored.ToArray(), heardWords);

        // Word times, monotonic. Anchored words take the transcript's timing;
        // the rest are filled in between their neighbours.
        var times = new double[authored.Count];
        var anchored = new bool[authored.Count];
        int matched = 0;

        double last = -1;
        for (int i = 0; i < authored.Count; i++)
        {
            if (map[i] < 0) continue;

            if (!reliable[map[i]]) continue;

            double t = heard[map[i]].Start;
            // Alignment can still emit an out-of-order pair; ignore those rather
            // than letting a single bad anchor drag a whole verse backwards.
            if (t <= last) continue;
            times[i] = t;
            anchored[i] = true;
            last = t;
            matched++;
        }

        RejectOutliers(times, anchored);
        EnforceRate(times, anchored, map, heard);
        matched = anchored.Count(a => a);

        FillGaps(times, anchored, duration);

        // Line spans from their words.
        var result = new AlignedLine[lines.Count];
        int anchoredLines = 0;
        for (int i = 0; i < lines.Count; i++)
        {
            var idx = Enumerable.Range(0, authored.Count).Where(k => ownerLine[k] == i).ToArray();
            if (idx.Length == 0)
            {
                result[i] = new AlignedLine(i, 0, 0, lines[i], false);
                continue;
            }

            double start = times[idx[0]];
            double end = times[idx[^1]];
            bool hasAnchor = idx.Any(k => anchored[k]);
            if (hasAnchor) anchoredLines++;

            // Hold the line a moment past its last word so it stays readable.
            end = Math.Max(end + 0.9, start + 1.2);
            result[i] = new AlignedLine(i, Math.Max(0, start), Math.Min(duration, end),
                lines[i], hasAnchor);
        }

        // A line must not outlive the next line's entrance.
        for (int i = 0; i < result.Length - 1; i++)
            if (result[i].End > result[i + 1].Start && result[i + 1].Start > result[i].Start)
                result[i] = result[i] with { End = result[i + 1].Start };

        return new AlignmentResult(result, anchoredLines, lines.Count, matched, heard.Length);
    }

    /// Interpolate unanchored words between the anchors either side, and
    /// extrapolate at the ends.
    static void FillGaps(double[] times, bool[] anchored, double duration)
    {
        int n = times.Length;
        var anchors = Enumerable.Range(0, n).Where(i => anchored[i]).ToArray();

        if (anchors.Length == 0)
        {
            for (int i = 0; i < n; i++) times[i] = duration * i / n;
            return;
        }

        // Before the first anchor: space words backwards at the local rate.
        double head = anchors[0];
        double rate = anchors.Length > 1
            ? (times[anchors[^1]] - times[anchors[0]]) / Math.Max(1, anchors[^1] - anchors[0])
            : 0.4;
        rate = Math.Clamp(rate, 0.12, 1.5);

        for (int i = 0; i < anchors[0]; i++)
            times[i] = Math.Max(0, times[anchors[0]] - (head - i) * rate);

        for (int a = 0; a < anchors.Length - 1; a++)
        {
            int i0 = anchors[a], i1 = anchors[a + 1];
            double t0 = times[i0], t1 = times[i1];
            for (int i = i0 + 1; i < i1; i++)
                times[i] = t0 + (t1 - t0) * (i - i0) / (double)(i1 - i0);
        }

        for (int i = anchors[^1] + 1; i < n; i++)
            times[i] = Math.Min(duration, times[anchors[^1]] + (i - anchors[^1]) * rate);
    }
}
