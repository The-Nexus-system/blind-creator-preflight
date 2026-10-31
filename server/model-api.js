"use strict";

// Meta Model API client for the Pre-Flight backend.
//
// One key, one surface: https://api.meta.ai/v1, bearer auth, spoken to
// directly here because this backend is the deployed product's key holder —
// the key lives in this host's secrets (MODEL_API_KEY) and nowhere else:
// not in the repo, not in the client, not in any log.
//
// Call shapes, verified against Meta's official sources (Oct 28, 2026):
// - Judgement (vision/chat): POST /v1/chat/completions (OpenAI-style).
//   Since the Nexus's ruling of Oct 31, 2026 the judgement tier runs
//   Muse Wonder first and falls back to Muse Spark 1.3-contributor —
//   see chatJudgement below, the one place that order lives.
// - Muse Voice Transcribe (files): POST /v1/asr/transcribe (multipart).
// - SAM 3.1: streamed over POST /v1/responses with the image as a data URL
//   and one noun-phrase concept per request; the streamed grammar is decoded
//   ONLY by the official @meta-sam/parser, never by hand (meta-model-
//   cookbook, 07_sam/01_api_basics).
//
// Funding switch: live calls happen only when MODEL_CALLS_ENABLED=true.
// That flag stays off until the hackathon credit is visible under Billing
// on the account — until then every call would charge the card on file.
// Callers handle the disabled error by reporting "uncertain" with the
// reason, which the design has always allowed. No call is ever retried
// blindly here; failures surface to the checks as uncertainty, not guesses.
//
// Transport pin: MODEL_API_IP_FAMILY (4 or 6) optionally pins outbound
// calls to one IP address family. Meta's serving is not identical across
// families from every network: from the Fly deployment's egress, calls
// over IPv4 return 404 model_not_found for this team's models while the
// same calls over IPv6 succeed (verified Oct 30, 2026 by forcing each
// family in turn). The Fly deployment therefore sets the pin to 6. Where
// the variable is unset, the platform default routing is used unchanged.

const BASE = "https://api.meta.ai/v1";

let cachedDispatcher;
function transportDispatcher() {
  if (cachedDispatcher !== undefined) return cachedDispatcher;
  cachedDispatcher = null;
  const family = process.env.MODEL_API_IP_FAMILY;
  if (family === "4" || family === "6") {
    try {
      const { Agent } = require("undici");
      cachedDispatcher = new Agent({
        connect: { family: Number(family), autoSelectFamily: false },
      });
    } catch {
      // undici unavailable: fall back to default routing rather than fail.
      cachedDispatcher = null;
    }
  }
  return cachedDispatcher;
}

function apiFetch(url, init) {
  const dispatcher = transportDispatcher();
  return dispatcher ? fetch(url, Object.assign({ dispatcher }, init)) : fetch(url, init);
}

class ModelCallsDisabled extends Error {
  constructor() {
    super(
      "Live model calls are switched off. They turn on when the hackathon credit is visible under Billing; until then calls would charge the card on file."
    );
    this.code = "MODEL_CALLS_DISABLED";
  }
}

function requireEnabled() {
  if (process.env.MODEL_CALLS_ENABLED !== "true" || !process.env.MODEL_API_KEY) {
    throw new ModelCallsDisabled();
  }
}

function authHeaders(extra) {
  return Object.assign(
    { Authorization: `Bearer ${process.env.MODEL_API_KEY}` },
    extra || {}
  );
}

async function chatCompletions({ model = "muse-spark-1.3", messages, temperature = 0 }) {
  requireEnabled();
  const res = await apiFetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({ model, messages, temperature }),
  });
  if (!res.ok) throw new Error(`Model API chat call failed with HTTP ${res.status}.`);
  const body = await res.json();
  const text = body && body.choices && body.choices[0] && body.choices[0].message
    ? body.choices[0].message.content
    : null;
  if (typeof text !== "string") throw new Error("Model API chat reply had no text content.");
  return text;
}

class ModelReplyUntrusted extends Error {
  constructor() {
    super(
      "Neither the primary model's reply nor the fallback model's reply could be read as the required shape, so neither is trusted."
    );
    this.code = "MODEL_REPLY_UNTRUSTED";
  }
}

// The judgement tier, per the Nexus System's ruling (Xander, Oct 31,
// 2026): Muse Wonder is the primary judgement model; when Wonder is
// unavailable (a transport/API error) or its reply cannot be trusted,
// the same call is retried ONCE with Muse Spark 1.3-contributor as the
// fallback. Spark 1.3-contributor runs in Contributor mode, under which
// Meta may use prompts and completions for training — that is stated
// plainly in the README, and it is why the contributor model is only
// ever the fallback, never the primary. (The fallback the ruling
// replaced was Muse Spark 1.3 Standard.)
const JUDGEMENT_PRIMARY_MODEL = "muse-wonder-1.0";
const JUDGEMENT_FALLBACK_MODEL = "muse-spark-1.3-contributor";

// One judgement call with the Wonder → Spark-contributor fallback,
// shared by every judgement caller (box estimation, semantic checks,
// described-audio drafting) so the semantics are identical everywhere:
//
// - The two attempts differ ONLY in the model: same messages, same
//   temperature.
// - `validate` (optional) is the caller's strict reply parser: it
//   returns a truthy parsed value for a reply that can be trusted, or
//   null for one that cannot. A distrusted Wonder reply triggers the
//   fallback exactly like a failed call does; a distrusted fallback
//   reply throws ModelReplyUntrusted. A distrusted reply from either
//   model never reaches a verdict.
// - Calls switched off (ModelCallsDisabled) is NOT a fallback trigger:
//   the switch gates every model, so it propagates immediately and the
//   caller reports its calls-off state as before.
// - When both attempts fail with call errors, the fallback attempt's
//   error is thrown — the last failure is the one reported.
// - The chat function is injectable for offline tests; production uses
//   chatCompletions. Resolves { text, value, model } — `value` is the
//   validated parse (or the raw text when no validator was given) and
//   `model` names the model whose reply was used, so callers can label
//   the source honestly.
async function chatJudgement({ messages, temperature = 0, validate, chat }) {
  const call = chat || chatCompletions;
  const models = [JUDGEMENT_PRIMARY_MODEL, JUDGEMENT_FALLBACK_MODEL];
  for (let attempt = 0; attempt < models.length; attempt++) {
    const model = models[attempt];
    const last = attempt === models.length - 1;
    let text;
    try {
      text = await call({ model, messages, temperature });
    } catch (err) {
      if (err instanceof ModelCallsDisabled || (err && err.code === "MODEL_CALLS_DISABLED")) {
        throw err;
      }
      if (last) throw err;
      continue;
    }
    if (!validate) return { text, value: text, model };
    const value = validate(text);
    if (value) return { text, value, model };
    if (last) throw new ModelReplyUntrusted();
  }
  // Unreachable: the final attempt always returns or throws.
  throw new ModelReplyUntrusted();
}

async function transcribeFile(buffer, filename = "audio.wav") {
  requireEnabled();
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", "muse-voice-transcribe-1.0");
  const res = await apiFetch(`${BASE}/asr/transcribe`, {
    method: "POST",
    headers: authHeaders(),
    body: form,
  });
  if (!res.ok) throw new Error(`Transcribe call failed with HTTP ${res.status}.`);
  const body = await res.json();
  if (!body || typeof body.text !== "string") {
    throw new Error("Transcribe reply had no text field.");
  }
  return body.text;
}

// Turns a fetch response body (an SSE byte stream) into the Responses
// API event objects the official parser consumes. Each SSE event's data
// payload is one JSON event; keepalives and the terminal [DONE] marker
// carry none and are skipped.
async function* responseEvents(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, "\n");
    let splitAt;
    while ((splitAt = buffer.indexOf("\n\n")) >= 0) {
      const rawEvent = buffer.slice(0, splitAt);
      buffer = buffer.slice(splitAt + 2);
      const data = rawEvent
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trim())
        .join("\n");
      if (!data || data === "[DONE]") continue;
      try {
        yield JSON.parse(data);
      } catch {
        // A non-JSON payload is not an event; transport noise is not
        // output text, and the parser's diagnostics cover the output.
      }
    }
  }
}

// Segments one concept in an image. Returns boxes in source pixels as
// {x0, y0, x1, y1} — the same shape the seeded sidecars use, so measure.js
// consumes SAM output and designed ground truth identically.
async function segmentImage(buffer, concept, width, height) {
  requireEnabled();
  let parser;
  try {
    parser = require("@meta-sam/parser");
  } catch {
    throw new Error(
      "The official @meta-sam/parser package is not installed in this backend, so SAM output cannot be decoded safely."
    );
  }
  const dataUrl = `data:image/png;base64,${buffer.toString("base64")}`;
  const res = await apiFetch(`${BASE}/responses`, {
    method: "POST",
    headers: authHeaders({ "Content-Type": "application/json" }),
    body: JSON.stringify({
      model: "sam-3.1",
      stream: true,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: concept },
            { type: "input_image", image_url: dataUrl },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`SAM call failed with HTTP ${res.status}.`);
  // The parser consumes Responses API events, not the raw byte stream:
  // the SSE body is decoded into events first (see responseEvents), then
  // the official parser turns the streamed segmentation grammar into
  // typed records. Box records carry half-open source-pixel corners
  // (left/top/right/bottom), mapped here to the sidecar box shape.
  const result = await parser.parseImageStream(responseEvents(res.body)).finalResult;
  if (result.outcome.status !== "completed") {
    throw new Error(
      `SAM stream did not complete (${result.outcome.reason}${
        result.outcome.detail ? `: ${result.outcome.detail}` : ""
      }).`
    );
  }
  return parser
    .recordsOfKind(result.records, "box")
    .map((b) => ({ x0: b.left, y0: b.top, x1: b.right, y1: b.bottom }));
}

module.exports = {
  chatCompletions,
  chatJudgement,
  transcribeFile,
  segmentImage,
  ModelCallsDisabled,
  ModelReplyUntrusted,
  JUDGEMENT_PRIMARY_MODEL,
  JUDGEMENT_FALLBACK_MODEL,
};
