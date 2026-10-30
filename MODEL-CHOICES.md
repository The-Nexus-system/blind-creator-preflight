# How the models were chosen — the evidence

Blind Creator Pre-Flight uses four of Meta's models, each assigned to the job the
evidence says it does best. This document is the record of the tests behind those
assignments. Every result below was measured during the event window; nothing is
asserted from reputation alone.

## The assignments

- **Muse Spark (muse-spark-1.3)** — judgement. Reads the media and returns the
  text in the image, the first impression, and the private-information warning,
  as strict structured output the app distrusts and re-checks before use. It
  also drafts the alt text, the proof copy, and the described-audio script, and
  it estimates subject and sign positions when the measuring model cannot see
  them (labelled "measured by Muse Spark's judgement" wherever that happens —
  an estimate is never presented as a measurement).
- **SAM 3.1 (sam-3.1)** — measurement. Locates the subject and the sign and
  returns pixel bounding boxes; framing and crop safety are computed from those
  boxes by the app's own deterministic measurement code.
- **Muse Voice Transcribe (muse-voice-transcribe-1.0)** — the audio check.
  Transcribes a video's speech track; the check judges from the transcript and
  the transcript feeds the proof copy. A take with no audio track is reported
  as silent by design — there is nothing to transcribe, and the silence is part
  of the take, not a defect.
- **Muse Image** — not used in this build. Its designed role is the generative
  still-photo repair (a creator describes a change; the model remakes the
  image). The repairs in this build are deterministic operations the app
  performs and re-measures itself, so no generative model edits the media.

## Test 1 — Is our SAM request shape correct, and is SAM accurate? (Oct 29)

- On the seeded photo ST-P1, SAM returned the sign at {301, 621, 699, 720}
  against a recorded ground truth of {300, 620, 700, 720} — within one pixel —
  and the person close to the recorded subject box.
- On Meta's own cookbook example (ducks.jpg), our exact request shape returned
  five boxes, the first identical to Meta's published summary file.

Conclusion: the integration is correct and SAM is pixel-accurate where it can
see the subject. SAM earned the measurement role.

## Test 2 — Where can SAM see the subject at all? (Oct 30)

All four seeded photo takes were probed from two networks (the development
machine and the Fly.io deployment), asking SAM for "person" and "sign":

- ST-P1: both found. ST-P1's figure is drawn as a detailed cartoon person.
- ST-P2, ST-P4, ST-P8: zero boxes for both concepts, from both networks. These
  takes use a flat-shape figure style, which SAM does not register as a person.
- ST-V2's video frames: zero match for "the person", same reason.

Conclusion: SAM cannot be the only source of positions. Media it cannot see
still needs framing and crop answers, from somewhere honest.

## Test 3 — Can the deployment reach the models reliably? (Oct 30)

From the Fly.io deployment, model calls failed with 404 model_not_found while
the same key and models answered from the development machine. Forcing each IP
address family in turn from inside the deployment proved the mechanism: Meta's
serving splits by address family per source network — from Fly, IPv4 returns an
empty model list and 404s while IPv6 returns real completions; from the
development machine the families are reversed. (Two independent public reports
match: a HackTX team pinning to IPv4 for the mirror-image failure, and
CLIProxyAPI issue #6117.) The fix (commit 9cd06e5) pins the transport family by
configuration; completions — not the model list, which is unreliable from Fly
on both families — are the health signal. All assignments above are verified
working through that pin on the public deployment.

## Test 4 — When SAM cannot see a take, whose positions should govern? (Oct 30)

Three candidate sources were compared against the takes' recorded facts (the
creator-side record of each take, held in the take's production sidecar):

1. The recorded facts themselves (build at commit 36a6353).
2. Muse Spark's judgement — the same estimation prompt the app now uses,
   scored against the recorded facts (build at commit 47cd051).

Under Spark's estimates, the designed catches reproduced: ST-P2's framing fix
(subject reaching the top edge, estimate {350, 0, 650, 780}), ST-P4's crop fix
(sign estimate {249, 600, 1000, 729} cut by both platform crops), and every
designed verdict on ST-V2, whose posted-frame estimates agreed across the
deployed and local runs. One verdict changed: ST-P8's crop went from pass to
fix, because Spark estimates the letter at {699, 800, 951, 950} — a position
the platform crops would cut — where the recorded facts place it inside the
crops. The estimate reproduced across runs; it is consistently, confidently
different from the recorded position.

Ruling (the Nexus System, Oct 30): the fallback order is SAM's measurement
first, then Muse Spark's judgement, then the recorded facts last. The ST-P8
outcome above is the known price of that order, recorded here rather than
tuned away.

## Test 5 — Spark vs Muse Wonder as the estimator (Oct 30, in progress)

Same estimation prompt, same images (the four takes SAM cannot see, plus
ST-P1 as a control), three independent estimates per model per image, scored
against the recorded facts. The decisive case is ST-P8's letter: inside the
crops (matching fact) or outside (Spark's current error). A reachability probe
from inside the Fly deployment is included, since a better estimator the
deployment cannot reach is not a candidate.

Results: pending — this section is completed when the run lands.

## What this adds up to

SAM measures where it can see; Spark judges, drafts, and estimates where SAM
cannot; Transcribe settles the audio check from words actually recovered; the
recorded facts stand as the final fallback; and every verdict in the app names
which of those sources it came from.
