"use strict";

// Seeded demo takes for Blind Creator Pre-Flight.
//
// The takes specified in the project's design record (SEED-TAKES, confirmed
// by the Nexus System on Oct 16, 2026). Each take is a specification of a
// photo or short video with a known, designed state — clean, or carrying
// one named flaw. The photo takes have generated media (server/seed-media/)
// so the deterministic pipeline measures real pixels. Of the video takes,
// ST-V2 has media: the seeded video file plus the still frames extracted
// from it at seed-build time, which are what its checks measure and judge
// (the running server never decodes video). ST-V1 and ST-V3 remain
// specifications until their media is made.
//
// This file carries NO verdicts. Verdicts come only from the pipelines:
// measured (deterministic), model (semantic), or an honest "uncertain"
// with its reason. What each take is DESIGNED to produce lives in
// tests/expected-verdicts.json, where it belongs — as assertions the real
// pipelines are tested against, never as answers the app reports.
//
// The one exception, stated plainly: ST-P8's designed privacy warning.
// While live model calls are switched off, the warning path itself is
// exercised from the take's design so the behaviour can be demonstrated
// and accessibility-tested; the response labels its source as "designed".
// The moment the model check runs, its answer replaces the designed one
// entirely.

const CHECKS = [
  { id: "framing", name: "Framing" },
  { id: "crop", name: "Crop safety" },
  { id: "quality", name: "Sharpness and quality" },
  { id: "text", name: "Text in the image" },
  { id: "firstImpression", name: "First impression" },
  { id: "audio", name: "Audio" },
];

const TAKES = [
  {
    id: "ST-P1",
    kind: "photo",
    title: "Clean portrait with sign",
    intent: "A portrait of the creator holding a sign that reads Fractured Flow.",
    designedPrivacyWarning: null,
  },
  {
    id: "ST-P2",
    kind: "photo",
    title: "Top of head cut off",
    intent: "A portrait of the creator, meant to show their whole head and shoulders.",
    designedPrivacyWarning: null,
  },
  {
    id: "ST-P4",
    kind: "photo",
    title: "Sign text clipped at the right edge",
    intent: "The creator holding a sign; the sign's words are the point of the post.",
    designedPrivacyWarning: null,
  },
  {
    id: "ST-P8",
    kind: "photo",
    title: "Private item visible",
    intent: "A desk selfie the creator wants to post.",
    designedPrivacyWarning: {
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
    designedPrivacyWarning: null,
  },
  {
    id: "ST-V2",
    kind: "video",
    title: "Banner loses its main word to the crop",
    intent: "Announcement Reel. The banner behind me says the name of the tour; it has to read in full.",
    designedPrivacyWarning: null,
  },
  {
    id: "ST-V3",
    kind: "video",
    title: "Bad opening frame",
    intent: "A Reel whose opening moment should be the creator smiling at camera.",
    designedPrivacyWarning: null,
  },
];

module.exports = { CHECKS, TAKES };
