"use strict";

// Checking a photo the creator supplies themselves — "Check your own
// photo", POST /api/uploads/check.
//
// A supplied photo is not a seeded take: it has no recorded facts and
// no stated intent. Its checks therefore run down the same fallback
// chain the seeded photo takes use (server/sam.js's resolvePhotoBoxes),
// minus the chain's last leg: SAM 3.1's measurement first, then the
// judgement tier's estimate (Muse Wonder, falling back to Muse Spark
// 1.3-contributor), and — where a seeded take would fall back to its
// recorded facts — UNCERTAIN with the reason, never a pass and never a
// "recorded" source. Quality is measured from the pixels; text, first
// impression, and the private-information warning come from the
// semantic pipeline; the audio check is determined (a still photo has
// no audio track).
//
// The photo is processed for the check and not stored. The request body
// is read under a hard size cap, enforced while reading (below); the
// validated PNG is written to a temp file under a random name in
// server/uploads-tmp/ — never a client-supplied name, so no path a
// client sends can steer the write — and the temp file is deleted when
// the request finishes, success or failure. There is no listing
// endpoint and nothing about an upload persists.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CHECKS } = require("./seed-takes");
const { measureImage } = require("./measure");
const { resolvePhotoBoxes } = require("./sam");
const { runSemanticChecks } = require("./semantic");

// 15 MB, enforced while the body is read — see readBodyWithCap. The
// client enforces the same cap on the PNG it produces (client/app.js),
// scaling the photo down first when it would exceed it.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TMP_DIR = path.join(__dirname, "uploads-tmp");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// The intent the pipelines are handed for a supplied photo: plainly
// none. Both model prompts ask for the creator's stated intent; a
// supplied photo has none, and the prompts are told so rather than
// handed an invented one.
const UPLOAD_INTENT =
  "none stated — the creator supplied this photo directly for checking, with no stated intent";

function isPng(buffer) {
  return (
    Boolean(buffer) &&
    buffer.length >= PNG_SIGNATURE.length &&
    buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  );
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

// Reads a request body under a hard cap. The moment the running total
// exceeds the cap, everything accumulated is freed and the promise
// resolves { tooLarge: true } — the caller rejects at once. Any bytes
// still in flight after that are drained and discarded by the same
// listener, never stored, so the connection stays consistent and the
// rejection can be delivered cleanly. Memory never holds more than
// the cap, and an over-cap body never reaches the temp dir.
function readBodyWithCap(req, cap) {
  return new Promise((resolve) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return; // past the cap: drain and discard
      total += chunk.length;
      if (total > cap) {
        settled = true;
        chunks.length = 0;
        resolve({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) {
        settled = true;
        resolve({ buffer: Buffer.concat(chunks) });
      }
    });
    req.on("error", () => {
      if (!settled) {
        settled = true;
        resolve({ aborted: true });
      }
    });
  });
}

// Builds the check list for one supplied photo. The segmenter, judge,
// and chat functions are injectable for offline tests and default to
// the live pipeline pieces. The response mirrors the shape of
// GET /api/takes/:id/checks for a photo take, with origin "upload",
// and states plainly that the photo has no recorded facts and no
// stated intent.
async function buildUploadChecks(buffer, deps = {}) {
  const byId = {};
  for (const c of CHECKS) {
    byId[c.id] = { id: c.id, name: c.name, verdict: "uncertain", detail: "", source: "pending" };
  }

  // No recorded facts: resolvePhotoBoxes is given recorded: null, so
  // its chain can end at "sam", "judgement", or an honest unavailable —
  // never "recorded".
  const resolved = await resolvePhotoBoxes({
    buffer,
    recorded: null,
    segmenter: deps.segmenter,
    judge: deps.judge,
    intent: UPLOAD_INTENT,
  });

  let measurement;
  let measurementSource;
  let measurementNote = null;
  if (resolved.kind === "failed") {
    measurement = await measureImage(buffer, null, null);
    measurementSource = "sam-failed";
    const reason = `SAM 3.1 could not supply this photo's measurements (${resolved.reason}) Framing and crop safety cannot be measured without them, so both are uncertain rather than guessed.`;
    Object.assign(byId.framing, { verdict: "uncertain", detail: reason, source: "model-error" });
    Object.assign(byId.crop, { verdict: "uncertain", detail: reason, source: "model-error" });
  } else if (resolved.kind === "judgement-unavailable") {
    measurement = await measureImage(buffer, null, null);
    measurementSource = "judgement-unavailable";
    const source = resolved.callsOff ? "model-off" : "model-error";
    Object.assign(byId.framing, { verdict: "uncertain", detail: resolved.reason, source });
    Object.assign(byId.crop, { verdict: "uncertain", detail: resolved.reason, source });
  } else {
    measurement = await measureImage(buffer, resolved.groundTruth, null);
    measurementSource = resolved.kind; // "sam" | "judgement"
    if (measurement.framing) {
      Object.assign(byId.framing, {
        verdict: measurement.framing.verdict,
        detail: measurement.framing.detail,
        source: resolved.kind,
      });
    }
    if (measurement.cropSafety) {
      Object.assign(byId.crop, {
        verdict: measurement.cropSafety.verdict,
        detail: measurement.cropSafety.detail,
        source: resolved.kind,
      });
    }
    const judgementBy =
      resolved.judgementModel === "muse-spark-1.3-contributor"
        ? "Muse Spark 1.3-contributor's judgement — the fallback tier, used because Muse Wonder was unavailable or its reply could not be trusted"
        : "Muse Wonder's judgement";
    measurementNote =
      resolved.kind === "sam"
        ? "Framing and crop safety are measured from boxes located by SAM 3.1 in the photo you supplied."
        : `SAM 3.1 was asked for the subject and returned no match in this photo, so framing and crop safety are measured from ${judgementBy} — an estimate, not a SAM measurement.`;
  }
  Object.assign(byId.quality, {
    verdict: measurement.quality.verdict,
    detail: measurement.quality.detail,
    source: "measured",
  });
  Object.assign(byId.audio, {
    verdict: "uncertain",
    detail: "Still photo: there is no audio track to check.",
    source: "determined",
  });

  const sem = await runSemanticChecks(buffer, UPLOAD_INTENT, deps.chat);
  Object.assign(byId.text, { verdict: sem.text.verdict, detail: sem.text.detail, source: sem.source });
  Object.assign(byId.firstImpression, {
    verdict: sem.firstImpression.verdict,
    detail: sem.firstImpression.detail,
    source: sem.source,
  });

  const checks = CHECKS.map((c) => byId[c.id]);
  const allSettled = checks.every((c) =>
    ["measured", "sam", "judgement", "model", "determined"].includes(c.source)
  );
  const anyRealCheck = checks.some((c) =>
    ["measured", "sam", "judgement", "model"].includes(c.source)
  );
  const scaled = Boolean(deps.scaled);
  return {
    origin: "upload",
    take: { id: null, kind: "photo", title: "Your photo", intent: null },
    variant: null,
    source: allSettled && anyRealCheck ? "live" : "partial",
    measurementSource,
    measurementNote,
    note:
      "This is a photo you supplied. It has no recorded facts and no stated intent: the checks above were measured and judged from the photo itself, and where the subject could not be located they read uncertain rather than falling back to a record. The photo was processed for this check and not stored.",
    scaled,
    scalingNote: scaled
      ? "Checked a scaled copy: the photo was reduced before checking to fit the size limits, so the measurements describe the scaled copy, not the original at full size."
      : null,
    transcript: null,
    checks,
    privacyWarning: sem.privacyWarning,
    privacyWarningSource: sem.privacyWarningSource,
  };
}

// POST /api/uploads/check — exactly one PNG per request, raw in the
// body. deps carries the test stubs and the client's scaled flag; the
// HTTP wiring in server/index.js passes only { scaled }.
async function handleUploadCheck(req, res, deps = {}) {
  const read = await readBodyWithCap(req, MAX_UPLOAD_BYTES);
  if (read.tooLarge) {
    return sendJson(res, 413, {
      error: `That photo is too large to check: the limit is ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB. It was rejected while arriving, and nothing was stored.`,
    });
  }
  if (read.aborted || !read.buffer) {
    return sendJson(res, 400, {
      error: "The upload did not arrive complete, so nothing was checked.",
    });
  }
  const body = read.buffer;
  if (body.length === 0) {
    return sendJson(res, 400, {
      error: "No photo arrived with the request — the request body was empty.",
    });
  }
  if (!isPng(body)) {
    return sendJson(res, 415, {
      error:
        "That file is not a PNG image, so it was not checked. The app's own photo picker converts the photo you choose to PNG before sending it.",
    });
  }
  await fs.promises.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  const tmpPath = path.join(
    UPLOAD_TMP_DIR,
    `upload-${crypto.randomBytes(12).toString("hex")}.png`
  );
  try {
    await fs.promises.writeFile(tmpPath, body);
    const buffer = await fs.promises.readFile(tmpPath);
    const result = await buildUploadChecks(buffer, deps);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, { error: `The check failed: ${err.message}` });
  } finally {
    // Processed for the check, not stored: the temp file goes away
    // with the request, success or failure.
    await fs.promises.unlink(tmpPath).catch(() => {});
  }
}

module.exports = {
  handleUploadCheck,
  buildUploadChecks,
  readBodyWithCap,
  isPng,
  MAX_UPLOAD_BYTES,
  UPLOAD_TMP_DIR,
  UPLOAD_INTENT,
};
