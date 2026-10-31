"use strict";

// Semantic checks — the judgements measurement cannot make, asked of
// the judgement tier in a single vision call per take. Since the
// Nexus's ruling of Oct 31, 2026, that is Muse Wonder, falling back
// to Muse Spark 1.3-contributor when Wonder is unavailable or its
// reply cannot be trusted (model-api.js's chatJudgement):
//
// - text in the image: what any visible text says, in reading order, and
//   whether it is fully legible;
// - first impression: what a sighted viewer sees first, against the
//   creator's stated intent;
// - the private-information warning: any readable private content in the
//   take (an address, a document, a notification), NAMED — this fires
//   alongside any verdict, including an all-pass, and is never buried
//   inside another check's report.
//
// The reply is parsed strictly: a verdict must be one of pass / fix /
// uncertain and every field must be present, or the reply is distrusted
// — first Wonder's, then the contributor fallback's — and if neither
// can be trusted every check falls back to "uncertain" with the reason.
// The model is never allowed to make an unreadable answer look like a pass.
//
// When live calls are switched off (funding switch in model-api.js), these
// checks return "uncertain" with that reason stated. That is a real
// verdict in this design, not a stand-in: the app says what it does not
// know and why.

const { chatJudgement, ModelCallsDisabled, ModelReplyUntrusted } = require("./model-api");

const VERDICTS = new Set(["pass", "fix", "uncertain"]);

const DISABLED_REASON =
  "Not run yet: live model calls are switched off until the hackathon credit is visible under Billing.";

function uncertain(detail) {
  return { verdict: "uncertain", detail };
}

function buildPrompt(intent) {
  return [
    "You are the semantic checker inside Blind Creator Pre-Flight, an app a blind creator uses before posting.",
    `The creator's stated intent for this take: ${intent}`,
    "Examine the image and answer with ONLY a JSON object, no prose, of exactly this shape:",
    "{",
    '  "text": {"verdict": "pass|fix|uncertain", "detail": "what any visible text says, in reading order, and whether it is fully legible; say plainly if there is no text"},',
    '  "firstImpression": {"verdict": "pass|fix|uncertain", "detail": "what a sighted viewer notices first, and whether that matches the creator\'s intent"},',
    '  "privacy": {"fires": true|false, "name": "if it fires, name the private thing plainly, e.g. a readable home address on a letter", "detail": "if it fires, what posting would make public; if not, an empty string"}',
    "}",
    "Judge only what is visible. If you cannot tell, say uncertain. Never guess a pass.",
  ].join("\n");
}

// Strictly parses a model reply into check results. Returns null when the
// reply cannot be trusted, so the caller falls back to uncertainty.
function parseSemanticReply(text) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== "object") return null;
  for (const key of ["text", "firstImpression"]) {
    const c = obj[key];
    if (!c || !VERDICTS.has(c.verdict) || typeof c.detail !== "string" || !c.detail) return null;
  }
  const p = obj.privacy;
  if (!p || typeof p.fires !== "boolean") return null;
  if (p.fires && (typeof p.name !== "string" || !p.name || typeof p.detail !== "string" || !p.detail)) {
    return null;
  }
  return {
    text: { verdict: obj.text.verdict, detail: obj.text.detail },
    firstImpression: { verdict: obj.firstImpression.verdict, detail: obj.firstImpression.detail },
    privacyWarning: p.fires ? { name: p.name, detail: p.detail } : null,
  };
}

// Runs the semantic checks for one image. The chat function is
// injectable for offline tests and is passed through to chatJudgement,
// which tries Muse Wonder first and Muse Spark 1.3-contributor once
// if Wonder's call fails or its reply is distrusted.
async function runSemanticChecks(imageBuffer, intent, chat) {
  let result;
  try {
    result = await chatJudgement({
      chat,
      validate: parseSemanticReply,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: buildPrompt(intent) },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${imageBuffer.toString("base64")}` },
            },
          ],
        },
      ],
    });
  } catch (err) {
    if (err instanceof ModelCallsDisabled || (err && err.code === "MODEL_CALLS_DISABLED")) {
      return {
        source: "model-off",
        text: uncertain(DISABLED_REASON),
        firstImpression: uncertain(DISABLED_REASON),
        privacyWarning: null,
        privacyWarningSource: "model-off",
      };
    }
    if (err instanceof ModelReplyUntrusted || (err && err.code === "MODEL_REPLY_UNTRUSTED")) {
      const reason = "The model reply could not be read as the required verdict shape, so it is not trusted.";
      return {
        source: "model-unreadable",
        text: uncertain(reason),
        firstImpression: uncertain(reason),
        privacyWarning: null,
        privacyWarningSource: "model-unreadable",
      };
    }
    const reason = `The model check failed (${err.message}) No verdict is guessed from a failed call.`;
    return {
      source: "model-error",
      text: uncertain(reason),
      firstImpression: uncertain(reason),
      privacyWarning: null,
      privacyWarningSource: "model-error",
    };
  }
  return { source: "model", model: result.model, ...result.value, privacyWarningSource: "model" };
}

module.exports = { runSemanticChecks, parseSemanticReply, buildPrompt };
