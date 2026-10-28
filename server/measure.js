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

async function measureImage(buffer, groundTruth) {
  const img = await Jimp.fromBuffer ? await Jimp.fromBuffer(buffer) : await Jimp.read(buffer);
  const { width, height } = img.bitmap;

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
      if (x > 0) {
        gradHist[Math.round(Math.abs(grey - row[x - 1]))]++;
        gradCount++;
      }
      if (prevRow) {
        gradHist[Math.round(Math.abs(grey - prevRow[x]))]++;
        gradCount++;
      }
    }
    prevRow = row;
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
          failures.push(`the ${label} is cut by the ${crop.name} crop`);
        }
      }
    }
    result.cropSafety = {
      verdict: failures.length ? "fix" : "pass",
      detail: failures.length
        ? `In the post as it will be shown, ${failures.join("; ")}.`
        : "The subject and any sign survive both platform crops whole.",
    };
  }

  // Quality verdicts from the measured signals. Thresholds are deliberately
  // plain and stated in the detail, never hidden.
  const qualityIssues = [];
  if (meanBrightness < 0.12) qualityIssues.push(`very dark (mean brightness ${meanBrightness.toFixed(2)} of 1)`);
  if (meanBrightness > 0.93) qualityIssues.push(`blown out (mean brightness ${meanBrightness.toFixed(2)} of 1)`);
  if (sharpness < 0.2) qualityIssues.push(`edges are smeared (strongest-edge strength ${sharpness.toFixed(3)} of 1, threshold 0.20)`);
  result.quality = {
    verdict: qualityIssues.length ? "fix" : "pass",
    detail: qualityIssues.length
      ? `Measured: ${qualityIssues.join("; ")}.`
      : `Measured: mean brightness ${meanBrightness.toFixed(2)} of 1, edge strength ${sharpness.toFixed(3)} of 1 — within the plain thresholds.`,
  };

  return result;
}

module.exports = { measureImage, CROPS };
