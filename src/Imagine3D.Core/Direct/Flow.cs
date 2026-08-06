namespace Imagine3D.Direct;

/// How well two scenes flow into each other.
///
/// The director had one number for this - `Coverage` - and it only answers
/// "will the lights go out". Two effects can be identically bright and still cut
/// badly: a flat plasma into a corridor flight shares nothing but its exposure,
/// and dissolving between them shows you two unrelated pictures at once rather
/// than one becoming the other. Equally, two flights down a tunnel dissolve into
/// each other almost invisibly however different their geometry is, because the
/// eye is tracking the same vanishing point through both.
///
/// A full pairwise table would be the obvious answer and is the wrong one: 58
/// scene effects is 1653 unordered pairs, nobody would maintain it, and adding
/// an effect would mean writing 58 new entries by hand. So each effect declares
/// two properties of its *picture* instead, and the pair score is derived. Adding
/// an effect stays what it has always been - one folder, one manifest.
///
/// The two properties are the ones that decide whether a dissolve reads as
/// continuous. `Motion` is what the frame does, because the eye tracks motion
/// before it reads content. `Focus` is how the frame is organised, because that
/// is where the eye is when the mix starts.
public static class Flow
{
    /// What the picture does over a second. Measured, not guessed: render two
    /// frames a third of a second apart and ask which camera move best explains
    /// the difference (see the motion probe in the docs).
    public const string DepthIn = "depth-in";    // travelling into the frame
    public const string DepthOut = "depth-out";  // falling away from the camera
    public const string Planar = "planar";       // drifting across the frame
    public const string Churn = "churn";         // turbulent, no net direction
    public const string Still = "still";         // barely moves

    /// Where the frame puts the eye.
    public const string Centre = "centre";       // vanishing point or central mass
    public const string Spread = "spread";       // evenly busy across the frame
    public const string Horizon = "horizon";     // banded - ground, sky, a skyline

    /// How much two motions agree, 0..1.
    ///
    /// Opposed travel is the worst case and it is worth being explicit about why:
    /// mixing a shot flying in with one falling away puts two consistent optical
    /// flows on screen at once, and the eye cannot track both. It reads as a
    /// mistake rather than as a transition, which is exactly when a hard cut is
    /// the honest edit. Churn scores middling against everything because it has
    /// no direction to disagree with.
    public static double MotionAgreement(string a, string b)
    {
        if (Same(a, b)) return 1.0;
        if (Pair(a, b, DepthIn, DepthOut)) return 0.00;
        if (Either(a, b, Still)) return 0.20;
        if (Pair(a, b, Churn, Planar)) return 0.40;
        if (Either(a, b, Churn)) return 0.35;    // churn against either depth
        if (Either(a, b, Planar)) return 0.25;   // planar against either depth
        return 0.5;
    }

    /// How much two framings agree, 0..1.
    ///
    /// Centre into horizon is the awkward one: the eye is at the middle of the
    /// frame and the incoming picture puts everything on a band a third of the
    /// way up, so the subject appears to slide out from under it during the mix.
    public static double FocusAgreement(string a, string b)
    {
        if (Same(a, b)) return 1.0;
        if (Pair(a, b, Centre, Horizon)) return 0.15;
        return 0.55;                              // centre/spread, spread/horizon
    }

    /// How well `to` can be mixed out of `from`, 0..1.
    ///
    /// Weighted so motion leads. Coverage is the smallest term of the three
    /// because it is already a hard input elsewhere - Emptying() drives the
    /// cliff rule in the director - and counting it twice at full weight would
    /// make brightness the whole answer again.
    public static double Affinity(EffectManifest? from, EffectManifest to)
    {
        if (from is null) return 0.5;

        double m = MotionAgreement(from.Motion, to.Motion);
        double f = FocusAgreement(from.Focus, to.Focus);

        // Half a unit of coverage apart is as different as it gets; past that
        // the cliff rule is the thing that should be talking, not this.
        double c = 1.0 - Math.Min(1.0, Math.Abs(from.Coverage - to.Coverage) / 0.5);

        return 0.45 * m + 0.30 * f + 0.25 * c;
    }

    /// Whether these two can be *layered*, as opposed to mixed through.
    ///
    /// The same two terms as Affinity, with the coverage gap left out on purpose.
    /// Layering is the tool that exists precisely to cross a coverage gap: the
    /// outgoing scene stays underneath and thins away, so the frame is never
    /// asked to be full and empty in the same instant. Feeding the gap in as a
    /// penalty here would rule out blending exactly where blending is the answer
    /// - which it did, and the emptying-out boundaries came back with the same
    /// blend rate as the level ones instead of twice it.
    public static double LayerAffinity(EffectManifest? from, EffectManifest to)
    {
        if (from is null) return 0.5;
        return 0.6 * MotionAgreement(from.Motion, to.Motion)
             + 0.4 * FocusAgreement(from.Focus, to.Focus);
    }

    /// Below this, layering the two is mush rather than a blend. A blend holds
    /// both pictures on screen for seconds at a time, so it needs them to agree
    /// about considerably more than a one-second dissolve does. Compared against
    /// LayerAffinity, not Affinity.
    public const double BlendFloor = 0.58;

    /// Below this the two pictures share so little that a soft transition just
    /// shows both at once. Cut instead - it is the honest edit, and it is also
    /// the one the eye finds easiest.
    public const double CutBelow = 0.42;

    /// A one-line description of how a boundary between these two should be cut.
    /// Used by the `--flow` report, not by the render path.
    public static string Describe(double affinity) =>
        affinity >= 0.82 ? "flows (long dissolve or layer)"
        : affinity >= BlendFloor ? "blends"
        : affinity >= CutBelow ? "short dissolve"
        : "hard cut";

    static bool Same(string a, string b) => string.Equals(a, b, StringComparison.OrdinalIgnoreCase);
    static bool Either(string a, string b, string x) => Same(a, x) || Same(b, x);
    static bool Pair(string a, string b, string x, string y) =>
        (Same(a, x) && Same(b, y)) || (Same(a, y) && Same(b, x));
}
