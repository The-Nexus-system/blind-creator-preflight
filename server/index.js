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
const { measureImage, measureVideoFrames } = require("./measure");
const { Jimp } = require("jimp");
const { runSemanticChecks } = require("./semantic");
const { buildProofCopy, draftAltText, readiness, buildPublicDescription } = require("./copy");
const { availableRepairs, applyRepair } = require("./repair");
const { sweep } = require("./library");

const MEDIA_DIR = path.join(__dirname, "seed-media");
const REPAIRED_DIR = path.join(MEDIA_DIR, "repaired");
const measurementCache = new Map();
const semanticCache = new Map();
const videoMediaCache = new Map();

// The cover-frame repair's id, shared by the resolver (which serves the
// committed cover frames for it) and the repair endpoint (which applies
// it as a selection, writing no files).
const COVER_REPAIR_ID = "cover-frame-hands-up";

// Resolves a take's media: the original seeded image, or a repaired
// variant of it (variants live under seed-media/repaired and are produced
// only by the repair endpoints; originals are never modified).
function resolveMedia(take, variantId) {
  const base = variantId
    ? path.join(REPAIRED_DIR, `${take.id}--${variantId}`)
    : path.join(MEDIA_DIR, take.id);
  const pngPath = `${base}.png`;
  const sidecarPath = `${base}.json`;
  if (take.kind !== "photo" || !fs.existsSync(pngPath)) return null;
  return {
    buffer: fs.readFileSync(pngPath),
    groundTruth: fs.existsSync(sidecarPath)
      ? JSON.parse(fs.readFileSync(sidecarPath, "utf8"))
      : null,
  };
}

// Resolves a VIDEO take's media. The running server never decodes
// video (the deployed image has no ffmpeg): the frames the checks judge
// were extracted from the seeded video at seed-build time and committed
// beside it (tools/extract-seed-frames.js). A video media carries the
// recorded frame, the posted frame (the recorded frame through the
// post's 9:16 centre crop), and the take's sidecar; repairs produce new
// recorded frames under seed-media/repaired, whose posted frames are
// derived by the same crop the platform applies. The cover-frame
// variant resolves to the committed hands-up frames — choosing a cover
// frame selects media, it does not edit any.
async function resolveVideoMedia(take, variantId) {
  const cacheKey = `${take.id}|${variantId || ""}`;
  if (videoMediaCache.has(cacheKey)) return videoMediaCache.get(cacheKey);
  let framePath;
  let sidecarPath;
  let postedPath = null;
  if (variantId === COVER_REPAIR_ID) {
    framePath = path.join(MEDIA_DIR, `${take.id}-cover-frame.png`);
    postedPath = path.join(MEDIA_DIR, `${take.id}-cover-posted.png`);
    sidecarPath = path.join(MEDIA_DIR, `${take.id}.json`);
  } else if (variantId) {
    framePath = path.join(REPAIRED_DIR, `${take.id}--${variantId}.png`);
    sidecarPath = path.join(REPAIRED_DIR, `${take.id}--${variantId}.json`);
  } else {
    framePath = path.join(MEDIA_DIR, `${take.id}-frame.png`);
    postedPath = path.join(MEDIA_DIR, `${take.id}-posted.png`);
    sidecarPath = path.join(MEDIA_DIR, `${take.id}.json`);
  }
  let media = null;
  if (fs.existsSync(framePath) && fs.existsSync(sidecarPath)) {
    const sidecar = JSON.parse(fs.readFileSync(sidecarPath, "utf8"));
    if (sidecar && sidecar.postedCropWindow && sidecar.subject && sidecar.banner) {
      const frameBuffer = fs.readFileSync(framePath);
      let postedBuffer;
      if (postedPath && fs.existsSync(postedPath)) {
        postedBuffer = fs.readFileSync(postedPath);
      } else {
        const img = await Jimp.fromBuffer(frameBuffer);
        const win = sidecar.postedCropWindow;
        img.crop({
          x: Math.round(win.x0),
          y: Math.round(win.y0),
          w: Math.round(win.x1 - win.x0),
          h: Math.round(win.y1 - win.y0),
        });
        postedBuffer = await img.getBuffer("image/png");
      }
      media = {
        frameBuffer,
        postedBuffer,
        sidecar,
        // The measurement ground truth: the take's banner stands in the
        // protective slot measure.js calls the sign, under its own name.
        groundTruth: {
          subject: sidecar.subject,
          sign: sidecar.banner,
          labels: { sign: "banner" },
        },
      };
    }
  }
  videoMediaCache.set(cacheKey, media);
  return media;
}

// The repair context for a video take: its kind, and the cover-frame
// moment when the take has a hands-up window AND the committed cover
// frames exist to choose.
function videoRepairContext(take, sidecar) {
  const context = { kind: "video" };
  if (
    sidecar &&
    Array.isArray(sidecar.handsUpSeconds) &&
    fs.existsSync(path.join(MEDIA_DIR, `${take.id}-cover-frame.png`))
  ) {
    context.coverFrameAtSeconds =
      (sidecar.handsUpSeconds[0] + sidecar.handsUpSeconds[1]) / 2;
  }
  return context;
}

async function measureTake(take, variantId) {
  const key = `${take.id}|${variantId || ""}`;
  if (!measurementCache.has(key)) {
    if (take.kind === "video") {
      const vm = await resolveVideoMedia(take, variantId);
      if (!vm) return null;
      measurementCache.set(
        key,
        await measureVideoFrames(vm.frameBuffer, vm.postedBuffer, vm.sidecar)
      );
    } else {
      const media = resolveMedia(take, variantId);
      if (!media || !media.groundTruth) return null;
      measurementCache.set(
        key,
        await measureImage(media.buffer, media.groundTruth, media.groundTruth.contentBox || null)
      );
    }
  }
  return measurementCache.get(key);
}

// Builds a take's check list from the real pipelines. Every check carries
// its source, and no source is a stand-in verdict:
// - "measured": computed from the take's pixels by measure.js;
// - "model": judged by the semantic pipeline (Muse Spark);
// - "determined": settled by the take itself (a still photo has no audio);
// - "model-off" / "model-error" / "model-unreadable": the semantic check
//   honestly reporting "uncertain" with its reason — the design has always
//   allowed uncertain, and a failed or unfunded call never becomes a guess.
async function buildChecks(take, variantId) {
  const byId = {};
  for (const c of CHECKS) {
    byId[c.id] = { id: c.id, name: c.name, verdict: "uncertain", detail: "", source: "pending" };
  }
  let privacyWarning = null;
  let privacyWarningSource = null;

  const media = take.kind === "video" ? null : resolveMedia(take, variantId);
  const videoMedia = take.kind === "video" ? await resolveVideoMedia(take, variantId) : null;
  const hasMedia = Boolean(media || videoMedia);

  if (hasMedia) {
    const m = await measureTake(take, variantId);
    if (m) {
      if (m.framing) Object.assign(byId.framing, { verdict: m.framing.verdict, detail: m.framing.detail, source: "measured" });
      if (m.cropSafety) Object.assign(byId.crop, { verdict: m.cropSafety.verdict, detail: m.cropSafety.detail, source: "measured" });
      Object.assign(byId.quality, { verdict: m.quality.verdict, detail: m.quality.detail, source: "measured" });
    }

    // The semantic pipeline judges the frame the audience will see:
    // for a photo that is the photo; for a video it is the posted frame
    // — the crop is where a banner's word is lost, so the posted frame
    // is what text and first impression must be judged on.
    const semKey = `${take.id}|${variantId || ""}`;
    if (!semanticCache.has(semKey)) {
      semanticCache.set(
        semKey,
        await runSemanticChecks(videoMedia ? videoMedia.postedBuffer : media.buffer, take.intent)
      );
    }
    const sem = semanticCache.get(semKey);
    Object.assign(byId.text, { verdict: sem.text.verdict, detail: sem.text.detail, source: sem.source });
    Object.assign(byId.firstImpression, {
      verdict: sem.firstImpression.verdict,
      detail: sem.firstImpression.detail,
      source: sem.source,
    });
    privacyWarning = sem.privacyWarning;
    privacyWarningSource = sem.privacyWarningSource;

    if (videoMedia) {
      Object.assign(byId.audio, {
        verdict: "uncertain",
        detail: videoMedia.sidecar.silent
          ? "This video has no audio track: it is silent, so there is no speech to check — and silence the creator chose is not a defect."
          : "This video's audio track has not been transcribed or checked yet in this build, so the check cannot settle.",
        source: "determined",
      });
    } else {
      Object.assign(byId.audio, {
        verdict: "uncertain",
        detail: "Still photo: there is no audio track to check.",
        source: "determined",
      });
    }
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
    variant: variantId || null,
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

  if (url.pathname === "/api/library/sweep") {
    return sendJson(res, 200, sweep());
  }

  if (url.pathname === "/api/takes") {
    return sendJson(res, 200, { takes: TAKES.map(publicTake) });
  }

  const checkMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/checks$/);
  if (checkMatch) {
    const take = TAKES.find((t) => t.id === checkMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    buildChecks(take, url.searchParams.get("variant") || undefined)
      .then((body) => sendJson(res, 200, body))
      .catch((err) => sendJson(res, 500, { error: `Checks failed: ${err.message}` }));
    return;
  }

  const repairsMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/repairs$/);
  if (repairsMatch && req.method === "GET") {
    const take = TAKES.find((t) => t.id === repairsMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    (async () => {
      const media = take.kind === "video" ? await resolveVideoMedia(take) : resolveMedia(take);
      if (!media || !media.groundTruth) return sendJson(res, 200, { repairs: [] });
      const m = await measureTake(take);
      const context = take.kind === "video" ? videoRepairContext(take, media.sidecar) : undefined;
      sendJson(res, 200, { repairs: availableRepairs(m, media.groundTruth, context) });
    })().catch((err) => sendJson(res, 500, { error: `Repairs failed: ${err.message}` }));
    return;
  }

  const repairMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/repair$/);
  if (repairMatch && req.method === "POST") {
    const take = TAKES.find((t) => t.id === repairMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      (async () => {
        let input = {};
        try {
          input = JSON.parse(body || "{}");
        } catch {
          return sendJson(res, 400, { error: "Request body must be JSON." });
        }
        const media = take.kind === "video" ? await resolveVideoMedia(take) : resolveMedia(take);
        if (!media || !media.groundTruth) {
          return sendJson(res, 400, { error: "This take has no media to repair." });
        }
        const m = await measureTake(take);
        const context = take.kind === "video" ? videoRepairContext(take, media.sidecar) : undefined;
        const offeredList = availableRepairs(m, media.groundTruth, context);
        const offered = offeredList.map((r) => r.id);
        if (!offered.includes(input.repairId)) {
          return sendJson(res, 400, { error: `Repair ${input.repairId} is not offered for this take's current verdicts.` });
        }
        let changes;
        if (take.kind === "video" && input.repairId === COVER_REPAIR_ID) {
          // A cover-frame choice selects which committed frame
          // represents the post; no file is written and no pixel is
          // edited. The variant resolves to the hands-up frames.
          changes = [
            `Cover frame: the post will now open on the moment at ${Math.round(context.coverFrameAtSeconds)} seconds, inside the ${media.sidecar.handsUpSeconds[0]} to ${media.sidecar.handsUpSeconds[1]} second window where your hands are up signing.`,
            "The video itself is unchanged — nothing was redrawn, moved, or cut; only the frame chosen to represent the post has moved.",
          ];
        } else {
          const out = await applyRepair(
            take.kind === "video" ? media.frameBuffer : media.buffer,
            media.groundTruth,
            input.repairId,
            m
          );
          fs.mkdirSync(REPAIRED_DIR, { recursive: true });
          fs.writeFileSync(path.join(REPAIRED_DIR, `${take.id}--${input.repairId}.png`), out.buffer);
          // A repaired video variant's sidecar keeps the video shape:
          // the repair's transformed boxes under their own names. A
          // reframe also declares the box its picture occupies, so the
          // re-check measures the picture, not the repair's own border.
          const variantSidecar =
            take.kind === "video"
              ? {
                  ...media.sidecar,
                  subject: out.groundTruth.subject,
                  banner: out.groundTruth.sign,
                  ...(out.contentBox ? { contentBox: out.contentBox } : {}),
                }
              : {
                  ...out.groundTruth,
                  ...(out.contentBox ? { contentBox: out.contentBox } : {}),
                };
          fs.writeFileSync(
            path.join(REPAIRED_DIR, `${take.id}--${input.repairId}.json`),
            JSON.stringify(variantSidecar, null, 2)
          );
          changes = out.changes;
        }
        measurementCache.delete(`${take.id}|${input.repairId}`);
        semanticCache.delete(`${take.id}|${input.repairId}`);
        videoMediaCache.delete(`${take.id}|${input.repairId}`);
        const result = await buildChecks(take, input.repairId);
        const original = await buildChecks(take);
        const targetId = (offeredList.find((r) => r.id === input.repairId) || {}).fixesCheck;
        const rank = { fix: 0, uncertain: 1, pass: 2 };
        const beforeCheck = original.checks.find((c) => c.id === targetId);
        const afterCheck = result.checks.find((c) => c.id === targetId);
        const outcome =
          beforeCheck && afterCheck
            ? {
                checkId: targetId,
                checkName: beforeCheck.name,
                before: beforeCheck.verdict,
                after: afterCheck.verdict,
                improved: rank[afterCheck.verdict] > rank[beforeCheck.verdict],
                worse: rank[afterCheck.verdict] < rank[beforeCheck.verdict],
              }
            : null;
        sendJson(res, 200, { variantId: input.repairId, changes, outcome, result });
      })().catch((err) => sendJson(res, 500, { error: `Repair failed: ${err.message}` }));
    });
    return;
  }

  const copyMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/copy$/);
  if (copyMatch && req.method === "GET") {
    const take = TAKES.find((t) => t.id === copyMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    buildChecks(take, url.searchParams.get("variant") || undefined)
      .then((result) =>
        sendJson(res, 200, {
          take: publicTake(take),
          variant: result.variant,
          proofCopy: buildProofCopy(take, result),
          altText: draftAltText(take, result),
        })
      )
      .catch((err) => sendJson(res, 500, { error: `Copy failed: ${err.message}` }));
    return;
  }

  const publicDescMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/public-description$/);
  if (publicDescMatch && req.method === "GET") {
    const take = TAKES.find((t) => t.id === publicDescMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    buildChecks(take, url.searchParams.get("variant") || undefined)
      .then((result) => sendJson(res, 200, { take: publicTake(take), variant: result.variant, publicDescription: buildPublicDescription(take, result) }))
      .catch((err) => sendJson(res, 500, { error: `Public description failed: ${err.message}` }));
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
      buildChecks(take, typeof input.variant === "string" ? input.variant : undefined)
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
