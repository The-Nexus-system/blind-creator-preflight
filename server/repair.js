"use strict";

// Deterministic repairs — Day 5.
//
// The loop the design promises: check → the creator directs a fix →
// Pre-Flight performs it → what changed is described in measurable terms →
// the checks run again → the creator approves, adjusts, or undoes.
//
// Repairs are deterministic image operations, never generative: reframe
// (scale the take down onto a same-size canvas filled from the take's own
// edge colour, positioned so the content that matters lands where it must)
// and brightness. Each repair transforms the ground-truth boxes with the
// same mathematics it applies to the pixels — a pixel at position p lands
// at p * factor + offset — so the re-check measures the repaired take
// exactly as it measured the original. For real uploads, segmentation
// re-runs on the repaired image instead; the loop is the same.
//
// Repairs always apply to the ORIGINAL take. "Adjust" means choosing a
// different repair from the original; "undo" means returning to it. The
// original is never modified.

const { Jimp } = require("jimp");
const { centreCropWindow, CROPS } = require("./measure");

function unionBox(boxes) {
  const present = boxes.filter(Boolean);
  if (!present.length) return null;
  return {
    x0: Math.min(...present.map((b) => b.x0)),
    y0: Math.min(...present.map((b) => b.y0)),
    x1: Math.max(...present.map((b) => b.x1)),
    y1: Math.max(...present.map((b) => b.y1)),
  };
}

function safeArea(width, height) {
  // Intersection of every platform crop window: the region that survives
  // all crops whole.
  let area = { x0: 0, y0: 0, x1: width, y1: height };
  for (const crop of CROPS) {
    const w = centreCropWindow(width, height, crop.ratio);
    area = {
      x0: Math.max(area.x0, w.x0),
      y0: Math.max(area.y0, w.y0),
      x1: Math.min(area.x1, w.x1),
      y1: Math.min(area.y1, w.y1),
    };
  }
  return area;
}

function transformBox(box, factor, offX, offY) {
  if (!box) return null;
  return {
    x0: Math.round(box.x0 * factor + offX),
    y0: Math.round(box.y0 * factor + offY),
    x1: Math.round(box.x1 * factor + offX),
    y1: Math.round(box.y1 * factor + offY),
  };
}

// Scales the take by `factor` and composites it onto a same-size canvas so
// that the original point (tx, ty) lands on the frame point (dx, dy),
// clamped so a pulled-back image never hangs off the canvas.
async function reframe(buffer, groundTruth, factor, tx, ty, dx, dy) {
  const img = await Jimp.fromBuffer(buffer);
  const { width, height } = img.bitmap;
  const fill = img.getPixelColor(0, 0); // the take's own edge colour
  const scaled = img.clone().scale(factor);
  const canvas = new Jimp({ width, height, color: fill });
  const maxOffX = width - scaled.bitmap.width;
  const maxOffY = height - scaled.bitmap.height;
  const offX = Math.round(Math.max(0, Math.min(maxOffX, dx - tx * factor)));
  const offY = Math.round(Math.max(0, Math.min(maxOffY, dy - ty * factor)));
  canvas.composite(scaled, offX, offY);
  const gt = {
    subject: transformBox(groundTruth.subject, factor, offX, offY),
    sign: transformBox(groundTruth.sign, factor, offX, offY),
    privateItem: transformBox(groundTruth.privateItem, factor, offX, offY),
  };
  // The rectangle the picture itself occupies inside the repaired frame.
  // Everything outside it is this repair's own flat fill; the repair
  // declares the box so the quality measurement can judge the picture
  // rather than the scaffolding around it (Nexus ruling, Oct 29, 2026).
  const contentBox = {
    x0: offX,
    y0: offY,
    x1: offX + scaled.bitmap.width,
    y1: offY + scaled.bitmap.height,
  };
  return { buffer: await canvas.getBuffer("image/png"), groundTruth: gt, contentBox };
}

// Which repairs apply, given a measurement of the original take. The
// optional context carries what the measurement cannot say: the take's
// kind, and for a video with a hands-up window, the moment a cover-frame
// choice would land on (the repairs endpoint derives both from the take
// and its sidecar).
function availableRepairs(measurement, groundTruth, context) {
  const repairs = [];
  const isVideo = Boolean(context && context.kind === "video");
  if (measurement.framing && measurement.framing.verdict === "fix" && !isVideo) {
    // Not offered for a video: a Reel's framing is judged in the posted
    // frame, and a 12 percent pull-back of the wide recording cannot
    // centre the subject inside the vertical post — the fit-crops
    // reframe below is the repair that does that, so it is the one
    // offered.
    repairs.push({
      id: "reframe-margin",
      name: "Reframe: pull back so the subject has margin on every side",
      fixesCheck: "framing",
    });
  }
  if (measurement.cropSafety && measurement.cropSafety.verdict === "fix") {
    const signName = (groundTruth.labels && groundTruth.labels.sign) || "sign";
    repairs.push({
      id: "reframe-fit-crops",
      name: `Reframe: pull back until the subject and ${signName} fit inside every platform crop`,
      fixesCheck: "crop",
    });
  }
  if (
    measurement.quality &&
    measurement.quality.verdict === "fix" &&
    (measurement.meanBrightness < 0.12 || measurement.meanBrightness > 0.93)
  ) {
    repairs.push({
      id: "brightness-auto",
      name: "Exposure: fix it automatically — Pre-Flight measures, adjusts, and measures again",
      fixesCheck: "quality",
    });
  }
  if (context && typeof context.coverFrameAtSeconds === "number") {
    // A cover-frame choice is a selection, not a pixel edit: it is
    // offered whenever the take has a hands-up window to choose from,
    // and applying it produces the variant that opens on that moment.
    repairs.push({
      id: "cover-frame-hands-up",
      name: `Cover frame: use the moment at ${Math.round(context.coverFrameAtSeconds)} seconds, where your hands are up signing`,
      fixesCheck: "firstImpression",
    });
  }
  return repairs;
}

async function applyRepair(buffer, groundTruth, repairId, measurement) {
  const probe = await Jimp.fromBuffer(buffer);
  const { width, height } = probe.bitmap;

  if (repairId === "reframe-margin") {
    const s = groundTruth.subject;
    const factor = 0.88; // a plain pull-back; the margin math is reported below
    const out = await reframe(buffer, groundTruth, factor, width / 2, height / 2, width / 2, height / 2);
    const before = Math.min(s.x0, s.y0, width - s.x1, height - s.y1);
    const ns = out.groundTruth.subject;
    const after = Math.min(ns.x0, ns.y0, width - ns.x1, height - ns.y1);
    out.changes = [
      `Pulled the frame back to ${Math.round(factor * 100)} percent, centred.`,
      `The subject's closest edge moved from ${Math.round((before / width) * 100)} percent of the frame to ${Math.round((after / width) * 100)} percent.`,
      "The border is filled from the take's own edge colour; no content was invented.",
    ];
    return out;
  }

  if (repairId === "reframe-fit-crops") {
    const area = safeArea(width, height);
    const union = unionBox([groundTruth.subject, groundTruth.sign]);
    const uw = union.x1 - union.x0;
    const uh = union.y1 - union.y0;
    const factor = Math.min((area.x1 - area.x0) / uw, (area.y1 - area.y0) / uh, 1) * 0.99;
    const ucx = (union.x0 + union.x1) / 2;
    const ucy = (union.y0 + union.y1) / 2;
    const acx = (area.x0 + area.x1) / 2;
    const acy = (area.y0 + area.y1) / 2;
    const out = await reframe(buffer, groundTruth, factor, ucx, ucy, acx, acy);
    const signName = (groundTruth.labels && groundTruth.labels.sign) || "sign";
    out.changes = [
      `Pulled the frame back to ${Math.round(factor * 100)} percent and centred everything that matters inside the safe area the platform crops share.`,
      `Before, the subject and ${signName} together spanned ${Math.round((uw / width) * 100)} percent of the frame's width; the safe area allows ${Math.round(((area.x1 - area.x0) / width) * 100)} percent.`,
      "The border is filled from the take's own edge colour; no content was invented.",
    ];
    return out;
  }

  if (repairId === "brightness-auto") {
    // Exposure is never the creator's problem to tune — a blind creator
    // cannot judge a brightness slider, and no user should have to. This
    // repair is fully automatic and self-verifying: it measures, applies a
    // stated per-channel gain, measures again, and adjusts once more if
    // the exposure is still out of range. What it returns is the best
    // measured result, and the changes text reports the measured outcome
    // either way — including when the original's clipped detail cannot be
    // recovered, which no honest repair may pretend to fix.
    // (The image library's own brightness() was measured and rejected: at
    // -0.45 it crushed a seeded take to pure black, unrecoverably.)
    const { measureImage } = require("./measure");
    let current = buffer;
    let totalGain = 1;
    let beforeMean = measurement.meanBrightness;
    let afterMean = beforeMean;
    for (let pass = 0; pass < 2; pass++) {
      const mean = pass === 0 ? beforeMean : afterMean;
      if (mean >= 0.12 && mean <= 0.93) break;
      const gain = Math.max(0.2, Math.min(5, 0.5 / Math.max(mean, 0.01)));
      current = await applyGain(current, gain);
      totalGain *= gain;
      const remeasured = await measureImage(current, groundTruth);
      afterMean = remeasured.meanBrightness;
    }
    const recovered = afterMean >= 0.12 && afterMean <= 0.93;
    return {
      buffer: current,
      groundTruth,
      changes: [
        `Exposure adjusted automatically by a total gain of ${totalGain.toFixed(2)}: measured mean brightness moved from ${beforeMean.toFixed(2)} to ${afterMean.toFixed(2)} of 1.`,
        recovered
          ? "The exposure now measures inside the plain thresholds. No slider was offered and none was needed."
          : "The exposure could not be brought fully into range — detail the original exposure clipped away cannot be recovered by any adjustment, and this repair does not pretend otherwise.",
        "Nothing was moved, cropped, or invented; only the exposure changed.",
      ],
    };
  }

  throw new Error(`Unknown repair id: ${repairId}`);
}

// Multiplies every pixel's RGB by `gain`, clamped to the valid range.
// Exported for the tests, which darken a take with it to exercise the
// brightness repair honestly.
async function applyGain(buffer, gain) {
  const img = await Jimp.fromBuffer(buffer);
  const data = img.bitmap.data;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = Math.max(0, Math.min(255, Math.round(data[i] * gain)));
    data[i + 1] = Math.max(0, Math.min(255, Math.round(data[i + 1] * gain)));
    data[i + 2] = Math.max(0, Math.min(255, Math.round(data[i + 2] * gain)));
  }
  return img.getBuffer("image/png");
}

module.exports = { availableRepairs, applyRepair, safeArea, unionBox, applyGain };
