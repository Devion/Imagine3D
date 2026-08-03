"""Word-level transcription used to time the author's lyrics.

Run by Imagine3D through ComfyUI's embedded Python, which already ships
openai-whisper and torch. Reads a 16 kHz WAV the app produced with ffmpeg and
writes {"device","words":[{"word","start","end"}...]} as JSON on stdout.

Audio is decoded here with the `wave` module rather than whisper.load_audio() so
whisper never shells out to ffmpeg - the app already has a working ffmpeg, and
passing a decoded array removes a whole class of PATH problems.

The transcript does not need to be accurate. It only has to be right often
enough to give the aligner anchor points; the author's own lyrics remain the
source of truth for the words themselves.
"""

import json
import sys
import wave

import numpy as np


def load_wav(path):
    with wave.open(path, "rb") as w:
        if w.getsampwidth() != 2:
            raise SystemExit(f"expected 16-bit PCM, got {w.getsampwidth() * 8}-bit")
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        data = data.astype(np.float32) / 32768.0
        ch = w.getnchannels()
        if ch > 1:
            data = data.reshape(-1, ch)
        return data, w.getframerate()


def centre_channel(x):
    """Lift the centre-panned vocal out of the mix.

    Vocals sit centred in almost every mix, so mid carries them while side
    carries the wide instruments. Subtracting part of the side attenuates
    guitars and pads without touching the voice.
    """
    if x.ndim == 1:
        return x
    mid = (x[:, 0] + x[:, 1]) * 0.5
    side = (x[:, 0] - x[:, 1]) * 0.5
    return mid - 0.35 * side


def bandpass(x, rate, lo=180.0, hi=4200.0):
    """Restrict to the vocal range so percussion and bass stop competing."""
    spec = np.fft.rfft(x)
    freqs = np.fft.rfftfreq(len(x), 1.0 / rate)
    spec[(freqs < lo) | (freqs > hi)] = 0
    return np.fft.irfft(spec, len(x)).astype(np.float32)


def main():
    if len(sys.argv) < 3:
        raise SystemExit("usage: whisper_align.py <wav> <model> [lang] [prompt-file] [isolate]")

    wav_path = sys.argv[1]
    model_name = sys.argv[2]
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] not in ("", "auto") else None
    prompt_file = sys.argv[4] if len(sys.argv) > 4 else ""
    isolate = (len(sys.argv) > 5 and sys.argv[5] == "1")

    raw, rate = load_wav(wav_path)
    if rate != 16000:
        raise SystemExit(f"expected 16 kHz audio, got {rate}")

    audio = bandpass(centre_channel(raw), rate) if isolate else (
        raw.mean(axis=1) if raw.ndim > 1 else raw)
    audio = np.ascontiguousarray(audio.astype(np.float32))

    prompt = None
    if prompt_file:
        try:
            with open(prompt_file, encoding="utf-8") as f:
                # Whisper's prompt window is small; the opening lines are enough
                # to bias decoding toward this song's vocabulary.
                prompt = f.read().strip()[:850] or None
        except OSError:
            prompt = None

    import torch
    import whisper

    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = whisper.load_model(model_name, device=device)

    result = model.transcribe(
        audio,
        word_timestamps=True,
        language=language,
        initial_prompt=prompt,
        # Music trips the built-in silence/compression heuristics into discarding
        # whole sung passages, so those skips are disabled.
        no_speech_threshold=None,
        compression_ratio_threshold=None,
        condition_on_previous_text=False,
        fp16=(device == "cuda"),
        verbose=False,
    )

    words = []
    for seg in result.get("segments", []):
        # Whisper invents lyrics over instrumental passages. Its own per-segment
        # scores are the cheapest way to tell singing from a piano it decided
        # sounded like speech, so they travel with every word and the aligner
        # decides how much to trust them.
        no_speech = float(seg.get("no_speech_prob", 0.0) or 0.0)
        logprob = float(seg.get("avg_logprob", 0.0) or 0.0)

        for w in seg.get("words", []):
            text = (w.get("word") or "").strip()
            if not text:
                continue
            start, end = float(w["start"]), float(w["end"])
            # Degenerate spans mean the DTW lost the plot for that word; drop
            # them rather than letting them anchor the alignment.
            if end <= start or (end - start) > 3.0:
                continue
            words.append({
                "word": text,
                "start": start,
                "end": end,
                "noSpeech": no_speech,
                "logprob": logprob,
                "prob": float(w.get("probability", 1.0) or 1.0),
            })

    json.dump({"device": device, "model": model_name, "words": words}, sys.stdout)


if __name__ == "__main__":
    main()
