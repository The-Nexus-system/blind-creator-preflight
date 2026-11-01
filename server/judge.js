"use strict";

// The judgement tier as the measurement fallback — the design
// contract's own third tier (MODULE-CONTRACTS section 3): a subject
// SAM 3.1 cannot locate falls back to model JUDGEMENT, and is reported
// as measured-by-judgement, never as a SAM measurement. Since the
// Nexus's ruling of Oct 31, 2026, the judgement model is Muse Wonder,
// falling back to Muse Spark 1.3-contributor when Wonder is
// unavailable or its reply cannot be trusted (model-api.js's
// chatJudgement holds that order).
//
// This module asks the judgement tier to estimate the subject's
// bounding box (and a sign / text-region box when one is present) as
// strict JSON in source pixels — the same {x0, y0, x1, y1} shape
// measure.js consumes from SAM or from a take's recorded facts. An
// estimate is softer than a measurement and the pipeline says so
// wherever it is used; what this module guarantees is only that the
// estimate is well-formed:
//
// - The reply is parsed strictly, exactly like the semantic pipeline:
//   a subject box with four finite coordinates, inside the image, with
//   positive extent, or the reply is distrusted — first Wonder's, then
//   the contributor fallback's — and an error is thrown: no verdict is
//   ever built on garbage.
// - Live calls switched off is reported as a status, not an error, so
//   the caller can say plainly that judgement was unavailable.
// - Any other call failure throws, and the caller turns it into an
//   "uncertain" with the reason.

const { Jimp } = require("jimp");
const { chatJudgement, ModelCallsDisabled, ModelReplyUntrusted } = require("./model-api");

function buildBoxPrompt(intent, width, height) {
  return [
    "You are the measurement fallback inside Blind Creator Pre-Flight, an app a blind creator uses before posting.",
    `The creator's stated intent for this take: ${intent}`,
    `The image is ${width} pixels wide and ${height} pixels tall. Coordinates are source pixels, with (0, 0) at the top left.`,
    "Estimate the bounding box of the main subject (the person the post is about). If the image also has a sign, banner, or other text region the creator means viewers to read, estimate its bounding box too; if there is none, report null for it. Never report a document, letter, envelope, ID or bank card, or a screen showing personal information as the text region — those are private items, not signage.",
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

// Asks the judgement tier to estimate the boxes for one image: Muse
// Wonder first, Muse Spark 1.3-contributor as the fallback when
// Wonder's call fails or its reply is distrusted (chatJudgement in
// model-api.js). The chat function is injectable for offline tests and
// is passed through to chatJudgement, which calls it once per attempt
// with only the model differing. Returns:
//   { status: "ok", subject, sign, model }  — a trusted estimate, and
//                                             the model that made it.
//   { status: "disabled" }                  — live calls are off.
// Throws on a real call failure, or when neither model's reply could
// be trusted; callers turn that into uncertainty with the reason.
async function estimateBoxes(buffer, intent, chat) {
  const img = (await Jimp.fromBuffer)
    ? await Jimp.fromBuffer(buffer)
    : await Jimp.read(buffer);
  const { width, height } = img.bitmap;
  let result;
  try {
    result = await chatJudgement({
      chat,
      validate: (text) => parseBoxes(text, width, height),
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
    if (err instanceof ModelReplyUntrusted || (err && err.code === "MODEL_REPLY_UNTRUSTED")) {
      throw new Error(
        "The model reply could not be read as the required box shape, so it is not trusted."
      );
    }
    throw err;
  }
  return { status: "ok", subject: result.value.subject, sign: result.value.sign, model: result.model };
}

function buildPrivateRegionPrompt(warningName, width, height) {
  return [
    "You are the privacy-region locator inside Blind Creator Pre-Flight, an app a blind creator uses before posting.",
    `A check of this image found private information in it: ${warningName}`,
    `The image is ${width} pixels wide and ${height} pixels tall. Coordinates are source pixels, with (0, 0) at the top left.`,
    "Estimate the bounding box of exactly that private item — the smallest box that covers the private content itself, so a cover can be painted over it. Do not box anything else.",
    "Answer with ONLY a JSON object, no prose, of exactly this shape:",
    "{",
    '  "privateItem": {"x0": 0, "y0": 0, "x1": 0, "y1": 0} or null',
    "}",
    "Every coordinate must be a number inside the image: 0 <= x0 < x1 <= width and 0 <= y0 < y1 <= height. If you cannot locate the private item precisely, report null rather than guessing a box — the app will say plainly that it cannot take the information off automatically. If you cannot read the image at all, answer with the single word UNREADABLE.",
  ].join("\n");
}

// Strictly parses a private-region reply. Returns { region } — the box,
// or null when the model itself reports the item cannot be located —
// and null overall when the reply cannot be trusted.
function parsePrivateRegion(text, width, height) {
  if (typeof text !== "string") return null;
  if (text.trim() === "UNREADABLE") return { region: null };
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object" || !("privateItem" in obj)) return null;
  if (obj.privateItem === null) return { region: null };
  if (!validBox(obj.privateItem, width, height)) return null;
  return { region: roundBox(obj.privateItem) };
}

// Asks the judgement tier to locate the private item a privacy warning
// named, through the same shared fallback and distrust discipline as
// estimateBoxes. Returns:
//   { status: "ok", region, model } — region is a trusted box, or null
//                                     when the model could not locate
//                                     the item precisely.
//   { status: "disabled" }          — live calls are off.
// Throws on a real call failure or an untrusted reply; the caller
// treats either as "no region" — a warning with no located region
// offers no redaction, and the app says so plainly.
async function estimatePrivateRegion(buffer, warningName, chat) {
  const img = await Jimp.fromBuffer(buffer);
  const { width, height } = img.bitmap;
  let result;
  try {
    result = await chatJudgement({
      chat,
      validate: (text) => parsePrivateRegion(text, width, height),
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrivateRegionPrompt(warningName, width, height) },
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
    if (err instanceof ModelReplyUntrusted || (err && err.code === "MODEL_REPLY_UNTRUSTED")) {
      throw new Error(
        "The model reply could not be read as the required box shape, so it is not trusted."
      );
    }
    throw err;
  }
  return { status: "ok", region: result.value.region, model: result.model };
}

module.exports = { estimateBoxes, parseBoxes, buildBoxPrompt, estimatePrivateRegion, parsePrivateRegion, buildPrivateRegionPrompt };
