"""Stage 4 groundwork: measure whether speculative dispatch is worth building.

Speculative dispatch means firing ``/analyze`` on ``EagerEndOfTurn`` — Flux's
early, retractable guess that the user has stopped — and discarding the result if
``TurnResumed`` says the guess was wrong. The upside is hiding LLM latency behind
the tail of the user's speech. The cost is a wasted LLM call on every false eager.

Whether that trade is good depends on exactly two measurable quantities, and
neither is documented:

  1. LEAD TIME — how long before ``EndOfTurn`` does ``EagerEndOfTurn`` arrive?
     That is the ceiling on latency we could hide. If it is 80 ms, speculation
     buys nothing against a ~950 ms LLM call.
  2. FALSE-EAGER RATE — what fraction of eager guesses get retracted by
     ``TurnResumed``? That is the wasted-spend multiplier, and it also bounds
     correctness risk (a discarded turn must never reach Qa).

This measures both across the documented ``eager_eot_threshold`` range
(0.3 = fire early/often, 0.9 = fire late/rarely), so the design can pick a
threshold from data instead of taste. It also confirms the transcript at the
eager moment matches the final one — if the eager text is truncated, dispatching
on it would feed ``/analyze`` a partial answer, which is worse than being slow.

Deliberately measurement-only: nothing here dispatches ``/analyze``.

Run:
    cd backend/ai_service
    uv run python -m scripts.probe_eager_eot
"""

from __future__ import annotations

import asyncio
import statistics
import time
import urllib.request
import wave
from collections.abc import AsyncIterator
from pathlib import Path

from app.ai.voice.keyterms import build_keyterms
from app.ai.voice.stt import stream_transcription
from app.core.config import settings

# Two clips, deliberately: a single sample cannot distinguish "speculation is
# unhelpful" from "this one clip has an unusual pause structure". The measured
# results differ sharply between them, which is itself the finding.
SAMPLES: list[tuple[str, str]] = [
    ("https://dpgr.am/spacewalk.wav", "/tmp/grubgroup_flux_sample.wav"),
    ("https://dpgr.am/bueller.wav", "/tmp/gg_bueller.wav"),
]
SAMPLE_URL, SAMPLE_PATH_STR = SAMPLES[0]
SAMPLE_PATH = Path(SAMPLE_PATH_STR)
CHUNK_MS = 20
# The documented range is 0.3-0.9 and must be <= eot_threshold (default 0.7).
THRESHOLDS = [0.3, 0.5, 0.7]
# The measured p50 of the /analyze LLM leg after the Stage 0b fix. The lead time
# is only useful insofar as it hides part of THIS.
ANALYZE_P50_MS = 951.0


def _load_pcm(url: str = SAMPLE_URL, path: Path = SAMPLE_PATH) -> tuple[bytes, int, float]:
    """Fetch a sample once; return (raw PCM, sample_rate, duration_s)."""
    if not path.exists():
        urllib.request.urlretrieve(url, path)  # noqa: S310 (known host)
    with wave.open(str(path), "rb") as wav:
        rate, frames = wav.getframerate(), wav.getnframes()
        return wav.readframes(frames), rate, frames / float(rate)


async def _paced(pcm: bytes, rate: int) -> AsyncIterator[bytes]:
    """Yield PCM in CHUNK_MS slices at real-time pace (never faster)."""
    chunk_bytes = int(rate * (CHUNK_MS / 1000.0)) * 2  # linear16 mono
    for offset in range(0, len(pcm), chunk_bytes):
        yield pcm[offset : offset + chunk_bytes]
        await asyncio.sleep(CHUNK_MS / 1000.0)


async def _run_threshold(
    pcm: bytes, rate: int, threshold: float, keyterms: list[str]
) -> dict:
    """One session at `threshold`; return eager/final timings and transcripts."""
    eagers: list[tuple[float, str]] = []
    resumes: list[float] = []
    finals: list[tuple[float, str]] = []
    counts: dict[str, int] = {}

    async for event in stream_transcription(
        _paced(pcm, rate),
        keyterms=keyterms,
        sample_rate=rate,
        eager_eot_threshold=threshold,
    ):
        now = time.perf_counter()
        counts[event.event] = counts.get(event.event, 0) + 1
        if event.event == "EagerEndOfTurn":
            eagers.append((now, event.transcript))
        elif event.event == "TurnResumed":
            resumes.append(now)
        elif event.is_final:
            finals.append((now, event.transcript))

    # Lead time: for each final, the most recent eager that preceded it.
    leads: list[float] = []
    matched: list[tuple[str, str]] = []
    for final_at, final_text in finals:
        prior = [(t, txt) for t, txt in eagers if t <= final_at]
        if prior:
            eager_at, eager_text = prior[-1]
            leads.append((final_at - eager_at) * 1000.0)
            matched.append((eager_text, final_text))

    return {
        "threshold": threshold,
        "counts": counts,
        "eagers": len(eagers),
        "resumes": len(resumes),
        "finals": len(finals),
        "leads": leads,
        "matched": matched,
    }


def _report(result: dict) -> None:
    """Print one threshold's findings."""
    thr = result["threshold"]
    eagers, resumes = result["eagers"], result["resumes"]
    leads = result["leads"]
    print(f"  --- eager_eot_threshold={thr} ---")
    print(f"      events            : {result['counts']}")
    print(f"      eagers={eagers}  resumed(false)={resumes}  finals={result['finals']}")

    if eagers:
        rate = resumes / eagers * 100.0
        print(f"      false-eager rate  : {rate:.0f}%  (wasted LLM calls)")
    if leads:
        p50 = statistics.median(leads)
        hidden = min(p50, ANALYZE_P50_MS)
        print(
            f"      lead time p50     : {p50:7.1f} ms  "
            f"(hides {hidden / ANALYZE_P50_MS * 100:.0f}% of the {ANALYZE_P50_MS:.0f} ms LLM leg)"
        )
    else:
        print("      lead time         : n/a (no eager preceded a final)")

    # If the eager transcript is truncated, dispatching on it parses a partial answer.
    for eager_text, final_text in result["matched"]:
        same = eager_text.strip() == final_text.strip()
        if same:
            print("      eager text == final text: yes (safe to dispatch on)")
        else:
            shrink = len(final_text) - len(eager_text)
            print(
                f"      eager text != final text: eager is {shrink:+d} chars"
                " -> dispatching on it would parse an INCOMPLETE turn"
            )
            print(f"        eager: {eager_text[-90:]!r}")
            print(f"        final: {final_text[-90:]!r}")
    print()


async def _run() -> int:
    print("=" * 78)
    print("  Stage 4 groundwork — is speculative dispatch worth it?")
    print("=" * 78)
    if not settings.deepgram_api_key:
        print("  ABORT: DEEPGRAM_API_KEY is empty.")
        return 1

    keyterms = await build_keyterms()
    print(f"  keyterms: {len(keyterms)}   /analyze p50 reference: {ANALYZE_P50_MS:.0f} ms")
    print("  NOTE: a few clips is a small sample. Treat rates as directional.")
    print()

    results = []
    for url, path_str in SAMPLES:
        path = Path(path_str)
        pcm, rate, duration = _load_pcm(url, path)
        print(f"  ===== {path.name}: {duration:.1f}s @ {rate} Hz, paced real-time =====")
        for threshold in THRESHOLDS:
            result = await _run_threshold(pcm, rate, threshold, keyterms)
            _report(result)
            results.append(result)

    print("  --- VERDICT ---")
    any_eager = any(r["eagers"] for r in results)
    if not any_eager:
        print("      NO EagerEndOfTurn events at any threshold on this clip.")
        print("      Either the param is not taking effect or this speech has no")
        print("      pause the model scores as a likely turn end. Speculation cannot")
        print("      be designed against unobserved behavior — do NOT build it yet.")
        return 0

    # Judge on the BEST-CASE lead against the SPEND MULTIPLIER it costs. A high
    # lead at a high false rate is not a win: each false eager is a full wasted
    # /analyze call, so the multiplier is 1/(1 - false_rate).
    print(f"      {'threshold':>10}  {'lead p50':>9}  {'hides':>6}  {'false':>6}  {'LLM spend':>10}")
    verdicts: list[tuple[float, float, float]] = []
    for result in results:
        if not result["eagers"]:
            continue
        lead = statistics.median(result["leads"]) if result["leads"] else 0.0
        share = min(lead, ANALYZE_P50_MS) / ANALYZE_P50_MS * 100.0
        false_rate = result["resumes"] / result["eagers"]
        multiplier = 1.0 / max(1.0 - false_rate, 0.01)
        verdicts.append((share, false_rate * 100.0, multiplier))
        print(
            f"      {result['threshold']:>10}  {lead:>7.0f}ms  {share:>5.0f}%  "
            f"{false_rate * 100:>5.0f}%  {multiplier:>9.1f}x"
        )
    print()

    if not verdicts:
        print("      No usable eager samples. Do not build speculation.")
        return 0

    best_share = max(v[0] for v in verdicts)
    # The false rate at the configuration that achieved that best share.
    best_waste = max(v[1] for v in verdicts if v[0] == best_share)
    print(f"      BEST CASE: hides {best_share:.0f}% of the LLM leg at {best_waste:.0f}% wasted calls.")
    if best_share < 25 or best_waste > 40:
        print("      => RECOMMEND SKIPPING speculative dispatch.")
        print("         The lead time is a small fraction of the LLM leg, and the")
        print("         false-eager rate multiplies LLM spend for it. Cheaper wins")
        print("         remain on the LLM leg itself (a faster extraction model),")
        print("         which helps EVERY turn instead of only well-paused ones.")
    else:
        print("      => Worth designing. See the Stage 4 proposal.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_run()))
