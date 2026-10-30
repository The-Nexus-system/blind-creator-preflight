"use strict";

// SAM 3.1 as a measurement source for the checks pipeline.
//
// The design contract (section 3) assigns SAM the measurements, not
// opinions: one call per concept ("person", "sign"), returning boxes the
// app turns into relative measurements. This module is the one place the
// checks pipeline talks to that assignment, and it encodes the outcomes
// honestly:
//
// - SAM answers with a subject box: those boxes replace the take's
//   recorded ground truth for this check run, and the verdicts say their
//   source is SAM.
// - SAM answers with no match for the subject: the take's recorded facts
//   stand when it has them. A no-match is an answer, not a failure — SAM
//   returns it for the flat-shape figures in some seeded takes (verified
//   live Oct 30, 2026: ST-P2, ST-P4, and ST-P8 return no boxes for either
//   concept, from both this machine and the Fly deployment, while ST-P1's
//   drawn figure segments cleanly). The response says SAM was asked and
//   the recorded facts were used.
// - SAM answers with no match AND the take has no recorded facts: the
//   contract's third tier — Muse Spark estimates the boxes by judgement
//   (server/judge.js), and the verdicts say their source is judgement,
//   never SAM. If that estimate cannot be had (calls switched off, a
//   failed call, an untrusted reply), the measurements are "uncertain"
//   with the reason, never guessed.
// - The SAM call itself fails (HTTP error, undecodable stream): a real
//   failure. Per the contract, the measurements depending on it become
//   "uncertain" with the reason — never a guessed verdict and never a
//   silent fallback.
// - Live calls are switched off (the funding switch): not a failure and
//   not a SAM answer. The recorded facts stand, exactly as the pipeline
//   behaved before SAM was wired in; a take with no recorded facts has
//   nothing to measure from, and says so as uncertainty.

const { segmentImage, ModelCallsDisabled } = require("./model-api");
const { estimateBoxes } = require("./judge");

function largestBox(boxes) {
  if (!boxes || !boxes.length) return null;
  return boxes.reduce((a, b) =>
    (b.x1 - b.x0) * (b.y1 - b.y0) > (a.x1 - a.x0) * (a.y1 - a.y0) ? b : a
  );
}

// Asks SAM for the subject ("person") and the text/sign region ("sign")
// in one image. The segmenter is injectable for offline tests; production
// passes model-api's segmentImage. Returns:
//   { status: "ok", subject, sign }  — SAM answered; either box may be
//                                      null when SAM found no match.
//   { status: "disabled" }           — live calls are switched off.
// Throws on a real call failure; callers turn that into uncertainty.
async function locateBoxes(buffer, segmenter) {
  const seg = segmenter || segmentImage;
  let personBoxes;
  let signBoxes;
  try {
    personBoxes = await seg(buffer, "person");
    signBoxes = await seg(buffer, "sign");
  } catch (err) {
    if (err instanceof ModelCallsDisabled || (err && err.code === "MODEL_CALLS_DISABLED")) {
      return { status: "disabled" };
    }
    throw err;
  }
  return { status: "ok", subject: largestBox(personBoxes), sign: largestBox(signBoxes) };
}

// Resolves which boxes a PHOTO take's framing/crop measurement uses,
// down the contract's fallback chain: SAM measurement, then the take's
// recorded facts, then Muse Spark judgement. `recorded` is the take's
// recorded ground truth (its seeded sidecar, or a repair's computed
// geometry); the estimator is injectable for offline tests. Returns
// one of:
//   { kind: "sam", groundTruth }                    — SAM's boxes.
//   { kind: "recorded", groundTruth, samAnswered }  — recorded facts;
//     samAnswered says whether SAM was asked and found no subject match
//     (true) or was never asked because calls are off (false).
//   { kind: "judgement", groundTruth }              — Spark's estimated
//     boxes; reported as judgement wherever they are used.
//   { kind: "judgement-unavailable", reason, callsOff } — no tier could
//     supply boxes; the caller reports framing/crop uncertain with the
//     reason.
//   { kind: "failed", reason }                      — the SAM call
//     failed; the caller reports framing/crop uncertain with the reason.
async function resolvePhotoBoxes({ buffer, recorded, segmenter, judge, intent }) {
  let located;
  try {
    located = await locateBoxes(buffer, segmenter);
  } catch (err) {
    return { kind: "failed", reason: err.message };
  }
  const hasRecorded = Boolean(recorded && recorded.subject);
  if (located.status === "disabled") {
    if (hasRecorded) {
      return { kind: "recorded", groundTruth: recorded, samAnswered: false };
    }
    return {
      kind: "judgement-unavailable",
      callsOff: true,
      reason:
        "This take has no recorded facts to measure from, and live model calls are switched off, so neither SAM 3.1's measurement nor Muse Spark's judgement can supply the boxes. Framing and crop safety are uncertain rather than guessed.",
    };
  }
  if (located.subject) {
    return { kind: "sam", groundTruth: { subject: located.subject, sign: located.sign } };
  }
  // SAM answered with no match for the subject.
  if (hasRecorded) {
    return { kind: "recorded", groundTruth: recorded, samAnswered: true };
  }
  // No recorded facts either: the contract's fallback is Muse Spark
  // judgement, reported as measured-by-judgement — never as a SAM
  // measurement.
  const estimate = judge || estimateBoxes;
  let judged;
  try {
    judged = await estimate(buffer, intent);
  } catch (err) {
    return {
      kind: "judgement-unavailable",
      callsOff: false,
      reason: `SAM 3.1 returned no match for the subject in this take, and the take has no recorded facts to measure from. The fallback is Muse Spark's judgement, but it could not supply the boxes (${err.message}) Framing and crop safety are uncertain rather than guessed.`,
    };
  }
  if (!judged || judged.status === "disabled") {
    return {
      kind: "judgement-unavailable",
      callsOff: true,
      reason:
        "SAM 3.1 returned no match for the subject in this take, and the take has no recorded facts to measure from. The fallback is Muse Spark's judgement, but live model calls are switched off, so no estimate is available. Framing and crop safety are uncertain rather than guessed.",
    };
  }
  return { kind: "judgement", groundTruth: { subject: judged.subject, sign: judged.sign } };
}

module.exports = { locateBoxes, resolvePhotoBoxes, largestBox };
