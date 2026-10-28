"use strict";

// Meta Model API client for the Pre-Flight backend.
//
// One key, one surface: https://api.meta.ai/v1, bearer auth, spoken to
// directly here because this backend is the deployed product's key holder —
// the key lives in this host's secrets (MODEL_API_KEY) and nowhere else:
// not in the repo, not in the client, not in any log.
//
// Call shapes, verified against Meta's official sources (Oct 28, 2026):
// - Muse Spark vision/judgement: POST /v1/chat/completions (OpenAI-style).
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

const BASE = "https://api.meta.ai/v1";

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
  const res = await fetch(`${BASE}/chat/completions`, {
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

async function transcribeFile(buffer, filename = "audio.wav") {
  requireEnabled();
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", "muse-voice-transcribe-1.0");
  const res = await fetch(`${BASE}/asr/transcribe`, {
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
  const res = await fetch(`${BASE}/responses`, {
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
  // The parser consumes the streamed segmentation grammar and yields typed
  // summaries whose boxes are {left, top, right, bottom} in source pixels.
  const summary = await parser.summarizeStream(res.body);
  const boxes = [];
  for (const record of summary || []) {
    for (const b of record.boxes || []) {
      boxes.push({ x0: b.left, y0: b.top, x1: b.right, y1: b.bottom });
    }
  }
  return boxes;
}

module.exports = { chatCompletions, transcribeFile, segmentImage, ModelCallsDisabled };
