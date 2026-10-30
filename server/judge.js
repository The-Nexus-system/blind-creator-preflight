"use strict";

// Muse Spark as the measurement fallback — the design contract's own
// third tier (MODULE-CONTRACTS section 3): a subject SAM 3.1 cannot
// locate falls back to Muse Spark JUDGEMENT, and is reported as
// measured-by-judgement, never as a SAM measurement.
//
// This module asks Spark to estimate the subject's bounding box (and a
// sign / text-region box when one is present) as strict JSON in source
// pixels — the same {x0, y0, x1, y1} shape measure.js consumes from SAM
// or from a take's recorded facts. An estimate is softer than a
// measurement and the pipeline says so wherever it is used; what this
// module guarantees is only that the estimate is well-formed:
//
// - The reply is parsed strictly, exactly like the semantic pipeline:
//   a subject box with four finite coordinates, inside the image, with
//   positive extent, or the whole reply is distrusted and an error is
//   thrown — no verdict is ever built on garbage.
// - Live calls switched off is reported as a status, not an error, so
//   the caller can say plainly that judgement was unavailable.
// - Any other call failure throws, and the caller turns it into an
//   "uncertain" with the reason.

const { Jimp } = require("jimp");
const { chatCompletions, ModelCallsDisabled } = require("./model-api");

function buildBoxPrompt(intent, width, height) {
  return [
    "You are the measurement fallback inside Blind Creator Pre-Flight, an app a blind creator uses before posting.",
    `The creator's stated intent for this take: ${intent}`,
    `The image is ${width} pixels wide and ${height} pixels tall. Coordinates are source pixels, with (0, 0) at the top left.`,
    "Estimate the bounding box of the main subject (the person the post is about). If the image also has a sign, banner, or other text region that matters to the post, estimate its bounding box too; if there is none, report null for it.",
    "Answer with ONLY a JSON object, no prose, of exactly this shape:",
    "{",
    '  "subject": {"x0": 0, "y0": 0, "x1": 0, "y1": 0},',
    '  "sign": {"x0": 0, "y0": 0, "x1": 0, "y1": 0} or null',
    "}",
    "Every coordinate must be a number inside the image: 0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height. Estimate only what is visible; if you cannot locate the subject at all, say so by answering with the single word UNREADABLE instead of guessing a box.",
  ].join("\n");
}

function validBox(box, width, height) {
  return Boolean(
    box &&
      typeof box === "object" &&
      Number.isFinite(box.x0) &&
      Number.isFinite(box.y0) &&
      Number.isFinite(box.x1) &&
      Number.isFinite(box.y1) &&
      box.x0 >= 0 &&
      box.y0 >= 0 &&
      box.x1 <= width &&
      box.y1 <= height &&
      box.x1 > box.x0 &&
      box.y1 > box.y0
  );
}

function roundBox(box) {
  return {
    x0: Math.round(box.x0),
    y0: Math.round(box.y0),
    x1: Math.round(box.x1),
    y1: Math.round(box.y1),
  };
}

// Strictly parses a model reply into estimated boxes. Returns null when
// the reply cannot be trusted, so the caller falls back to uncertainty.
function parseBoxes(text, width, height) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  if (!validBox(obj.subject, width, height)) return null;
  if (obj.sign !== null && obj.sign !== undefined && !validBox(obj.sign, width, height)) {
    return null;
  }
  return {
    subject: roundBox(obj.subject),
    sign: obj.sign ? roundBox(obj.sign) : null,
  };
}

// Asks Muse Spark to estimate the boxes for one image. The chat
// function is injectable for offline tests; production passes
// model-api's chatCompletions. Returns:
//   { status: "ok", subject, sign }  — a trusted estimate.
//   { status: "disabled" }           — live calls are switched off.
// Throws on a real call failure or an untrusted reply; callers turn
// that into uncertainty with the reason.
async function estimateBoxes(buffer, intent, chat) {
  const img = (await Jimp.fromBuffer)
    ? await Jimp.fromBuffer(buffer)
    : await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  const call = chat || chatCompletions;
  let replyText;
  try {
    replyText = await call({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildBoxPrompt(intent, width, height) },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` },
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof ModelCallsDisabled || (err && err.code === "MODEL_CALLS_DISABLED")) {
      return { status: "disabled" };
    }
    throw err;
  }
  const boxes = parseBoxes(replyText, width, height);
  if (!boxes) {
    throw new Error(
      "The model reply could not be read as the required box shape, so it is not trusted."
    );
  }
  return { status: "ok", subject: boxes.subject, sign: boxes.sign };
}

module.exports = { estimateBoxes, parseBoxes, buildBoxPrompt };
