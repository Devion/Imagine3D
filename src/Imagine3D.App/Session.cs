using Imagine3D.Pipeline;

namespace Imagine3D.App;

/// Process-wide state shared between the HTTP API and the WebSocket: the page's
/// render channel and whatever generation run is currently in flight.
public sealed class Session
{
    readonly Lock _gate = new();
    readonly Queue<string> _log = new();
    RenderChannel? _channel;
    CancellationTokenSource? _running;

    public string? CurrentProject { get; set; }

    /// Last failure, surfaced through /api/health so a stalled run can be
    /// diagnosed without the page attached.
    public string? LastError { get; private set; }

    public void Fail(string message)
    {
        lock (_gate) LastError = message;
        Log($"FAILED: {message}");
    }

    public void Log(string line)
    {
        lock (_gate)
        {
            _log.Enqueue($"{DateTime.Now:HH:mm:ss} {line}");
            while (_log.Count > 60) _log.Dequeue();
        }
    }

    public string[] RecentLog()
    {
        lock (_gate) return _log.ToArray();
    }

    public RenderChannel? Channel
    {
        get { lock (_gate) return _channel; }
        set { lock (_gate) _channel = value; }
    }

    public bool IsBusy
    {
        get { lock (_gate) return _running is not null; }
    }

    /// Wait for the page to attach a channel that is not `previous`.
    /// Used after asking the page to reload, so a caller can resume once the
    /// fresh document has connected rather than talking to a dead socket.
    public async Task<RenderChannel?> WaitForNewChannelAsync(RenderChannel? previous, TimeSpan timeout)
    {
        var deadline = DateTime.UtcNow + timeout;
        while (DateTime.UtcNow < deadline)
        {
            var ch = Channel;
            if (ch is { IsOpen: true } && !ReferenceEquals(ch, previous)) return ch;
            await Task.Delay(150);
        }
        return null;
    }

    /// Claim the single generation slot and run `work` on the thread pool.
    /// Returns null on success, or why it was refused.
    ///
    /// The slot is held until the run has actually finished unwinding, cancelled
    /// or not: a cancelled render is still driving the page for as long as it
    /// takes to stop, and a second one starting in that window would talk over it
    /// on the one render channel.
    public string? TryStartRun(Func<CancellationToken, Task> work)
    {
        lock (_gate)
        {
            if (_running is not null)
                return _running.IsCancellationRequested
                    ? "The previous run is still stopping - give it a moment."
                    : "A generation run is already in progress.";

            var cts = new CancellationTokenSource();
            _running = cts;

            _ = Task.Run(async () =>
            {
                try { await work(cts.Token); }
                finally
                {
                    lock (_gate)
                    {
                        if (ReferenceEquals(_running, cts)) _running = null;
                        cts.Dispose();
                    }
                }
            });

            return null;
        }
    }

    public void Cancel()
    {
        lock (_gate) _running?.Cancel();
    }

    /// Push a progress tick to the page. Fire-and-forget: a dropped progress
    /// message must never stall or fail the actual generation.
    public IProgress<StageProgress> ProgressSink() => new Progress<StageProgress>(p =>
    {
        Log($"[{p.Stage}] {p.Fraction:P0} {p.Detail}");
        var ch = Channel;
        if (ch is null || !ch.IsOpen) return;
        _ = ch.SendJsonAsync(new
        {
            cmd = "progress",
            stage = p.Stage.ToString().ToLowerInvariant(),
            fraction = p.Fraction,
            detail = p.Detail,
            thumbnail = p.Thumbnail,
            failed = p.Failed,
        });
    });
}
