"use strict";

// Seeded demo takes for Blind Creator Pre-Flight.
//
// These are the demo takes specified in the project's design record
// (SEED-TAKES, confirmed by the Nexus System on Oct 16, 2026). Each take is a
// specification of a photo or short video with a known, designed state —
// clean, or carrying one named flaw — so the whole check/fix/re-check loop
// can be demonstrated deterministically. No media files exist yet; a take
// here is its written specification.
//
// `stubChecks` are PLACEHOLDER verdicts derived from each take's designed
// state. They exist so the client and the reporting shape can be built and
// tested now. The real checks pipeline replaces them with measured verdicts;
// nothing in the demo may present a stub verdict as a measurement.

const CHECKS = [
  { id: "framing", name: "Framing" },
  { id: "crop", name: "Crop safety" },
  { id: "quality", name: "Sharpness and quality" },
  { id: "text", name: "Text in the image" },
  { id: "firstImpression", name: "First impression" },
  { id: "audio", name: "Audio" },
];

function verdicts(overrides) {
  const base = {
    framing: ["pass", "The subject is in frame where the take intends."],
    crop: ["pass", "The platform crop keeps everything that matters."],
    quality: ["pass", "Sharp and well exposed."],
    text: ["pass", "No text in the take, or the text is fully legible."],
    firstImpression: ["pass", "The opening view matches the creator's intent."],
    audio: ["pass", "Speech is clear and easy to hear."],
  };
  const merged = Object.assign({}, base, overrides || {});
  return CHECKS.map((c) => {
    const [verdict, detail] = merged[c.id];
    return { id: c.id, name: c.name, verdict, detail };
  });
}

const NO_AUDIO_STILL = ["uncertain", "Still photo: there is no audio track to check."];

const TAKES = [
  {
    id: "ST-P1",
    kind: "photo",
    title: "Clean portrait with sign",
    intent: "A portrait of the creator holding a sign that reads Fractured Flow.",
    stubChecks: verdicts({ audio: NO_AUDIO_STILL }),
    privacyWarning: null,
  },
  {
    id: "ST-P2",
    kind: "photo",
    title: "Top of head cut off",
    intent: "A portrait of the creator, meant to show their whole head and shoulders.",
    stubChecks: verdicts({
      framing: ["fix", "The top of the creator's head is cut off at the top edge of the frame."],
      audio: NO_AUDIO_STILL,
    }),
    privacyWarning: null,
  },
  {
    id: "ST-P4",
    kind: "photo",
    title: "Sign text clipped at the right edge",
    intent: "The creator holding a sign; the sign's words are the point of the post.",
    stubChecks: verdicts({
      crop: ["fix", "The platform crop cuts the sign at the right edge."],
      text: ["fix", "The sign's final word is clipped at the right edge and cannot be read in full."],
      audio: NO_AUDIO_STILL,
    }),
    privacyWarning: null,
  },
  {
    id: "ST-P8",
    kind: "photo",
    title: "Private item visible",
    intent: "A desk selfie the creator wants to post.",
    stubChecks: verdicts({ audio: NO_AUDIO_STILL }),
    privacyWarning: {
      name: "Private information: a posted letter with a readable home address is visible on the desk.",
      detail:
        "The checks pass, but a letter on the desk shows a full home address in readable text. Posting this would make that address public.",
    },
  },
  {
    id: "ST-V1",
    kind: "video",
    title: "Clean talking-head Reel",
    intent: "The creator talks to camera about a new song, beginning to end.",
    stubChecks: verdicts({}),
    privacyWarning: null,
  },
  {
    id: "ST-V2",
    kind: "video",
    title: "Banner loses its main word to the crop",
    intent: "The creator in front of a banner; the banner's main word names the event.",
    stubChecks: verdicts({
      crop: ["fix", "The vertical crop cuts the banner's main word in half."],
      text: ["fix", "The banner's main word is not readable after the platform crop."],
    }),
    privacyWarning: null,
  },
  {
    id: "ST-V3",
    kind: "video",
    title: "Bad opening frame",
    intent: "A Reel whose opening moment should be the creator smiling at camera.",
    stubChecks: verdicts({
      firstImpression: ["fix", "The opening frame catches the creator mid-blink, looking away from the camera."],
    }),
    privacyWarning: null,
  },
];

module.exports = { CHECKS, TAKES };
