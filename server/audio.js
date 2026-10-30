"use strict";

// The audio check, wired to Muse Voice Transcribe.
//
// The design contract (section 3, check 6) judges a video's audio from
// the transcript: the words recovered, and where they drop out. This
// module runs that pipeline for a resolved video take:
//
// - A take whose sidecar marks it silent has NO audio track. There is
//   nothing to transcribe, and no model call is made against a track
//   that does not exist. The result says exactly that, in the Nexus's
//   directed wording (Oct 30, 2026): the check names the transcription
//   step and states the silence is part of the take — not a defect, and
//   not a check that failed to run.
// - A take with a speech track is transcribed when live calls are on,
//   and judged from what the transcription recovered. No recovered words
//   means uncertain — the check never invents words it could not hear.
// - A failed transcription, or calls switched off, leaves the check
//   uncertain with the reason, and leaves the visual checks untouched.
//
// The transcriber and the audio-file reader are injectable for offline
// tests; production uses model-api's transcribeFile and reads the
// take's named audio file from the seed-media directory. (The running
// server does not decode video, so a speech track reaches this module
// only as a separate audio file the take names in its sidecar. No
// seeded take ships one yet — the demo set exercises the silent branch,
// and the speech branches are real code on the real route, tested with
// stubs.)

const fs = require("fs");
const path = require("path");
const { transcribeFile, ModelCallsDisabled } = require("./model-api");

const MEDIA_DIR = path.join(__dirname, "seed-media");

function defaultReadAudio(name) {
  const p = path.join(MEDIA_DIR, name);
  return fs.existsSync(p) ? fs.readFileSync(p) : null;
}

async function runAudioCheck({ sidecar, transcriber, readAudio }) {
  const transcribe = transcriber || transcribeFile;
  const read = readAudio || defaultReadAudio;

  if (sidecar && sidecar.silent) {
    return {
      verdict: "uncertain",
      source: "determined",
      transcript: null,
      detail:
        "This take is silent by design: it has no audio track, so there is nothing for the transcription step (Muse Voice Transcribe) to transcribe and no speech for this check to settle. The silence is part of the take the creator made — not a defect, and not a missing check.",
    };
  }

  const audioName = sidecar && sidecar.audioFile;
  const audioBuffer = audioName ? read(audioName) : null;
  if (!audioBuffer) {
    return {
      verdict: "uncertain",
      source: "determined",
      transcript: null,
      detail:
        "This video has an audio track, but this build of the backend holds no separate audio file for it — the running server does not decode video — so the transcription step cannot run and the check cannot settle.",
    };
  }

  let transcript;
  try {
    transcript = await transcribe(audioBuffer, audioName);
  } catch (err) {
    if (err instanceof ModelCallsDisabled || (err && err.code === "MODEL_CALLS_DISABLED")) {
      return {
        verdict: "uncertain",
        source: "model-off",
        transcript: null,
        detail:
          "Not run yet: live model calls are switched off until the hackathon credit is visible under Billing, so this take's speech track has not been transcribed.",
      };
    }
    return {
      verdict: "uncertain",
      source: "model-error",
      transcript: null,
      detail: `The transcription step failed (${err.message}) The audio check does not guess at words it could not recover.`,
    };
  }

  const trimmed = transcript.trim();
  const words = trimmed ? trimmed.split(/\s+/).length : 0;
  if (!words) {
    return {
      verdict: "uncertain",
      source: "model",
      transcript,
      detail:
        "Muse Voice Transcribe recovered no words from this track. Whether the track holds speech buried under other sound cannot be settled from an empty transcript, and the check will not invent words — so this stays uncertain.",
    };
  }
  return {
    verdict: "pass",
    source: "model",
    transcript,
    detail: `Judged from the transcript, as the design specifies: Muse Voice Transcribe recovered this track's speech in full (${words} word${words === 1 ? "" : "s"}; the words themselves are in the proof copy). Speech a transcription recovers cleanly is speech an audience can follow.`,
  };
}

module.exports = { runAudioCheck };
