"use strict";

// Checking a photo the creator supplies themselves — "Check your own
// photo", POST /api/uploads/check — and the working session it opens.
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
// The upload flow is the seeded flow, at parity: check → repairs →
// re-check → proof copy and alt text → share. That takes a working
// session. POST /api/uploads/check creates one under a random,
// unguessable id and keeps the original PNG in
// server/uploads-tmp/<session-id>/ so repairs can work on it; the
// session endpoints below mirror the takes' surface (checks, repairs,
// repair, copy, readiness, media). The working copy is kept only
// while the creator works with it: sessions older than two hours are
// swept and deleted (an opportunistic sweep runs on each new upload),
// and nothing about an upload persists beyond that.
//
// Path safety: a session id is valid only as 32 lowercase hex
// characters — the shape this module issues — and a variant is valid
// only as a chain of the known repair ids. No client-supplied value
// reaches a file path except through those two allowlists, and every
// resolved path is confirmed inside its session directory before use.
// One session can therefore never address another session's files.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { CHECKS } = require("./seed-takes");
const { measureImage } = require("./measure");
const { resolvePhotoBoxes } = require("./sam");
const { runSemanticChecks } = require("./semantic");
const { estimatePrivateRegion } = require("./judge");
const { availableRepairs, applyRepair, REDACT_REPAIR_ID } = require("./repair");
const { buildUploadProofCopy, draftUploadAltText, readiness } = require("./copy");

// 15 MB, enforced while the body is read — see readBodyWithCap. The
// client enforces the same cap on the PNG it produces (client/app.js),
// scaling the photo down first when it would exceed it.
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
const UPLOAD_TMP_DIR = path.join(__dirname, "uploads-tmp");
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A working session's lifetime: the copy is deleted once it is older
// than this, whether or not anyone asks again.
const SESSION_TTL_MS = 2 * 60 * 60 * 1000;
const SESSION_ID_PATTERN = /^[a-f0-9]{32}$/;
// The repair ids server/repair.js can apply — the only elements a
// variant chain may contain, here as in the takes' media route.
const REPAIR_IDS = ["reframe-margin", "reframe-fit-crops", "brightness-auto", "cover-frame-hands-up", REDACT_REPAIR_ID];
const CHAIN_SEP = "~";

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

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
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

// --- The checks ------------------------------------------------------------

// Runs the full check pipeline for one supplied photo buffer and
// returns everything the flow needs: the response-shaped result, the
// boxes the locating tiers found (null when none could), and the raw
// measurement the repair offers are computed from. deps carries the
// injectable pipeline pieces for offline tests (segmenter, judge,
// chat), the client's scaled flag, and — for a repaired variant — the
// content box the repair declared, so quality is measured on the
// picture rather than the repair's own border fill.
async function runUploadChecks(buffer, deps = {}) {
  const byId = {};
  for (const c of CHECKS) {
    byId[c.id] = { id: c.id, name: c.name, verdict: "uncertain", detail: "", source: "pending" };
  }

  // The semantic checks and the privacy-region estimate run FIRST,
  // before any boxes are resolved: the crop check needs to know where
  // the private item is before it can keep that item out of its
  // protected set (the Nexus's Option A ruling, Nov 1, 2026 — a
  // private item is not protected content for crop safety; its
  // protection is the warning and the removal repair).
  const sem = await runSemanticChecks(buffer, UPLOAD_INTENT, deps.chat);
  Object.assign(byId.text, { verdict: sem.text.verdict, detail: sem.text.detail, source: sem.source });
  Object.assign(byId.firstImpression, {
    verdict: sem.firstImpression.verdict,
    detail: sem.firstImpression.detail,
    source: sem.source,
  });

  // When the privacy warning fires on a supplied photo, the judgement
  // tier is also asked to locate the private item, so the warning has
  // an action: the redaction repair. The estimate is held to the same
  // strict parsing as every judgement reply; a region that cannot be
  // located — the model says so, its reply cannot be trusted, or the
  // call fails — leaves privacyRegion null, no redaction is offered,
  // and the client says plainly that the app can tell private
  // information is present but cannot locate it precisely enough to
  // take it off automatically. deps.regionEstimator is injectable for
  // the offline tests; production asks server/judge.js's estimator on
  // the same chat route the semantic checks used.
  let privacyRegion = null;
  if (sem.privacyWarning) {
    try {
      const estimate = deps.regionEstimator
        ? await deps.regionEstimator(buffer, sem.privacyWarning.name)
        : await estimatePrivateRegion(buffer, sem.privacyWarning.name, deps.chat);
      if (estimate && estimate.status === "ok" && estimate.region) {
        privacyRegion = estimate.region;
      }
    } catch {
      privacyRegion = null;
    }
  }

  // Almost no recorded facts: resolvePhotoBoxes is given a record
  // carrying ONLY the located private region — never a subject, so
  // its chain can still end at "sam", "judgement", or an honest
  // unavailable, never "recorded". The region is there for one
  // purpose: the crop check's guard drops a located "sign" that is
  // in fact the private item (see dropPrivateSign in server/sam.js).
  const resolved = await resolvePhotoBoxes({
    buffer,
    recorded: privacyRegion ? { privateItem: privacyRegion } : null,
    segmenter: deps.segmenter,
    judge: deps.judge,
    intent: UPLOAD_INTENT,
  });

  let measurement;
  let measurementSource;
  let measurementNote = null;
  let boxes = null;
  const contentBox = deps.contentBox || null;
  if (resolved.kind === "failed") {
    measurement = await measureImage(buffer, null, contentBox);
    measurementSource = "sam-failed";
    const reason = `SAM 3.1 could not supply this photo's measurements (${resolved.reason}) Framing and crop safety cannot be measured without them, so both are uncertain rather than guessed.`;
    Object.assign(byId.framing, { verdict: "uncertain", detail: reason, source: "model-error" });
    Object.assign(byId.crop, { verdict: "uncertain", detail: reason, source: "model-error" });
  } else if (resolved.kind === "judgement-unavailable") {
    measurement = await measureImage(buffer, null, contentBox);
    measurementSource = "judgement-unavailable";
    const source = resolved.callsOff ? "model-off" : "model-error";
    Object.assign(byId.framing, { verdict: "uncertain", detail: resolved.reason, source });
    Object.assign(byId.crop, { verdict: "uncertain", detail: resolved.reason, source });
  } else {
    boxes = resolved.groundTruth;
    measurement = await measureImage(buffer, resolved.groundTruth, contentBox);
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

  const checks = CHECKS.map((c) => byId[c.id]);
  const allSettled = checks.every((c) =>
    ["measured", "sam", "judgement", "model", "determined"].includes(c.source)
  );
  const anyRealCheck = checks.some((c) =>
    ["measured", "sam", "judgement", "model"].includes(c.source)
  );
  const scaled = Boolean(deps.scaled);
  const result = {
    origin: "upload",
    take: { id: null, kind: "photo", title: "Your photo", intent: null },
    variant: null,
    source: allSettled && anyRealCheck ? "live" : "partial",
    measurementSource,
    measurementNote,
    note:
      "This is a photo you supplied. It has no recorded facts and no stated intent: the checks above were measured and judged from the photo itself, and where the subject could not be located they read uncertain rather than falling back to a record. Pre-Flight keeps a working copy of this photo on the server while you check, repair, and share it, and deletes that copy within two hours.",
    scaled,
    scalingNote: scaled
      ? "Checked a scaled copy: the photo was reduced before checking to fit the size limits, so the measurements describe the scaled copy, not the original at full size."
      : null,
    transcript: null,
    checks,
    privacyWarning: sem.privacyWarning,
    privacyWarningSource: sem.privacyWarningSource,
    privacyRegion,
    privacyRedactionOffered: Boolean(sem.privacyWarning && privacyRegion),
  };
  return { result, boxes, measurement };
}

// The response-shaped result alone — the shape the offline tests and
// the original upload build established.
async function buildUploadChecks(buffer, deps = {}) {
  return (await runUploadChecks(buffer, deps)).result;
}

// --- Sessions ---------------------------------------------------------------

function chainOf(variantId) {
  return variantId ? variantId.split(CHAIN_SEP) : [];
}

function isValidVariantChain(variant) {
  if (variant == null || variant === "") return true; // the original
  if (typeof variant !== "string") return false;
  return chainOf(variant).every((id) => REPAIR_IDS.includes(id));
}

function sessionDirPath(sessionId) {
  if (typeof sessionId !== "string" || !SESSION_ID_PATTERN.test(sessionId)) return null;
  return path.join(UPLOAD_TMP_DIR, sessionId);
}

// The file a session's variant lives at — original.png for the
// original, <chain>.png for a repaired variant — or null when the
// session id or the chain is not one this module could have issued.
// The resolved path is confirmed inside the session directory.
function sessionFilePath(sessionId, variant, ext) {
  const dir = sessionDirPath(sessionId);
  if (!dir || !isValidVariantChain(variant)) return null;
  const name = variant ? `${variant}.${ext}` : `original.${ext}`;
  const resolved = path.resolve(dir, name);
  if (!resolved.startsWith(path.resolve(dir))) return null;
  return resolved;
}

function sessionMediaPath(sessionId, variant) {
  return sessionFilePath(sessionId, variant || null, "png");
}

async function sessionExists(sessionId) {
  const original = sessionFilePath(sessionId, null, "png");
  if (!original) return false;
  try {
    await fs.promises.access(original);
    return true;
  } catch {
    return false;
  }
}

async function requireSession(sessionId) {
  if (!(await sessionExists(sessionId))) {
    throw httpError(
      404,
      "Unknown upload session — it may have passed its two-hour lifetime and been deleted, or the id is not one Pre-Flight issued."
    );
  }
}

async function readSessionBuffer(sessionId, variant) {
  const file = sessionFilePath(sessionId, variant || null, "png");
  if (!file) throw httpError(400, "Unknown variant.");
  try {
    return await fs.promises.readFile(file);
  } catch {
    throw httpError(404, "That version of the photo does not exist in this session.");
  }
}

async function readVariantContentBox(sessionId, variant) {
  if (!variant) return null;
  const file = sessionFilePath(sessionId, variant, "json");
  if (!file) return null;
  try {
    const sidecar = JSON.parse(await fs.promises.readFile(file, "utf8"));
    return sidecar && sidecar.contentBox ? sidecar.contentBox : null;
  } catch {
    return null;
  }
}

// Runs the checks for one version of a session's photo and returns
// the pipeline triple, with the result stamped as the takes' results
// are (variant, sessionId).
async function runSessionChecks(sessionId, variant, deps = {}) {
  await requireSession(sessionId);
  if (!isValidVariantChain(variant)) throw httpError(400, "Unknown variant.");
  const buffer = await readSessionBuffer(sessionId, variant || null);
  const contentBox = await readVariantContentBox(sessionId, variant || null);
  const triple = await runUploadChecks(buffer, { ...deps, contentBox });
  triple.result.variant = variant || null;
  triple.result.sessionId = sessionId;
  return triple;
}

// Creates a session for a freshly arrived photo: the original is
// written under a random id, the checks run on it, and the result —
// stamped with the session id — is what POST /api/uploads/check
// answers. If the first check fails, the session goes away with the
// request rather than lingering as an orphan.
async function createUploadSession(buffer, deps = {}) {
  await fs.promises.mkdir(UPLOAD_TMP_DIR, { recursive: true });
  const sessionId = crypto.randomBytes(16).toString("hex");
  const dir = path.join(UPLOAD_TMP_DIR, sessionId);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.writeFile(path.join(dir, "original.png"), buffer);
    const { result } = await runSessionChecks(sessionId, null, deps);
    return { sessionId, result };
  } catch (err) {
    await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// The repairs offered for a session's current version — the same
// computation the takes use, over the upload's own measurement and
// located boxes. Where no box could be located, the reframe repairs
// simply never become offered (their verdicts read uncertain), while
// the pixel-based exposure repair still can be.
async function listSessionRepairs(sessionId, variant, deps = {}) {
  const { result, measurement, boxes } = await runSessionChecks(sessionId, variant || null, deps);
  const repairs = availableRepairs(measurement, boxes || {}, {
    chain: chainOf(variant || undefined),
    privacy: { active: Boolean(result.privacyWarning), region: result.privacyRegion || null },
  });
  return { repairs, variant: variant || null };
}

// Applies one repair to a session version, exactly as the takes do:
// the repair must be one the current verdicts offer; it is performed
// by server/repair.js's deterministic transforms over the boxes the
// check located; the result is written as the new chain's file; the
// checks re-run; and the outcome is reported by measured verdict on
// the check the repair targets — improved, unchanged, or worse,
// stated either way.
async function applySessionRepair(sessionId, repairId, baseVariant, deps = {}) {
  if (!isValidVariantChain(baseVariant)) throw httpError(400, "Unknown variant.");
  const base = baseVariant || null;
  const before = await runSessionChecks(sessionId, base, deps);
  const offered = availableRepairs(before.measurement, before.boxes || {}, {
    chain: chainOf(base || undefined),
    privacy: { active: Boolean(before.result.privacyWarning), region: before.result.privacyRegion || null },
  });
  const entry = offered.find((r) => r.id === repairId);
  if (!entry) {
    throw httpError(400, `Repair ${repairId} is not offered for this photo's current verdicts.`);
  }
  const baseBuffer = await readSessionBuffer(sessionId, base);
  // The redaction paints over the region the current check located,
  // which lives on the check result rather than among the located
  // subject/sign boxes; hand it to the repair as the private item.
  const repairGroundTruth =
    repairId === REDACT_REPAIR_ID
      ? { ...(before.boxes || {}), privateItem: before.result.privacyRegion || null }
      : before.boxes;
  const out = await applyRepair(baseBuffer, repairGroundTruth, repairId, before.measurement);
  const resultVariant = base ? `${base}${CHAIN_SEP}${repairId}` : repairId;
  const dir = sessionDirPath(sessionId);
  await fs.promises.writeFile(path.join(dir, `${resultVariant}.png`), out.buffer);
  const baseContentBox = await readVariantContentBox(sessionId, base);
  const contentBox = out.contentBox || baseContentBox || null;
  await fs.promises.writeFile(
    path.join(dir, `${resultVariant}.json`),
    JSON.stringify({ contentBox }, null, 2)
  );
  const after = await runSessionChecks(sessionId, resultVariant, deps);
  const rank = { fix: 0, uncertain: 1, pass: 2 };
  // The redaction's outcome is measured on the privacy warning itself —
  // showing before, clear after — in the same before/after shape as
  // every other repair's verdict outcome. It counts as improved only
  // when the re-run privacy check can no longer read the information.
  const outcome =
    entry.fixesCheck === "privacy"
      ? {
          checkId: "privacy",
          checkName: "Private-information warning",
          before: before.result.privacyWarning ? "showing" : "clear",
          after: after.result.privacyWarning ? "showing" : "clear",
          improved: Boolean(before.result.privacyWarning) && !after.result.privacyWarning,
          worse: !before.result.privacyWarning && Boolean(after.result.privacyWarning),
        }
      : (() => {
          const beforeCheck = before.result.checks.find((c) => c.id === entry.fixesCheck);
          const afterCheck = after.result.checks.find((c) => c.id === entry.fixesCheck);
          return beforeCheck && afterCheck
            ? {
                checkId: entry.fixesCheck,
                checkName: beforeCheck.name,
                before: beforeCheck.verdict,
                after: afterCheck.verdict,
                improved: rank[afterCheck.verdict] > rank[beforeCheck.verdict],
                worse: rank[afterCheck.verdict] < rank[beforeCheck.verdict],
              }
            : null;
        })();
  return { variantId: resultVariant, changes: out.changes, outcome, result: after.result };
}

// Proof copy and the alt-text draft for a session version, composed
// deterministically from the session's own check results.
async function buildSessionCopy(sessionId, variant, deps = {}) {
  const { result } = await runSessionChecks(sessionId, variant || null, deps);
  return {
    variant: result.variant,
    proofCopy: buildUploadProofCopy(result),
    altText: draftUploadAltText(result),
  };
}

// The one readiness rule, over a session version's own results.
async function sessionReadiness(sessionId, variant, flags, deps = {}) {
  const { result } = await runSessionChecks(sessionId, variant || null, deps);
  return readiness(result, {
    warningAcknowledged: Boolean(flags && flags.warningAcknowledged),
    altTextApproved: Boolean(flags && flags.altTextApproved),
  });
}

// Deletes session directories older than the lifetime. Runs
// opportunistically on each new upload; exported for the tests,
// which call it against a stated "now".
async function sweepUploadSessions(now = Date.now()) {
  let entries;
  try {
    entries = await fs.promises.readdir(UPLOAD_TMP_DIR);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!SESSION_ID_PATTERN.test(entry)) continue;
    const dir = path.join(UPLOAD_TMP_DIR, entry);
    try {
      const stat = await fs.promises.stat(dir);
      if (stat.isDirectory() && now - stat.mtimeMs > SESSION_TTL_MS) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    } catch {
      // A directory racing the sweep is not an error worth surfacing.
    }
  }
}

// --- HTTP handlers ------------------------------------------------------------

// POST /api/uploads/check — exactly one PNG per request, raw in the
// body. Creates the working session and answers its first check
// result, session id included. deps carries the test stubs and the
// client's scaled flag; the HTTP wiring in server/index.js passes
// only { scaled }.
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
  try {
    await sweepUploadSessions();
    const { result } = await createUploadSession(body, deps);
    return sendJson(res, 200, result);
  } catch (err) {
    return sendJson(res, 500, { error: `The check failed: ${err.message}` });
  }
}

async function readJsonBody(req) {
  const read = await readBodyWithCap(req, 64 * 1024);
  if (read.tooLarge) throw httpError(413, "Request body too large.");
  if (read.aborted || !read.buffer) throw httpError(400, "Request body did not arrive complete.");
  try {
    return JSON.parse(read.buffer.toString("utf8") || "{}");
  } catch {
    throw httpError(400, "Request body must be JSON.");
  }
}

// The session surface, mirroring the takes': checks, repairs, repair,
// copy, readiness, media — all scoped to the one session in the path.
// Returns true when the request belonged to this surface.
async function handleUploadRoutes(req, res, url, deps = {}) {
  if (url.pathname === "/api/uploads/check" && req.method === "POST") {
    await handleUploadCheck(req, res, {
      ...deps,
      scaled: url.searchParams.get("scaled") === "1",
    });
    return true;
  }
  const match = url.pathname.match(
    /^\/api\/uploads\/([A-Za-z0-9-]+)\/(checks|repairs|repair|copy|readiness|media)$/
  );
  if (!match) {
    sendJson(res, 404, { error: "Unknown upload route." });
    return true;
  }
  const sessionId = match[1];
  const action = match[2];
  const variantParam = url.searchParams.get("variant");
  const variant = variantParam ? variantParam : null;
  try {
    if (!isValidVariantChain(variant)) throw httpError(400, "Unknown variant.");
    if (action === "checks" && req.method === "GET") {
      const { result } = await runSessionChecks(sessionId, variant, deps);
      sendJson(res, 200, result);
      return true;
    }
    if (action === "repairs" && req.method === "GET") {
      const out = await listSessionRepairs(sessionId, variant, deps);
      sendJson(res, 200, out);
      return true;
    }
    if (action === "repair" && req.method === "POST") {
      const input = await readJsonBody(req);
      const baseVariant =
        typeof input.baseVariant === "string" && input.baseVariant ? input.baseVariant : null;
      if (!isValidVariantChain(baseVariant)) throw httpError(400, "Unknown variant.");
      const out = await applySessionRepair(sessionId, input.repairId, baseVariant, deps);
      sendJson(res, 200, out);
      return true;
    }
    if (action === "copy" && req.method === "GET") {
      const out = await buildSessionCopy(sessionId, variant, deps);
      sendJson(res, 200, out);
      return true;
    }
    if (action === "readiness" && req.method === "POST") {
      const input = await readJsonBody(req);
      const out = await sessionReadiness(
        sessionId,
        typeof input.variant === "string" && input.variant ? input.variant : null,
        input,
        deps
      );
      sendJson(res, 200, out);
      return true;
    }
    if (action === "media" && req.method === "GET") {
      await requireSession(sessionId);
      const file = sessionMediaPath(sessionId, variant);
      if (!file || !fs.existsSync(file)) {
        throw httpError(404, "That version of the photo does not exist in this session.");
      }
      res.writeHead(200, { "Content-Type": "image/png" });
      res.end(await fs.promises.readFile(file));
      return true;
    }
    sendJson(res, 404, { error: "Unknown upload route." });
    return true;
  } catch (err) {
    sendJson(res, err.status || 500, { error: err.message });
    return true;
  }
}

module.exports = {
  handleUploadCheck,
  handleUploadRoutes,
  buildUploadChecks,
  runUploadChecks,
  createUploadSession,
  runSessionChecks,
  listSessionRepairs,
  applySessionRepair,
  buildSessionCopy,
  sessionReadiness,
  sessionMediaPath,
  sweepUploadSessions,
  readBodyWithCap,
  isPng,
  isValidVariantChain,
  MAX_UPLOAD_BYTES,
  UPLOAD_TMP_DIR,
  UPLOAD_INTENT,
  SESSION_TTL_MS,
  SESSION_ID_PATTERN,
};
