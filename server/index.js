"use strict";

// Pre-Flight backend.
//
// One job: hold the Meta Model API key in backend secrets and make the
// Model API calls the checks need, so the key never appears in the client,
// the browser, or this repository. The key is read from the environment
// (MODEL_API_KEY); this file never contains it.
//
// Current state: the API serves the seeded takes and runs the real
// check pipelines — SAM 3.1 location plus pixel measurement for
// framing, crop safety, and quality; Muse Spark for text, first
// impression, and the private-information warning; Muse Voice
// Transcribe for the audio check. Live model calls are gated on the
// funding switch (MODEL_CALLS_ENABLED in model-api.js): while it is
// off, the model checks report "uncertain" with the reason, never a
// guessed verdict, and the measured checks run from the takes'
// recorded facts.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { TAKES, CHECKS } = require("./seed-takes");
const { measureImage, measureVideoFrames } = require("./measure");
const { Jimp } = require("jimp");
const { runSemanticChecks } = require("./semantic");
const { locateBoxes, resolvePhotoBoxes } = require("./sam");
const { runAudioCheck } = require("./audio");
const { buildDescribedAudio } = require("./narrate");
const { buildProofCopy, draftAltText, readiness, buildPublicDescription } = require("./copy");
const { availableRepairs, applyRepair, applyTransform, composeTransforms } = require("./repair");
const { sweep } = require("./library");

const MEDIA_DIR = path.join(__dirname, "seed-media");
const REPAIRED_DIR = path.join(MEDIA_DIR, "repaired");
const measurementCache = new Map();
const semanticCache = new Map();
const videoMediaCache = new Map();
const photoSamCache = new Map();
const videoSamCache = new Map();
const audioCache = new Map();
const describedCache = new Map();

// The cover-frame repair's id, shared by the resolver (which serves the
// committed cover frames for it) and the repair endpoint (which applies
// it as a selection, writing no files).
const COVER_REPAIR_ID = "cover-frame-hands-up";

// Repairs stack: a variant id is a chain of repair ids joined by "~",
// in the order the creator directed them. A bare repair id is a chain of
// one — every variant id issued before chains existed stays valid.
const CHAIN_SEP = "~";
const chainOf = (variantId) => (variantId ? variantId.split(CHAIN_SEP) : []);

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

// The repair context for a video take: its kind, the chain of repairs
// already directed (so none is offered twice), and the cover-frame
// moment when the take has a hands-up window AND the committed cover
// frames exist to choose.
function videoRepairContext(take, sidecar, variantId) {
  const context = { kind: "video", chain: chainOf(variantId) };
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

// The measurement a PHOTO take's checks use. An original take's boxes
// come from SAM 3.1 when it answers with a subject (server/sam.js holds
// the outcome rules: SAM boxes, recorded facts on a no-match or with
// calls off, and a reported failure otherwise); a repaired variant
// keeps the repair's own computed geometry. On a SAM failure the
// returned measurement carries quality only — framing and crop need
// boxes — and samFailure names the reason, so the checks go uncertain
// with it rather than guessing. Failures are not cached: a later
// request retries the call.
async function photoCheckMeasurement(take, variantId, media) {
  if (variantId) {
    return {
      measurement: await measureTake(take, variantId),
      boxesFrom: "recorded",
      measurementNote:
        "Framing and crop safety are measured from this repaired version's own geometry — the boxes the repair itself computed.",
      samFailure: null,
    };
  }
  if (!photoSamCache.has(take.id)) {
    const resolved = await resolvePhotoBoxes({
      buffer: media.buffer,
      recorded: media.groundTruth,
    });
    if (resolved.kind === "failed") {
      return {
        measurement: await measureImage(media.buffer, null, null),
        boxesFrom: "sam-failed",
        measurementNote: null,
        samFailure: resolved.reason,
      };
    }
    const measurement =
      resolved.kind === "sam"
        ? await measureImage(media.buffer, resolved.groundTruth, null)
        : await measureTake(take, null);
    photoSamCache.set(take.id, {
      measurement,
      boxesFrom: resolved.kind === "sam" ? "sam" : "recorded",
      measurementNote:
        resolved.kind === "sam"
          ? "Framing and crop safety are measured from boxes located by SAM 3.1."
          : resolved.samAnswered
            ? "SAM 3.1 was asked for the subject and the sign and returned no match in this take, so framing and crop safety are measured from the take's recorded facts."
            : null,
      samFailure: null,
    });
  }
  return photoSamCache.get(take.id);
}

// SAM on a VIDEO take's posted frame. The posted frame is the frame the
// audience sees, so a subject box SAM locates there can source the
// framing measurement; crop safety and quality stay with the take's
// recorded facts. Every other outcome — calls off, a failed call, or
// SAM returning no match (its answer for ST-V2's drawn frames, verified
// Oct 29, 2026) — leaves the recorded facts standing and changes no
// verdict. Returns { framing } when SAM sourced it, { answeredNoMatch:
// true } when SAM answered with no match, or null otherwise.
async function videoSamFraming(take, variantId, videoMedia) {
  const key = `${take.id}|${variantId || ""}`;
  if (!videoSamCache.has(key)) {
    let located = null;
    try {
      located = await locateBoxes(videoMedia.postedBuffer);
    } catch {
      located = null; // a failed call: the recorded facts stand
    }
    if (!located || located.status !== "ok") {
      videoSamCache.set(key, null);
    } else if (!located.subject) {
      videoSamCache.set(key, { answeredNoMatch: true });
    } else {
      const win = videoMedia.sidecar.postedCropWindow;
      const b = videoMedia.sidecar.banner;
      const postedSign = b
        ? { x0: b.x0 - win.x0, y0: b.y0 - win.y0, x1: b.x1 - win.x0, y1: b.y1 - win.y0 }
        : null;
      const pm = await measureImage(videoMedia.postedBuffer, {
        subject: located.subject,
        sign: postedSign,
      });
      videoSamCache.set(
        key,
        pm.framing
          ? {
              framing: {
                subjectTouchesEdges: pm.framing.subjectTouchesEdges,
                verdict: pm.framing.verdict,
                detail: pm.framing.subjectTouchesEdges.length
                  ? `In the post as it will be shown, the subject reaches the ${pm.framing.subjectTouchesEdges.join(" and ")} edge of the frame.`
                  : "In the post as it will be shown, the subject sits inside the frame with margin on every side.",
              },
            }
          : null
      );
    }
  }
  return videoSamCache.get(key);
}

// Builds a take's check list from the real pipelines. Every check carries
// its source, and no source is a stand-in verdict:
// - "measured": computed from the take's pixels by measure.js, using the
//   take's recorded facts (or a repair's computed geometry);
// - "sam": framing/crop measured from boxes located by SAM 3.1;
// - "model": judged by the semantic pipeline (Muse Spark) or, for the
//   audio check, from a Muse Voice Transcribe transcript;
// - "determined": settled by the take itself (a still photo has no audio;
//   a silent video has nothing to transcribe);
// - "model-off" / "model-error" / "model-unreadable": a model check
//   honestly reporting "uncertain" with its reason — the design has always
//   allowed uncertain, and a failed or unfunded call never becomes a guess.
async function buildChecks(take, variantId) {
  const byId = {};
  for (const c of CHECKS) {
    byId[c.id] = { id: c.id, name: c.name, verdict: "uncertain", detail: "", source: "pending" };
  }
  let privacyWarning = null;
  let privacyWarningSource = null;
  let transcript = null;
  let measurementSource = null;
  let measurementNote = null;

  const media = take.kind === "video" ? null : resolveMedia(take, variantId);
  const videoMedia = take.kind === "video" ? await resolveVideoMedia(take, variantId) : null;
  const hasMedia = Boolean(media || videoMedia);

  if (hasMedia && videoMedia) {
    const m = await measureTake(take, variantId);
    measurementSource = "recorded";
    if (m) {
      let framing = m.framing;
      let framingSource = "measured";
      const sam = await videoSamFraming(take, variantId, videoMedia);
      if (sam && sam.framing) {
        framing = sam.framing;
        framingSource = "sam";
        measurementSource = "sam";
        measurementNote =
          "Framing is measured from a subject box SAM 3.1 located on the posted frame; crop safety and quality are measured from the take's recorded facts.";
      } else if (sam && sam.answeredNoMatch) {
        measurementNote =
          "SAM 3.1 was asked about the posted frame and returned no match, so framing, crop safety, and quality are measured from the take's recorded facts.";
      }
      if (framing) {
        Object.assign(byId.framing, { verdict: framing.verdict, detail: framing.detail, source: framingSource });
      }
      if (m.cropSafety) {
        Object.assign(byId.crop, { verdict: m.cropSafety.verdict, detail: m.cropSafety.detail, source: "measured" });
      }
      Object.assign(byId.quality, { verdict: m.quality.verdict, detail: m.quality.detail, source: "measured" });
    }

    const audioKey = `${take.id}|${variantId || ""}`;
    if (!audioCache.has(audioKey)) {
      audioCache.set(audioKey, await runAudioCheck({ sidecar: videoMedia.sidecar }));
    }
    const audio = audioCache.get(audioKey);
    Object.assign(byId.audio, { verdict: audio.verdict, detail: audio.detail, source: audio.source });
    transcript = audio.transcript;
  } else if (hasMedia) {
    const pm = await photoCheckMeasurement(take, variantId, media);
    measurementSource = pm.boxesFrom;
    measurementNote = pm.measurementNote;
    const m = pm.measurement;
    if (m) {
      if (pm.samFailure) {
        const reason = `SAM 3.1 could not supply this take's measurements (${pm.samFailure}) Framing and crop safety cannot be measured without them, so both are uncertain rather than guessed.`;
        Object.assign(byId.framing, { verdict: "uncertain", detail: reason, source: "model-error" });
        Object.assign(byId.crop, { verdict: "uncertain", detail: reason, source: "model-error" });
      } else {
        const boxSource = pm.boxesFrom === "sam" ? "sam" : "measured";
        if (m.framing) {
          Object.assign(byId.framing, { verdict: m.framing.verdict, detail: m.framing.detail, source: boxSource });
        }
        if (m.cropSafety) {
          Object.assign(byId.crop, { verdict: m.cropSafety.verdict, detail: m.cropSafety.detail, source: boxSource });
        }
      }
      Object.assign(byId.quality, { verdict: m.quality.verdict, detail: m.quality.detail, source: "measured" });
    }
    Object.assign(byId.audio, {
      verdict: "uncertain",
      detail: "Still photo: there is no audio track to check.",
      source: "determined",
    });
  }

  if (hasMedia) {
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
  const allSettled = checks.every((c) => ["measured", "sam", "model", "determined"].includes(c.source));
  const anyRealCheck = checks.some((c) => ["measured", "sam", "model"].includes(c.source));
  return {
    take: publicTake(take),
    variant: variantId || null,
    source: allSettled && anyRealCheck ? "live" : "partial",
    measurementSource,
    measurementNote,
    transcript,
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
        "Framing and crop safety are measured from boxes located by SAM 3.1 when live calls are on; when SAM returns no match in a take, the take's recorded facts stand, and a failed SAM call makes those checks uncertain, never guessed. Sharpness and quality are measured from pixels. Text, first impression, and the privacy warning come from the Muse Spark semantic pipeline. A video's speech track is transcribed by Muse Voice Transcribe and the audio check is judged from the transcript; a silent take reports that there is nothing to transcribe, because the silence is part of the take. Model calls run only when the funding switch is on (MODEL_CALLS_ENABLED) — while it is off, model checks report uncertain with the reason, never a guessed verdict.",
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
      const variantId = url.searchParams.get("variant") || undefined;
      const media =
        take.kind === "video" ? await resolveVideoMedia(take, variantId) : resolveMedia(take, variantId);
      if (!media || !media.groundTruth) return sendJson(res, 200, { repairs: [] });
      const m = await measureTake(take, variantId);
      const context =
        take.kind === "video"
          ? videoRepairContext(take, media.sidecar, variantId)
          : { chain: chainOf(variantId) };
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
        // Repairs stack: the repair applies to the variant the creator
        // is currently looking at (input.baseVariant), or to the
        // original when no base is named. The result's variant id is
        // the chain, in the order the repairs were directed.
        const baseVariant =
          typeof input.baseVariant === "string" && input.baseVariant ? input.baseVariant : undefined;
        const media =
          take.kind === "video"
            ? await resolveVideoMedia(take, baseVariant)
            : resolveMedia(take, baseVariant);
        if (!media || !media.groundTruth) {
          return sendJson(res, 400, { error: "This take has no media to repair." });
        }
        const m = await measureTake(take, baseVariant);
        const context =
          take.kind === "video"
            ? videoRepairContext(take, media.sidecar, baseVariant)
            : { chain: chainOf(baseVariant) };
        const offeredList = availableRepairs(m, media.groundTruth, context);
        const offered = offeredList.map((r) => r.id);
        if (!offered.includes(input.repairId)) {
          return sendJson(res, 400, { error: `Repair ${input.repairId} is not offered for this take's current verdicts.` });
        }
        const resultVariantId = baseVariant ? `${baseVariant}${CHAIN_SEP}${input.repairId}` : input.repairId;
        let changes;
        if (take.kind === "video" && input.repairId === COVER_REPAIR_ID && !baseVariant) {
          // A cover-frame choice on the original selects which
          // committed frame represents the post; no file is written
          // and no pixel is edited. The variant resolves to the
          // hands-up frames.
          changes = [
            `Cover frame: the post will now open on the moment at ${Math.round(context.coverFrameAtSeconds)} seconds, inside the ${media.sidecar.handsUpSeconds[0]} to ${media.sidecar.handsUpSeconds[1]} second window where your hands are up signing.`,
            "The video itself is unchanged — nothing was redrawn, moved, or cut; only the frame chosen to represent the post has moved.",
          ];
        } else if (take.kind === "video" && input.repairId === COVER_REPAIR_ID) {
          // A cover-frame choice stacked on a reframed variant: the
          // reframe is one transform applied to the whole take, so the
          // hands-up moment is brought into the chain's exact geometry
          // by replaying the chain's composed transform on the cover
          // frame. The result is a real variant with its own files.
          const transform = media.sidecar && media.sidecar.reframeTransform;
          if (!transform) {
            return sendJson(res, 400, { error: "This chain has no reframe to carry the cover frame into; the cover choice cannot stack here." });
          }
          const origSidecar = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, `${take.id}.json`), "utf8"));
          const coverFrame = fs.readFileSync(path.join(MEDIA_DIR, `${take.id}-cover-frame.png`));
          const out = await applyTransform(
            coverFrame,
            { subject: origSidecar.subject, sign: origSidecar.banner, privateItem: origSidecar.privateItem },
            transform
          );
          fs.mkdirSync(REPAIRED_DIR, { recursive: true });
          fs.writeFileSync(path.join(REPAIRED_DIR, `${take.id}--${resultVariantId}.png`), out.buffer);
          const variantSidecar = {
            ...media.sidecar,
            subject: out.groundTruth.subject,
            banner: out.groundTruth.sign,
            contentBox: out.contentBox,
            reframeTransform: transform,
          };
          fs.writeFileSync(
            path.join(REPAIRED_DIR, `${take.id}--${resultVariantId}.json`),
            JSON.stringify(variantSidecar, null, 2)
          );
          changes = [
            `Cover frame: the post will now open on the moment at ${Math.round(context.coverFrameAtSeconds)} seconds, inside the ${media.sidecar.handsUpSeconds[0]} to ${media.sidecar.handsUpSeconds[1]} second window where your hands are up signing.`,
            "The moment was brought into the reframed picture you already approved — the same pull-back, applied to that frame — so the whole banner and both hands are inside the post.",
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
          fs.writeFileSync(path.join(REPAIRED_DIR, `${take.id}--${resultVariantId}.png`), out.buffer);
          // A repaired video variant's sidecar keeps the video shape:
          // the repair's transformed boxes under their own names. A
          // reframe also declares the box its picture occupies, so the
          // re-check measures the picture, not the repair's own border,
          // and records the chain's composed reframe transform, so a
          // later cover-frame choice can be replayed into the same
          // geometry. A repair that moves no pixels (exposure) carries
          // the base's box and transform forward unchanged.
          const baseTransform =
            take.kind === "video" ? media.sidecar && media.sidecar.reframeTransform : media.groundTruth.reframeTransform;
          const chainTransform = out.transform
            ? composeTransforms(baseTransform || null, out.transform)
            : baseTransform;
          const chainContentBox =
            out.contentBox ||
            (take.kind === "video" ? media.sidecar && media.sidecar.contentBox : media.groundTruth.contentBox);
          const variantSidecar =
            take.kind === "video"
              ? {
                  ...media.sidecar,
                  subject: out.groundTruth.subject,
                  banner: out.groundTruth.sign,
                  ...(chainContentBox ? { contentBox: chainContentBox } : {}),
                  ...(chainTransform ? { reframeTransform: chainTransform } : {}),
                }
              : {
                  ...out.groundTruth,
                  ...(chainContentBox ? { contentBox: chainContentBox } : {}),
                  ...(chainTransform ? { reframeTransform: chainTransform } : {}),
                };
          fs.writeFileSync(
            path.join(REPAIRED_DIR, `${take.id}--${resultVariantId}.json`),
            JSON.stringify(variantSidecar, null, 2)
          );
          changes = out.changes;
        }
        measurementCache.delete(`${take.id}|${resultVariantId}`);
        semanticCache.delete(`${take.id}|${resultVariantId}`);
        videoMediaCache.delete(`${take.id}|${resultVariantId}`);
        videoSamCache.delete(`${take.id}|${resultVariantId}`);
        audioCache.delete(`${take.id}|${resultVariantId}`);
        describedCache.delete(`${take.id}|${resultVariantId}`);
        const result = await buildChecks(take, resultVariantId);
        const before = await buildChecks(take, baseVariant);
        const targetId = (offeredList.find((r) => r.id === input.repairId) || {}).fixesCheck;
        const rank = { fix: 0, uncertain: 1, pass: 2 };
        const beforeCheck = before.checks.find((c) => c.id === targetId);
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
        sendJson(res, 200, { variantId: resultVariantId, changes, outcome, result });
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

  const describedMatch = url.pathname.match(/^\/api\/takes\/([A-Za-z0-9-]+)\/described-audio$/);
  if (describedMatch && req.method === "GET") {
    const take = TAKES.find((t) => t.id === describedMatch[1]);
    if (!take) return sendJson(res, 404, { error: "Unknown take id." });
    if (take.kind !== "video") {
      return sendJson(res, 200, {
        take: publicTake(take),
        describedAudio: {
          available: false,
          reason:
            "Described audio belongs to video: a still photo has no timeline to narrate. A photo's own texts are its alt text and its proof copy.",
        },
      });
    }
    (async () => {
      const variantId = url.searchParams.get("variant") || undefined;
      const vm = await resolveVideoMedia(take, variantId);
      if (!vm) {
        return sendJson(res, 200, {
          take: publicTake(take),
          variant: variantId || null,
          describedAudio: await buildDescribedAudio(take, null, null),
        });
      }
      const key = `${take.id}|${variantId || ""}`;
      if (!describedCache.has(key)) {
        let transcript = null;
        if (!vm.sidecar.silent) {
          if (!audioCache.has(key)) {
            audioCache.set(key, await runAudioCheck({ sidecar: vm.sidecar }));
          }
          transcript = audioCache.get(key).transcript;
        }
        describedCache.set(key, await buildDescribedAudio(take, vm.sidecar, transcript));
      }
      sendJson(res, 200, {
        take: publicTake(take),
        variant: variantId || null,
        describedAudio: describedCache.get(key),
      });
    })().catch((err) => sendJson(res, 500, { error: `Described audio failed: ${err.message}` }));
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
