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
const { TAKES } = require("./seed-takes");
const { measureImage } = require("./measure");

const MEDIA_DIR = path.join(__dirname, "seed-media");
const measurementCache = new Map();

// Builds a take's check list. Every check carries its own source:
// - "measured": computed from the take's actual pixels by measure.js
//   (framing, crop safety, quality — for takes that have seeded media);
// - "designed": the take's designed state, standing in until the semantic
//   checks (text reading, first impression, audio) run through the models.
// The response-level source is "mixed" when both kinds are present.
async function buildChecks(take) {
  const checks = take.stubChecks.map((c) => ({ ...c, source: "designed" }));
  const pngPath = path.join(MEDIA_DIR, `${take.id}.png`);
  const sidecarPath = path.join(MEDIA_DIR, `${take.id}.json`);
  if (take.kind === "photo" && fs.existsSync(pngPath) && fs.existsSync(sidecarPath)) {
    if (!measurementCache.has(take.id)) {
      const buffer = fs.readFileSync(pngPath);
      const groundTruth = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
      measurementCache.set(take.id, await measureImage(buffer, groundTruth));
    }
    const m = measurementCache.get(take.id);
    const byId = Object.fromEntries(checks.map((c) => [c.id, c]));
    if (m.framing) Object.assign(byId.framing, { verdict: m.framing.verdict, detail: m.framing.detail, source: "measured" });
    if (m.cropSafety) Object.assign(byId.crop, { verdict: m.cropSafety.verdict, detail: m.cropSafety.detail, source: "measured" });
    Object.assign(byId.quality, { verdict: m.quality.verdict, detail: m.quality.detail, source: "measured" });
  }
  const anyMeasured = checks.some((c) => c.source === "measured");
  const allMeasured = checks.every((c) => c.source === "measured");
  return {
    take: publicTake(take),
    source: allMeasured ? "measured" : anyMeasured ? "mixed" : "stub",
    checks,
    privacyWarning: take.privacyWarning,
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
      checksMode: "partial",
      checksNote:
        "Framing, crop safety, and quality are measured from the seeded takes' pixels where seeded media exists. Text, first impression, and audio still report the takes' designed states until the model pipeline runs; every check in every response names its own source. No Model API call has been made yet.",
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
