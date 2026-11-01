"use strict";

// SAM 3.1 as a measurement source for the checks pipeline.
//
// The design contract (section 3) assigns SAM the measurements, not
// opinions: one call per concept ("person", "sign"), returning boxes the
// app turns into relative measurements. This module is the one place the
// checks pipeline talks to that assignment, and it encodes the outcomes
// honestly, down the fallback chain in the Nexus's order (Oct 30, 2026):
// SAM measurement first, then model judgement (since Oct 31, 2026: Muse
// Wonder, falling back to Muse Spark 1.3-contributor), and the take's
// recorded facts last.
//
// - SAM answers with a subject box: those boxes replace the take's
//   recorded ground truth for this check run, and the verdicts say their
//   source is SAM.
// - SAM answers with no match for the subject: the next tier is model
//   JUDGEMENT (server/judge.js) — it estimates the boxes, and the
//   verdicts say their source is judgement, never SAM. A no-match is an
//   answer, not a failure — SAM returns it for the flat-shape figures in
//   some seeded takes (verified live Oct 30, 2026: ST-P2, ST-P4, and
//   ST-P8 return no boxes for either concept, from both this machine
//   and the Fly deployment, while ST-P1's drawn figure segments
//   cleanly).
// - The judgement tier cannot supply boxes either (calls switched off, a
//   failed call, an untrusted reply): the take's recorded facts stand,
//   where the take has them. A take with no recorded facts has nothing
//   left to measure from: its measurements are "uncertain" with the
//   reason, never guessed.
// - The SAM call itself fails (HTTP error, undecodable stream): a real
//   failure. Per the contract, the measurements depending on it become
//   "uncertain" with the reason — never a guessed verdict and never a
//   silent fallback.
// - Live calls are switched off (the funding switch): not a failure and
//   not a SAM answer. Neither model tier can run, so the recorded facts
//   stand, exactly as the pipeline behaved before the models were
//   wired in.

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
// down the fallback chain in the Nexus's order: SAM measurement first,
// then model judgement, and the take's recorded facts last.
// `recorded` is the take's recorded ground truth (its seeded sidecar,
// or a repair's computed geometry); the segmenter and the estimator
// are injectable for offline tests. Returns one of:
//   { kind: "sam", groundTruth }                    — SAM's boxes.
//   { kind: "judgement", groundTruth, judgementModel } — the judgement
//     tier's estimated boxes; reported as judgement wherever they are
//     used, with the model that made them named.
//   { kind: "recorded", groundTruth, samAnswered, judgementMiss }
//     — recorded facts; samAnswered says whether SAM was asked and
//     found no subject match (true) or was never asked because calls
//     are off (false); judgementMiss says why the judgement tier could
//     not supply boxes ({ mode: "off" | "error", detail }), or null
//     when it was never reached because calls are off.
//   { kind: "judgement-unavailable", reason, callsOff } — no tier
//     could supply boxes; the caller reports framing/crop uncertain
//     with the reason.
//   { kind: "failed", reason }                      — the SAM call
//     failed; the caller reports framing/crop uncertain with the reason.
// Nexus ruling (Nov 1, 2026, Option A): a private item is NOT
// protected content for the crop check. Crop safety protects what
// the creator intends to show — the subject and intended text. When
// a locating tier reports a "sign" that is in fact the recorded
// private item (a letter, a document, a card), the sign is dropped
// before measuring: the item's protection is the privacy warning
// and the removal repair, not the crop check. The reported sign
// counts as the private item when at least half of the sign's own
// area falls inside the private item's box.
function dropPrivateSign(boxes, recorded) {
  if (!boxes || !boxes.sign || !recorded || !recorded.privateItem) return boxes;
  const s = boxes.sign;
  const p = recorded.privateItem;
  const ix = Math.max(0, Math.min(s.x1, p.x1) - Math.max(s.x0, p.x0));
  const iy = Math.max(0, Math.min(s.y1, p.y1) - Math.max(s.y0, p.y0));
  const signArea = (s.x1 - s.x0) * (s.y1 - s.y0);
  if (signArea > 0 && (ix * iy) / signArea >= 0.5) return { ...boxes, sign: null };
  return boxes;
}

async function resolvePhotoBoxes({ buffer, recorded, segmenter, judge, intent }) {
  let located;
  try {
    located = await locateBoxes(buffer, segmenter);
  } catch (err) {
    return { kind: "failed", reason: err.message };
  }
  const hasRecorded = Boolean(recorded && recorded.subject);
  if (located.status === "disabled") {
    // Calls off: neither model tier can run, so the recorded facts
    // stand — or, without them, nothing can supply the boxes.
    if (hasRecorded) {
      return { kind: "recorded", groundTruth: recorded, samAnswered: false, judgementMiss: null };
    }
    return {
      kind: "judgement-unavailable",
      callsOff: true,
      reason:
        "Live model calls are switched off, so neither SAM 3.1's measurement nor the judgement tier (Muse Wonder, falling back to Muse Spark 1.3-contributor) can supply the boxes, and this take has no recorded facts to measure from. Framing and crop safety are uncertain rather than guessed.",
    };
  }
  if (located.subject) {
    return { kind: "sam", groundTruth: dropPrivateSign({ subject: located.subject, sign: located.sign }, recorded) };
  }
  // SAM answered with no match for the subject. The next tier is model
  // judgement, reported as measured-by-judgement — never as a
  // SAM measurement. The recorded facts are the last resort.
  const estimate = judge || estimateBoxes;
  let judged = null;
  let judgementMiss = null;
  try {
    judged = await estimate(buffer, intent);
  } catch (err) {
    judgementMiss = { mode: "error", detail: err.message };
  }
  if (!judgementMiss && (!judged || judged.status === "disabled")) {
    judgementMiss = { mode: "off", detail: "live model calls are switched off" };
    judged = null;
  }
  if (judged && judged.status === "ok") {
    return {
      kind: "judgement",
      groundTruth: dropPrivateSign({ subject: judged.subject, sign: judged.sign }, recorded),
      judgementModel: judged.model || null,
    };
  }
  if (hasRecorded) {
    return { kind: "recorded", groundTruth: recorded, samAnswered: true, judgementMiss };
  }
  return {
    kind: "judgement-unavailable",
    callsOff: judgementMiss.mode === "off",
    reason: `SAM 3.1 returned no match for the subject in this take. The judgement tier — Muse Wonder, then Muse Spark 1.3-contributor — could not supply the boxes (${judgementMiss.detail}), and the take has no recorded facts to measure from. Framing and crop safety are uncertain rather than guessed.`,
  };
}

module.exports = { locateBoxes, resolvePhotoBoxes, largestBox, dropPrivateSign };
