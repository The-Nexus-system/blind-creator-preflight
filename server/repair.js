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
// Repairs apply to the take the creator is currently looking at — the
// original, or the result of repairs already directed (a chain). "Undo"
// means returning to the original, which is never modified. A chain is
// how the creator directs fixes the way a sighted creator applies them:
// one after another, each on the result of the last.

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
  const scaled = img.clone().scale(factor);
  const maxOffX = width - scaled.bitmap.width;
  const maxOffY = height - scaled.bitmap.height;
  const offX = Math.round(Math.max(0, Math.min(maxOffX, dx - tx * factor)));
  const offY = Math.round(Math.max(0, Math.min(maxOffY, dy - ty * factor)));
  return applyTransform(buffer, groundTruth, { factor, offX, offY });
}

// Applies an exact reframe transform — scale by factor, composite at the
// given offsets onto a same-size canvas filled from the take's own edge
// colour. A reframe IS one transform applied to a whole take, so a chain
// can replay it exactly on another frame of the same take (the cover
// frame) and land in precisely the same geometry.
async function applyTransform(buffer, groundTruth, transform) {
  const img = await Jimp.fromBuffer(buffer);
  const { width, height } = img.bitmap;
  const { factor, offX, offY } = transform;
  const fill = img.getPixelColor(0, 0); // the take's own edge colour
  const scaled = img.clone().scale(factor);
  const canvas = new Jimp({ width, height, color: fill });
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
  return {
    buffer: await canvas.getBuffer("image/png"),
    groundTruth: gt,
    contentBox,
    transform: { factor, offX, offY },
  };
}

// The single transform equivalent to applying t1, then t2: a point p
// lands at f2 * (f1 * p + o1) + o2. Chains record the composed transform
// so a later frame of the take can be brought into the chain's exact
// geometry in one replay.
function composeTransforms(t1, t2) {
  if (!t1) return t2 || null;
  if (!t2) return t1;
  return {
    factor: t1.factor * t2.factor,
    offX: Math.round(t2.factor * t1.offX + t2.offX),
    offY: Math.round(t2.factor * t1.offY + t2.offY),
  };
}

// Composes a video's chosen cover frame into a poster (Option B,
// Nexus ruling, Nov 1, 2026). Selecting a cover moment used to serve
// the wide recorded frame as-is, and the first-impression check read
// it honestly: a small, low, off-centre figure under a dominating
// dark background. A cover is a poster, so the repair now composes
// one — deterministically, from the chosen frame alone:
//
//   - The poster picture is the region holding the subject and the
//     WHOLE sign. (The crop check protects the sign whole — a tighter
//     crop that let the sign's ends fall out of frame would fail the
//     take's own re-check — so the region is the subject and the sign
//     together, no more and no less.)
//   - That region is scaled to fill the platform safe area and placed
//     ON THE SUBJECT: the subject sits centred in the frame —
//     vertically exactly, horizontally as far as the sign's fit
//     allows — instead of wherever the wide shot happened to leave
//     it. The canvas around the picture is filled from the frame's
//     own edge colour.
//   - Every recorded box is carried through the same mathematics, so
//     the variant's sidecar describes the composed frame exactly and
//     the standard re-check measures the poster that was produced.
//
// `boxes` are the take's ORIGINAL boxes: { subject, sign, privateItem,
// extras } (extras: any further named boxes to carry — the sign's text
// and word boxes — keyed as the sidecar keys them). `baseTransform`
// is the chain's composed transform so far (original → base variant),
// or null when the cover is chosen on the original. The composition
// is computed in the base variant's geometry and applied to the
// chosen frame in a single crop-and-scale, so a stacked cover lands
// on the same poster the bare choice produces.
async function composeCoverFrame(buffer, boxes, baseTransform) {
  const img = await Jimp.fromBuffer(buffer);
  const { width, height } = img.bitmap;
  const bf = baseTransform ? baseTransform.factor : 1;
  const boX = baseTransform ? baseTransform.offX : 0;
  const boY = baseTransform ? baseTransform.offY : 0;
  const inBase = (box) => (box ? transformBox(box, bf, boX, boY) : null);
  const subjectB = inBase(boxes.subject);
  if (!subjectB) throw new Error("A cover composition needs the take's subject.");
  const signB = inBase(boxes.sign);

  // The poster region, in base-variant coordinates: the subject and
  // the whole sign together, clamped to the frame.
  const essential = unionBox([subjectB, signB]);
  const region = {
    x0: Math.max(0, essential.x0),
    y0: Math.max(0, essential.y0),
    x1: Math.min(width, essential.x1),
    y1: Math.min(height, essential.y1),
  };
  const regionW = region.x1 - region.x0;
  const regionH = region.y1 - region.y0;

  // Scale the region to the safe area and place it: horizontally the
  // region centres in the safe area; vertically the SUBJECT centres
  // in the frame (clamped so the picture never leaves the frame). The
  // fit keeps a small margin inside the safe area — a poster does not
  // set its picture edge-to-edge against the platform crops, and the
  // margin is what lets the re-check's own box estimates agree that
  // the sign survives the crops whole.
  const safe = safeArea(width, height);
  const scale = Math.min((safe.x1 - safe.x0) / regionW, (safe.y1 - safe.y0) / regionH) * 0.96;
  const picW = Math.round(regionW * scale);
  const picH = Math.round(regionH * scale);
  const offX = Math.round((safe.x0 + safe.x1) / 2 - picW / 2);
  const subjectCyB = (subjectB.y0 + subjectB.y1) / 2;
  const offY = Math.max(
    0,
    Math.min(height - picH, Math.round(height / 2 - (subjectCyB - region.y0) * scale))
  );

  // The pixels: the chosen frame cropped to the same region, expressed
  // back in the frame's own coordinates, scaled once, composited onto
  // a canvas filled from the frame's own edge colour.
  const rawX0 = Math.max(0, Math.round((region.x0 - boX) / bf));
  const rawY0 = Math.max(0, Math.round((region.y0 - boY) / bf));
  const rawX1 = Math.min(width, Math.round((region.x1 - boX) / bf));
  const rawY1 = Math.min(height, Math.round((region.y1 - boY) / bf));
  const fill = img.getPixelColor(0, 0); // the take's own edge colour
  const picture = img
    .clone()
    .crop({ x: rawX0, y: rawY0, w: Math.max(1, rawX1 - rawX0), h: Math.max(1, rawY1 - rawY0) })
    .scale(scale * bf);
  const canvas = new Jimp({ width, height, color: fill });
  canvas.composite(picture, offX, offY);

  // The single transform equivalent to the whole composition, from
  // the take's original coordinates: a point p lands at
  // (base(p) − region origin) × scale + offset. Every recorded box —
  // the subject, the sign, its text and word boxes, the private item —
  // is carried through it, so the sidecar stays honest.
  const transform = {
    factor: scale * bf,
    offX: Math.round((boX - region.x0) * scale + offX),
    offY: Math.round((boY - region.y0) * scale + offY),
  };
  const carry = (box) => (box ? transformBox(box, transform.factor, transform.offX, transform.offY) : null);
  const extras = {};
  for (const [key, box] of Object.entries(boxes.extras || {})) {
    if (box) extras[key] = carry(box);
  }
  return {
    buffer: await canvas.getBuffer("image/png"),
    groundTruth: {
      subject: carry(boxes.subject),
      sign: carry(boxes.sign),
      privateItem: carry(boxes.privateItem),
    },
    extras,
    contentBox: { x0: offX, y0: offY, x1: offX + picW, y1: offY + picH },
    transform,
    region,
    scale,
  };
}

// The privacy redaction repair's id. It is offered from the check
// result, not from a verdict: when a take's private-information
// warning is active and the private item's region is located (a
// seeded take's recorded facts, or the judgement tier's estimate for
// a supplied photo), this repair paints a solid opaque cover over
// that region. It is deterministic — no model edits the picture —
// and it only counts as done when the re-check that follows it can
// no longer read the private information.
const REDACT_REPAIR_ID = "take-off-private-information";

// Which repairs apply, given a measurement of the original take. The
// optional context carries what the measurement cannot say: the take's
// kind, and for a video with a hands-up window, the moment a cover-frame
// choice would land on (the repairs endpoint derives both from the take
// and its sidecar). The context also carries the privacy state the
// repair endpoints derive from the current check result:
// { active, region } — the warning is showing, and the box of the
// private item it names, in source pixels.
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
    // A cover-frame choice is offered whenever the take has a hands-up
    // window to choose from. Applying it composes that moment into a
    // poster (see composeCoverFrame): the picture is fitted to the
    // post with the subject centred in the frame, so the cover reads
    // as a composed poster rather than a wide shot with the subject
    // small and low in it.
    repairs.push({
      id: "cover-frame-hands-up",
      name: `Cover frame: use the moment at ${Math.round(context.coverFrameAtSeconds)} seconds, where your hands are up signing, composed as a poster — the picture fitted to the post with you centred in the frame, so the cover reads as a composed poster`,
      fixesCheck: "firstImpression",
    });
  }
  if (context && context.privacy && context.privacy.active && context.privacy.region) {
    repairs.push({
      id: REDACT_REPAIR_ID,
      name: "Take off private information: paints a solid, opaque cover over the private item the warning names, so it cannot be read, then runs the checks again",
      fixesCheck: "privacy",
    });
  }
  // A chain never offers a repair it already contains: directing the
  // same fix twice would stack a no-op on the creator's time.
  const chain = context && Array.isArray(context.chain) ? context.chain : [];
  return repairs.filter((r) => !chain.includes(r.id));
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

  if (repairId === REDACT_REPAIR_ID) {
    // The cover: a solid opaque rectangle over the private item's
    // located region, with a small margin on every side so a slightly
    // loose box cannot leave an edge of the item readable. Nothing is
    // redrawn or invented underneath — the information is hidden, and
    // the original take is never touched (repairs work on copies).
    // The boxes are carried forward unchanged: the cover moves no
    // content, so the re-check measures the same geometry — and the
    // privacy re-check is what decides whether the cover worked.
    const region = groundTruth && groundTruth.privateItem;
    if (!region) {
      throw new Error("There is no located private item to cover in this take.");
    }
    const img = await Jimp.fromBuffer(buffer);
    const { width, height } = img.bitmap;
    const pad = Math.max(4, Math.round(Math.min(width, height) * 0.02));
    const x0 = Math.max(0, Math.floor(region.x0) - pad);
    const y0 = Math.max(0, Math.floor(region.y0) - pad);
    const x1 = Math.min(width, Math.ceil(region.x1) + pad);
    const y1 = Math.min(height, Math.ceil(region.y1) + pad);
    const cover = new Jimp({ width: x1 - x0, height: y1 - y0, color: 0x000000ff });
    img.composite(cover, x0, y0);
    return {
      buffer: await img.getBuffer("image/png"),
      groundTruth,
      changes: [
        `Painted a solid, opaque cover over the private item's region: pixels ${x0} to ${x1} across and ${y0} to ${y1} down of the ${width} by ${height} frame, a ${pad}-pixel margin included on every side.`,
        "Nothing was redrawn, described, or invented underneath the cover — the information is hidden, not replaced. The original take is unchanged.",
        "The checks run again on the covered picture: this repair counts only if the privacy check can no longer read what was there.",
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

module.exports = { availableRepairs, applyRepair, applyTransform, composeTransforms, composeCoverFrame, safeArea, unionBox, applyGain, REDACT_REPAIR_ID };
