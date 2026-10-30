"use strict";

// The described-audio script for a video take (the narrate module's
// script half — design contract section 6; generating the timed script
// is the demo-scope item, a rendered track is roadmap).
//
// A script is a list of timed segments drafted from the take's recorded
// timeline — the visual facts its sidecar records (the banner and what
// it says, the hands-up window, the duration). Two drafters, one slot,
// labelled like every other text in this app:
//
// - "model": Muse Spark drafts from the recorded facts when live calls
//   are on. Its reply is parsed strictly — timed segments inside the
//   take's duration, or the reply is distrusted wholesale.
// - "recorded-facts": the deterministic draft, assembled from the same
//   recorded facts when calls are off or the model reply cannot be
//   trusted. Nothing is described that no recorded fact states.
//
// Either way the script is a DRAFT. It is used only if the creator
// approves it — the same approval rule as the alt text and the public
// description — and this module only ever returns the draft state.
//
// Gap honesty (contract section 6): narration is fitted into the gaps
// in a take's speech, so a take WITH speech needs its transcript before
// a script can be drafted. Without one, no script is offered rather
// than timings being guessed around speech nobody has transcribed. A
// silent take has no speech to talk over, so its recorded timeline is
// enough — which is the case the Nexus directed on Oct 30, 2026: the
// silent video gets its audio descriptions.

const { chatCompletions, ModelCallsDisabled } = require("./model-api");

// The deterministic draft, from the take's recorded facts only.
function deterministicSegments(sidecar) {
  const seconds = Number(sidecar && sidecar.seconds) || null;
  if (!seconds) return null;
  const hands = Array.isArray(sidecar.handsUpSeconds) ? sidecar.handsUpSeconds : null;
  const segments = [];
  const openingEnd = hands ? hands[0] : seconds;
  let opening = "The creator stands in front of a banner.";
  if (sidecar.bannerText) {
    opening = `The creator stands in front of a banner. The banner reads: ${sidecar.bannerText}.`;
  }
  segments.push({ start: 0, end: openingEnd, text: opening });
  if (hands) {
    segments.push({
      start: hands[0],
      end: hands[1],
      text: "The creator raises both hands and signs.",
    });
    if (hands[1] < seconds) {
      segments.push({
        start: hands[1],
        end: seconds,
        text: "The video ends with the creator in front of the banner.",
      });
    }
  }
  return segments;
}

function buildPrompt(take, sidecar, transcript) {
  const facts = {
    durationSeconds: sidecar.seconds,
    silent: Boolean(sidecar.silent),
    bannerText: sidecar.bannerText || null,
    handsUpSeconds: sidecar.handsUpSeconds || null,
  };
  return [
    "You draft a described-audio script for a blind audience, inside Blind Creator Pre-Flight.",
    `The creator's stated intent for this video: ${take.intent}`,
    `The take's recorded visual facts (the only facts you may describe): ${JSON.stringify(facts)}`,
    transcript
      ? `The take's transcribed speech, so narration can be fitted around it: ${transcript}`
      : "The take is silent: there is no speech, so narration never overlaps dialogue.",
    "Answer with ONLY a JSON object, no prose, of exactly this shape:",
    '{ "segments": [ { "start": 0, "end": 5, "text": "what is seen in that span" } ] }',
    "Times are seconds within the take's duration. Describe only the recorded facts — never invent a visual detail. Keep each segment's text short and plain.",
  ].join("\n");
}

// Strictly parses a model reply into script segments. Returns null when
// the reply cannot be trusted, so the caller falls back to the
// recorded-facts draft.
function parseScript(text, seconds) {
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.segments) || !obj.segments.length || obj.segments.length > 8) {
    return null;
  }
  for (const s of obj.segments) {
    if (
      !s ||
      !Number.isFinite(s.start) ||
      !Number.isFinite(s.end) ||
      s.start < 0 ||
      s.end > seconds ||
      s.start >= s.end ||
      typeof s.text !== "string" ||
      !s.text ||
      s.text.length > 300
    ) {
      return null;
    }
  }
  return obj.segments.map((s) => ({ start: s.start, end: s.end, text: s.text }));
}

// Builds the described-audio payload for a video take whose media has
// resolved (the caller passes the take's sidecar; null means no media).
// The chat function is injectable for offline tests.
async function buildDescribedAudio(take, sidecar, transcript, chat) {
  if (!sidecar) {
    return {
      available: false,
      reason:
        "This seeded video has no media file yet, so there is no recorded timeline to draft a description from.",
    };
  }
  if (!sidecar.silent && !transcript) {
    return {
      available: false,
      reason:
        "This take has speech, and a described-audio script is fitted into the gaps in that speech. Without a transcript the gaps are not known, so no script is drafted rather than timings being guessed around speech nobody has transcribed.",
    };
  }
  const deterministic = deterministicSegments(sidecar);
  if (!deterministic) {
    return {
      available: false,
      reason:
        "This take's recorded facts do not include its duration, so there is no timeline to fit a script to.",
    };
  }
  const note = sidecar.silent
    ? "Draft described-audio script for a silent take: with no speech on the track, the narration never overlaps dialogue. It stays a draft until you approve it — the same rule as the alt text."
    : "Draft described-audio script, fitted to the take's recorded timeline and its transcribed speech. It stays a draft until you approve it — the same rule as the alt text.";

  const call = chat || chatCompletions;
  let reply = null;
  try {
    reply = await call({
      messages: [{ role: "user", content: [{ type: "text", text: buildPrompt(take, sidecar, transcript) }] }],
    });
  } catch (err) {
    if (!(err instanceof ModelCallsDisabled) && !(err && err.code === "MODEL_CALLS_DISABLED")) {
      // A real model failure falls back to the recorded-facts draft
      // below, labelled as what it is — the script is a draft either
      // way, and the fallback invents nothing.
    }
  }
  const modelSegments = reply ? parseScript(reply, Number(sidecar.seconds)) : null;
  if (modelSegments) {
    return { available: true, state: "draft", source: "model", segments: modelSegments, note };
  }
  return { available: true, state: "draft", source: "recorded-facts", segments: deterministic, note };
}

module.exports = { buildDescribedAudio, deterministicSegments, parseScript, buildPrompt };
