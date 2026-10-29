"use strict";

// Deterministic measurements for the checks pipeline.
//
// These functions MEASURE pixels: image dimensions, brightness, sharpness,
// and — using a ground-truth box map for the seeded takes — whether the
// subject and any sign fit inside the frame and inside the platform crops
// a post will actually be shown through.
//
// Ground truth: for a real creator upload, the subject/sign boxes will come
// from a segmentation model (SAM 3.1, via the backend). For the seeded demo
// takes, the boxes are the takes' designed specifications, written by the
// seed-image generator next to each image. The geometry compared here — box
// against frame, box against crop window — is measured the same way in both
// cases; only the box source differs, and every verdict says which source
// produced it.

const { Jimp } = require("jimp");

// The crops the simulated composer checks against. A Reel / vertical post is
// shown at 9:16; a portrait feed post at 4:5. Both are centre crops of the
// source frame for this scaffold.
const CROPS = [
  { id: "reel-9-16", name: "vertical 9:16 (Reels)", ratio: 9 / 16 },
  { id: "feed-4-5", name: "portrait 4:5 (feed)", ratio: 4 / 5 },
];

function centreCropWindow(width, height, ratio) {
  // ratio = width / height of the crop. Returns {x0, y0, x1, y1} in source pixels.
  const sourceRatio = width / height;
  let w, h;
  if (sourceRatio > ratio) {
    h = height;
    w = Math.floor(height * ratio);
  } else {
    w = width;
    h = Math.floor(width / ratio);
  }
  const x0 = Math.floor((width - w) / 2);
  const y0 = Math.floor((height - h) / 2);
  return { x0, y0, x1: x0 + w, y1: y0 + h };
}

function boxInside(box, win) {
  return box.x0 >= win.x0 && box.y0 >= win.y0 && box.x1 <= win.x1 && box.y1 <= win.y1;
}

function boxTouchesFrameEdge(box, width, height, marginFrac = 0.02) {
  const mx = width * marginFrac;
  const my = height * marginFrac;
  const edges = [];
  if (box.y0 <= my) edges.push("top");
  if (box.x0 <= mx) edges.push("left");
  if (box.x1 >= width - mx) edges.push("right");
  if (box.y1 >= height - my) edges.push("bottom");
  return edges;
}

async function measureImage(buffer, groundTruth, contentBox) {
  const img = await Jimp.fromBuffer ? await Jimp.fromBuffer(buffer) : await Jimp.read(buffer);
  const { width, height } = img.bitmap;

  // The sharpness statistic is computed over the picture itself. A repair
  // that pulls a frame back declares the rectangle it placed the picture
  // into (contentBox, in this image's coordinates); the border outside it
  // is flat fill the repair added, and grading it would grade the repair's
  // own scaffolding — the fill's zero gradients dilute the strong-edge
  // tail until a sharp picture reads as smeared. Only a repair's declared
  // box scopes the measurement: a creator's own borders are part of their
  // picture and stay measured. Brightness is always measured over the
  // whole frame; the fill is the take's own edge colour, so it does not
  // misrepresent the exposure the way it dilutes the edge tail.
  const region =
    contentBox &&
    Number.isFinite(contentBox.x0) &&
    Number.isFinite(contentBox.x1) &&
    contentBox.x0 >= 0 &&
    contentBox.y0 >= 0 &&
    contentBox.x1 <= width &&
    contentBox.y1 <= height &&
    contentBox.x1 > contentBox.x0 &&
    contentBox.y1 > contentBox.y0
      ? {
          x0: Math.floor(contentBox.x0),
          y0: Math.floor(contentBox.y0),
          x1: Math.floor(contentBox.x1),
          y1: Math.floor(contentBox.y1),
        }
      : { x0: 0, y0: 0, x1: width, y1: height };
  const scoped = region.x0 > 0 || region.y0 > 0 || region.x1 < width || region.y1 < height;

  // Brightness from the pixel data; sharpness from the high tail of the local
  // gradient distribution. A mean gradient is the wrong statistic: honest
  // photos contain large flat areas (sky, walls) whose zero gradients drown
  // the edges that sharpness actually lives in. Blur caps how strong the
  // strongest edge transition can be, so the tail is what separates a sharp
  // take from a blurred one. On the seeded compositions: a sharp take's
  // strongest edges step ~0.82 of full scale; a mild blur caps them at
  // ~0.14; a heavy blur at ~0.06. The quality threshold sits at 0.20.
  let sum = 0;
  const gradHist = new Array(256).fill(0);
  let gradCount = 0;
  let prevRow = null;
  const data = img.bitmap.data;
  for (let y = 0; y < height; y++) {
    const row = new Float32Array(width);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const grey = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      row[x] = grey;
      sum += grey;
    }
    prevRow = row;
  }
  // Gradient samples: horizontal and vertical neighbour pairs with BOTH
  // pixels inside the measured region, so the artificial step between the
  // repair's fill and the picture is never counted as picture detail.
  const regionWidth = region.x1 - region.x0;
  let prevRegionRow = null;
  for (let y = region.y0; y < region.y1; y++) {
    const rowSeg = new Float32Array(regionWidth);
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * width + x) * 4;
      const grey = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      rowSeg[x - region.x0] = grey;
      if (x > region.x0) {
        gradHist[Math.round(Math.abs(grey - rowSeg[x - region.x0 - 1]))]++;
        gradCount++;
      }
      if (prevRegionRow) {
        gradHist[Math.round(Math.abs(grey - prevRegionRow[x - region.x0]))]++;
        gradCount++;
      }
    }
    prevRegionRow = rowSeg;
  }
  const meanBrightness = sum / (width * height) / 255; // 0..1
  // 99.9th-percentile gradient: robust against a stray hot pixel in a real
  // photo (the top 0.1% of samples is still thousands of samples), while
  // measuring the strongest true edges present in the frame.
  let cumulative = 0;
  let p999 = 255;
  for (let bin = 0; bin < 256; bin++) {
    cumulative += gradHist[bin];
    if (cumulative >= gradCount * 0.999) {
      p999 = bin;
      break;
    }
  }
  const sharpness = p999 / 255; // 99.9th-percentile gradient, 0..1

  const crops = CROPS.map((c) => ({ ...c, window: centreCropWindow(width, height, c.ratio) }));

  const result = {
    width,
    height,
    meanBrightness: Number(meanBrightness.toFixed(3)),
    sharpness: Number(sharpness.toFixed(4)),
    crops: crops.map((c) => ({ id: c.id, name: c.name, window: c.window })),
    framing: null,
    cropSafety: null,
  };

  if (groundTruth && groundTruth.subject) {
    const edges = boxTouchesFrameEdge(groundTruth.subject, width, height);
    result.framing = {
      subjectTouchesEdges: edges,
      verdict: edges.length ? "fix" : "pass",
      detail: edges.length
        ? `The subject reaches the ${edges.join(" and ")} edge of the frame.`
        : "The subject sits inside the frame with margin on every side.",
    };

    const failures = [];
    for (const crop of crops) {
      for (const [label, box] of [
        ["subject", groundTruth.subject],
        ["sign", groundTruth.sign],
      ]) {
        if (box && !boxInside(box, crop.window)) {
          // A take may name its protected element (a banner, for ST-V2);
          // the verdict reports the element by the take's own name.
          const named =
            label === "sign" && groundTruth.labels && groundTruth.labels.sign
              ? groundTruth.labels.sign
              : label;
          failures.push(`the ${named} is cut by the ${crop.name} crop`);
        }
      }
    }
    result.cropSafety = {
      verdict: failures.length ? "fix" : "pass",
      detail: failures.length
        ? `In the post as it will be shown, ${failures.join("; ")}.`
        : groundTruth.labels && groundTruth.labels.sign
          ? `The subject and the ${groundTruth.labels.sign} survive both platform crops whole.`
          : "The subject and any sign survive both platform crops whole.",
    };
  }

  // Quality verdicts from the measured signals. Thresholds are deliberately
  // plain and stated in the detail, never hidden.
  const qualityIssues = [];
  if (meanBrightness < 0.12) qualityIssues.push(`very dark (mean brightness ${meanBrightness.toFixed(2)} of 1)`);
  if (meanBrightness > 0.93) qualityIssues.push(`blown out (mean brightness ${meanBrightness.toFixed(2)} of 1)`);
  if (sharpness < 0.2) qualityIssues.push(`edges are smeared (strongest-edge strength ${sharpness.toFixed(3)} of 1, threshold 0.20)`);
  const basis = scoped
    ? " Edge strength was measured on the picture itself, inside the border the repair added."
    : "";
  result.quality = {
    verdict: qualityIssues.length ? "fix" : "pass",
    detail: qualityIssues.length
      ? `Measured: ${qualityIssues.join("; ")}.${basis}`
      : `Measured: mean brightness ${meanBrightness.toFixed(2)} of 1, edge strength ${sharpness.toFixed(3)} of 1 — within the plain thresholds.${basis}`,
  };

  return result;
}

// Measures a seeded VIDEO take from its committed frames (extracted at
// seed-build time by tools/extract-seed-frames.js — the running server
// never decodes video). Two frames, two questions:
// - the RECORDED frame, against the platform crops: crop safety and
//   quality are properties of what was recorded, measured exactly as a
//   photo's are, with the take's banner in the sign's protective slot;
// - the POSTED frame (the recorded frame through the post's centre crop):
//   framing is judged there, because that is the frame the audience sees
//   and the frame the creator is "in" once the post exists. The design
//   record pins ST-V2's framing verdict in exactly those terms: in the
//   posted crop the creator sits off-centre, pushed to the edge.
// The composition returns the same shape measureImage returns, so the
// checks and repairs consume both without knowing which produced them.
async function measureVideoFrames(frameBuffer, postedBuffer, sidecar) {
  const recordedGT = {
    subject: sidecar.subject,
    sign: sidecar.banner,
    labels: { sign: "banner" },
  };
  const win = sidecar.postedCropWindow;
  const toPosted = (box) =>
    box
      ? { x0: box.x0 - win.x0, y0: box.y0 - win.y0, x1: box.x1 - win.x0, y1: box.y1 - win.y0 }
      : box;
  const postedGT = {
    subject: toPosted(sidecar.subject),
    sign: toPosted(sidecar.banner),
    labels: { sign: "banner" },
  };

  const recorded = await measureImage(frameBuffer, recordedGT, sidecar.contentBox || null);
  const posted = await measureImage(postedBuffer, postedGT);

  let framing = null;
  if (posted.framing) {
    const edges = posted.framing.subjectTouchesEdges;
    framing = {
      subjectTouchesEdges: edges,
      verdict: posted.framing.verdict,
      detail: edges.length
        ? `In the post as it will be shown, the subject reaches the ${edges.join(" and ")} edge of the frame.`
        : "In the post as it will be shown, the subject sits inside the frame with margin on every side.",
    };
  }

  return {
    width: recorded.width,
    height: recorded.height,
    meanBrightness: recorded.meanBrightness,
    sharpness: recorded.sharpness,
    crops: recorded.crops,
    framing,
    cropSafety: recorded.cropSafety,
    quality: recorded.quality,
  };
}

module.exports = { measureImage, measureVideoFrames, CROPS, centreCropWindow };
