namespace Imagine3D.Direct;

/// Re-scans the effects folder when anything in it changes.
///
/// Effects are the part of this app that gets edited constantly, and needing an
/// app restart to see a new folder makes writing the library painful. Scanning is
/// a few dozen small JSON reads, so the check is cheap enough to do per request.
public sealed class EffectRegistryProvider(string webRoot)
{
    readonly Lock _gate = new();
    EffectRegistry? _cached;
    DateTime _stamp = DateTime.MinValue;

    public EffectRegistry Current
    {
        get
        {
            lock (_gate)
            {
                var latest = LatestWrite();
                if (_cached is null || latest > _stamp)
                {
                    _cached = EffectRegistry.Load(webRoot);
                    _stamp = latest;
                }
                return _cached;
            }
        }
    }

    DateTime LatestWrite()
    {
        var dir = Path.Combine(webRoot, "effects");
        if (!Directory.Exists(dir)) return DateTime.MinValue;

        var latest = Directory.GetLastWriteTimeUtc(dir);
        foreach (var sub in Directory.EnumerateDirectories(dir))
        {
            var manifest = Path.Combine(sub, "effect.json");
            if (!File.Exists(manifest)) continue;
            var t = File.GetLastWriteTimeUtc(manifest);
            if (t > latest) latest = t;
        }
        return latest;
    }
}
