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
fix.

The ST-P8 change was first read as estimation error. It is not, and this
section corrects that reading (Oct 30, after the take's sidecar was read
directly and Test 5 scored the estimates against the recorded boxes). Spark
estimates the letter at {699, 800, 951, 950}; the recorded box for the letter
is {700, 800, 950, 950} — the estimate is essentially exact, and the letter
truly sits outside both centre crops (on the 1000-pixel canvas the 9:16
window ends at x=781 and the 4:5 window at x=900). The recorded-facts pass
came from somewhere else: ST-P8's sidecar records the letter as a private
item and its sign slot is null, so the recorded crop check never included the
letter in what it protected. Any estimator that finds the letter and reports
it in the sign slot produces the fix, however accurate it is. The difference
is a rule — whether a text or private region belongs in the crop check's
protected set — not a model error and not a conflict between the estimate and
the record.

Ruling (the Nexus System, Oct 30): the fallback order is SAM's measurement
first, then Muse Spark's judgement, then the recorded facts last.

## Test 5 — Spark vs Muse Wonder as the estimator (Oct 30, in progress)

Same estimation prompt, same images (the four takes SAM cannot see, plus
ST-P1 as a control), three independent estimates per model per image, scored
against the recorded facts. The decisive case is ST-P8's letter: inside the
crops (matching fact) or outside (Spark's current error). A reachability probe
from inside the Fly deployment is included, since a better estimator the
deployment cannot reach is not a candidate.

Results (main arm, Oct 30): Wonder is consistently the better estimator.
Across the five images and three samples each, Wonder returned 15 of 15
usable replies and Spark 13 of 15 (two Spark replies on ST-P2 failed the
strict parser and were distrusted). Wonder's boxes were pixel-exact on the
subject and sign for ST-P2, ST-P4, and ST-P8 in every sample, with identical
boxes across samples on those takes; Spark matched the designed catches too
but showed a recurring overshoot of about 28 pixels (subject bottom on ST-P1
and ST-P4, subject top on ST-P8) and more run-to-run spread. On ST-V2's
posted frame the two were roughly tied, both reproducing the framing fix. On
the ST-P1 control, both models widened the figure by about 28–30 pixels per
side against the generator's spec — and SAM's independent box agrees with
the models, so that delta is spec-versus-rendering, not model error.
Decisive case: on ST-P8's letter, Spark was within a pixel on two of three
samples and Wonder was exact on all three — both models place the letter
where the record does, outside the crops (see Test 4: the flip is a rule
difference, not an estimation error, and no model swap changes it).
Reachability: one Muse Wonder call executed from inside the Fly deployment,
through the app's own model code over the pinned route, returned a real
completion — Wonder is reachable in production exactly as Spark is. Cost
note: Wonder is the premium-priced tier, which is a product consideration
outside this measurement; the choice of model for the judgement tier is the
Nexus System's decision.

The remaining family members were run through the identical harness
(Oct 30, 60 calls, 57 trusted replies, no transport errors). On verdicts it
is a four-way tie: every answered sample from every variant reproduced every
designed consequence on this media set. The differences are in box quality.
Muse Spark 1.3-contributor was the cleanest of the four — its sign boxes
were essentially exact everywhere and its spread the tightest, with one
distrusted reply in fifteen. Muse Spark 1.2 answered every call and was
pixel-perfect on ST-P8, but carries a systematic downward bias of about
28–30 pixels on sign boxes. Muse Spark 1.2-contributor matched that bias
and produced the run's single worst subject box (one ST-P4 sample with the
top edge 110 pixels low, verdict unaffected). Muse Spark 1.1, when it
answered, rivalled the best — and failed to produce a trusted reply in two
of fifteen calls, the deciding weakness for a fallback tier whose job is to
answer when SAM cannot. On ST-P8's letter, all four variants in all twelve
answered samples estimated exactly the recorded box, {700, 800, 950, 950},
outside the crops: the crop outcome there is estimator-independent, set by
the letter's true position and by whether the check tests the letter at
all. The collective lesson of the variants arm: within the Spark family,
estimator choice moves no verdict on this set — Wonder's edge in the main
arm (exactness, consistency, no distrusted replies) is the real difference
on offer.

## What this adds up to

SAM measures where it can see; Spark judges, drafts, and estimates where SAM
cannot; Transcribe settles the audio check from words actually recovered; the
recorded facts stand as the final fallback; and every verdict in the app names
which of those sources it came from.
