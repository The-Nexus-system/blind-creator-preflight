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
      checksMode: "stub",
      checksNote:
        "Stub verdicts from the seeded takes' designed states. The measured checks pipeline replaces these; no Model API call has been made yet.",
    });
  }

  if (url.pathname === "/api/takes") {
    return sendJson(res, 200, { takes: TAKES.map(publicTake) });
  }

  const checkMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/checks$/);
  if (checkMatch) {
    const take = TAKES.find((t) => t.id === checkMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    return sendJson(res, 200, {
      take: publicTake(take),
      source: "stub",
      checks: take.stubChecks,
      privacyWarning: take.privacyWarning,
    });
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
