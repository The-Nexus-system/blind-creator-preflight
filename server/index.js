"use strict";

// Pre-Flight backend.
//
// One job: hold the Meta Model API key in backend secrets and make the
// Model API calls the checks need, so the key never appears in the client,
// the browser, or this repository. The key is read from the environment
// (MODEL_API_KEY); this file never contains it.
//
// Current state (scaffold): the API serves the seeded takes and STUB check
// verdicts (see seed-takes.js) so the client and the reporting shape can be
// built and tested deterministically. The checks pipeline replaces the stubs
// with measured verdicts from real Model API calls once the hackathon credit
// is visible in the account's Billing page; no paid call is made before then.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { TAKES, CHECKS } = require("./seed-takes");
const { measureImage } = require("./measure");
const { runSemanticChecks } = require("./semantic");
const { buildProofCopy, draftAltText, readiness } = require("./copy");

const MEDIA_DIR = path.join(__dirname, "seed-media");
const measurementCache = new Map();
const semanticCache = new Map();

// Builds a take's check list from the real pipelines. Every check carries
// its source, and no source is a stand-in verdict:
// - "measured": computed from the take's pixels by measure.js;
// - "model": judged by the semantic pipeline (Muse Spark);
// - "determined": settled by the take itself (a still photo has no audio);
// - "model-off" / "model-error" / "model-unreadable": the semantic check
//   honestly reporting "uncertain" with its reason — the design has always
//   allowed uncertain, and a failed or unfunded call never becomes a guess.
async function buildChecks(take) {
  const byId = {};
  for (const c of CHECKS) {
    byId[c.id] = { id: c.id, name: c.name, verdict: "uncertain", detail: "", source: "pending" };
  }
  let privacyWarning = null;
  let privacyWarningSource = null;

  const pngPath = path.join(MEDIA_DIR, `${take.id}.png`);
  const sidecarPath = path.join(MEDIA_DIR, `${take.id}.json`);
  const hasMedia = take.kind === "photo" && fs.existsSync(pngPath);

  if (hasMedia) {
    const buffer = fs.readFileSync(pngPath);

    if (fs.existsSync(sidecarPath)) {
      if (!measurementCache.has(take.id)) {
        const groundTruth = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
        measurementCache.set(take.id, await measureImage(buffer, groundTruth));
      }
      const m = measurementCache.get(take.id);
      if (m.framing) Object.assign(byId.framing, { verdict: m.framing.verdict, detail: m.framing.detail, source: "measured" });
      if (m.cropSafety) Object.assign(byId.crop, { verdict: m.cropSafety.verdict, detail: m.cropSafety.detail, source: "measured" });
      Object.assign(byId.quality, { verdict: m.quality.verdict, detail: m.quality.detail, source: "measured" });
    }

    if (!semanticCache.has(take.id)) {
      semanticCache.set(take.id, await runSemanticChecks(buffer, take.intent));
    }
    const sem = semanticCache.get(take.id);
    Object.assign(byId.text, { verdict: sem.text.verdict, detail: sem.text.detail, source: sem.source });
    Object.assign(byId.firstImpression, {
      verdict: sem.firstImpression.verdict,
      detail: sem.firstImpression.detail,
      source: sem.source,
    });
    privacyWarning = sem.privacyWarning;
    privacyWarningSource = sem.privacyWarningSource;

    Object.assign(byId.audio, {
      verdict: "uncertain",
      detail: "Still photo: there is no audio track to check.",
      source: "determined",
    });
  } else {
    const noMedia = `This seeded ${take.kind} has no media file yet, so there is nothing to measure or judge.`;
    for (const id of ["framing", "crop", "quality", "text", "firstImpression", "audio"]) {
      Object.assign(byId[id], { verdict: "uncertain", detail: noMedia, source: "determined" });
    }
  }

  // The designed privacy warning exercises the warning path only while the
  // model check has not run; a live model answer replaces it entirely.
  if (!privacyWarning && privacyWarningSource === "model-off" && take.designedPrivacyWarning) {
    privacyWarning = take.designedPrivacyWarning;
    privacyWarningSource = "designed";
  }

  const checks = CHECKS.map((c) => byId[c.id]);
  const allSettled = checks.every((c) => ["measured", "model", "determined"].includes(c.source));
  const anyRealCheck = checks.some((c) => ["measured", "model"].includes(c.source));
  return {
    take: publicTake(take),
    source: allSettled && anyRealCheck ? "live" : "partial",
    checks,
    privacyWarning,
    privacyWarningSource,
  };
}

const PORT = Number(process.env.PORT || 8787);
const CLIENT_DIR = path.join(__dirname, "..", "client");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(data);
}

function publicTake(take) {
  return { id: take.id, kind: take.kind, title: take.title, intent: take.intent };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/health") {
    return sendJson(res, 200, {
      ok: true,
      service: "blind-creator-preflight-backend",
      // Presence only. The value itself is never reported anywhere.
      modelApiKeyConfigured: Boolean(process.env.MODEL_API_KEY),
      checksMode: "pipelines",
      checksNote:
        "Framing, crop safety, and quality are measured from pixels; text, first impression, and the privacy warning come from the Muse Spark semantic pipeline; audio is determined by the take itself. Semantic calls run only when the funding switch is on (MODEL_CALLS_ENABLED) — while it is off, those checks report uncertain with the reason, never a guessed verdict.",
    });
  }

  if (url.pathname === "/api/takes") {
    return sendJson(res, 200, { takes: TAKES.map(publicTake) });
  }

  const checkMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/checks$/);
  if (checkMatch) {
    const take = TAKES.find((t) => t.id === checkMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    buildChecks(take)
      .then((body) => sendJson(res, 200, body))
      .catch((err) => sendJson(res, 500, { error: `Checks failed: ${err.message}` }));
    return;
  }

  const copyMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/copy$/);
  if (copyMatch && req.method === "GET") {
    const take = TAKES.find((t) => t.id === copyMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    buildChecks(take)
      .then((result) =>
        sendJson(res, 200, {
          take: publicTake(take),
          proofCopy: buildProofCopy(take, result),
          altText: draftAltText(take, result),
        })
      )
      .catch((err) => sendJson(res, 500, { error: `Copy failed: ${err.message}` }));
    return;
  }

  const readinessMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/readiness$/);
  if (readinessMatch && req.method === "POST") {
    const take = TAKES.find((t) => t.id === readinessMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let input = {};
      try {
        input = JSON.parse(body || "{}");
      } catch {
        return sendJson(res, 400, { error: "Request body must be JSON." });
      }
      buildChecks(take)
        .then((result) =>
          sendJson(
            res,
            200,
            readiness(result, {
              warningAcknowledged: Boolean(input.warningAcknowledged),
              altTextApproved: Boolean(input.altTextApproved),
            })
          )
        )
        .catch((err) => sendJson(res, 500, { error: `Readiness failed: ${err.message}` }));
    });
    return;
  }

  // Static client.
  const rel = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const filePath = path.join(CLIENT_DIR, rel);
  if (!filePath.startsWith(CLIENT_DIR) || !fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Not found.");
  }
  const ext = path.extname(filePath);
  res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Pre-Flight backend listening on http://localhost:${PORT}`);
});
