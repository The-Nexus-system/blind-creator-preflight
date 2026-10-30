"use strict";

// Offline tests — no network, no model calls, no spend.
//
// What they prove today:
// 1. The semantic reply parser accepts exactly the required verdict shape
//    and distrusts everything else (a distrusted reply becomes "uncertain",
//    never a pass).
// 2. With the funding switch off, the semantic pipeline reports "uncertain"
//    with the funding reason — plugged in, honest, and costing nothing.
// 3. The measured geometry/quality verdicts on the seeded photo takes match
//    the design record's assertions (tests/expected-verdicts.json).
// 4. The SAM wiring's branches (boxes used, no-match fallback, calls-off,
//    reported failure), the Spark-judgement tier behind it (estimates
//    used and labelled, garbage distrusted, calls-off uncertain, recorded
//    facts outranking the estimate), the audio check's branches (silent
//    take, judged transcript, every failure shape), and the
//    described-audio script (model draft, recorded-facts draft, gap
//    honesty) — all through injected stubs, still no network.
//
// The 'whenLive' assertions in expected-verdicts.json run later, against
// the live pipeline, once the funding switch is on and video media exists.

const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { parseSemanticReply, runSemanticChecks } = require("../server/semantic");
const { measureImage } = require("../server/measure");
const { buildProofCopy, draftAltText, readiness, buildPublicDescription } = require("../server/copy");
const { availableRepairs, applyRepair, applyGain } = require("../server/repair");

const expected = JSON.parse(
  fs.readFileSync(path.join(__dirname, "expected-verdicts.json"), "utf8")
);

let passed = 0;
function ok(name) {
  passed++;
  console.log(`ok - ${name}`);
}

async function main() {
  // 1. Parser.
  const good = JSON.stringify({
    text: { verdict: "fix", detail: "The sign reads 'Fractured Flo' — the final letter is cut off." },
    firstImpression: { verdict: "pass", detail: "The creator and their sign are what a viewer sees first." },
    privacy: { fires: false, name: "", detail: "" },
  });
  const parsed = parseSemanticReply(good);
  assert(parsed, "valid reply parses");
  assert.strictEqual(parsed.text.verdict, "fix");
  assert.strictEqual(parsed.privacyWarning, null);
  ok("parser accepts the required shape");

  assert.strictEqual(parseSemanticReply("not json at all"), null);
  assert.strictEqual(
    parseSemanticReply(JSON.stringify({ text: { verdict: "great", detail: "x" }, firstImpression: { verdict: "pass", detail: "y" }, privacy: { fires: false } })),
    null,
    "an out-of-vocabulary verdict is distrusted"
  );
  assert.strictEqual(
    parseSemanticReply(JSON.stringify({ text: { verdict: "pass", detail: "x" }, firstImpression: { verdict: "pass", detail: "y" }, privacy: { fires: true, name: "", detail: "" } })),
    null,
    "a firing warning with no name/detail is distrusted"
  );
  ok("parser distrusts malformed, out-of-vocabulary, and incomplete replies");

  const firing = parseSemanticReply(
    JSON.stringify({
      text: { verdict: "pass", detail: "No text." },
      firstImpression: { verdict: "pass", detail: "The creator at their desk." },
      privacy: { fires: true, name: "A readable home address on a letter.", detail: "Posting would make the address public." },
    })
  );
  assert(firing && firing.privacyWarning && firing.privacyWarning.name.includes("address"));
  ok("parser carries a named, firing privacy warning");

  // 2. Funding switch off (the environment for this test run has no
  // MODEL_CALLS_ENABLED=true): semantic checks are uncertain with a reason.
  delete process.env.MODEL_CALLS_ENABLED;
  const off = await runSemanticChecks(Buffer.from(""), "any intent");
  assert.strictEqual(off.source, "model-off");
  assert.strictEqual(off.text.verdict, "uncertain");
  assert(off.text.detail.includes("Billing"), "the reason names the funding gate");
  ok("with the funding switch off, semantic checks report uncertain with the reason");

  // 3. Measured verdicts match the design assertions for the photo takes.
  const mediaDir = path.join(__dirname, "..", "server", "seed-media");
  for (const [takeId, exp] of Object.entries(expected.takes)) {
    const want = exp.measuredNow;
    if (!want || !Object.keys(want).length) continue;
    const buffer = fs.readFileSync(path.join(mediaDir, `${takeId}.png`));
    const gt = JSON.parse(fs.readFileSync(path.join(mediaDir, `${takeId}.json`), "utf8"));
    const m = await measureImage(buffer, gt);
    const got = { framing: m.framing.verdict, crop: m.cropSafety.verdict, quality: m.quality.verdict };
    assert.deepStrictEqual(got, want, `${takeId} measured verdicts`);
    ok(`${takeId} measured verdicts match the design record`);
  }

  // 4. Proof copy, alt text, and the readiness rule.
  const fakeTake = { id: "ST-X", kind: "photo", title: "Fixture take", intent: "Show the thing." };
  const passResult = {
    checks: [
      { id: "framing", name: "Framing", verdict: "pass", detail: "Inside the frame.", source: "measured" },
      { id: "text", name: "Text in the image", verdict: "pass", detail: "No text.", source: "model" },
    ],
    privacyWarning: null,
    privacyWarningSource: "model",
  };
  const proof = buildProofCopy(fakeTake, passResult);
  assert(proof.includes("Framing: pass. Inside the frame. (Source: measured.)"), "proof copy quotes the check and its source");
  assert(proof.includes("yours alone"), "proof copy states it is private");
  ok("proof copy is assembled from the checks' own words, with sources");

  const alt = draftAltText(fakeTake, passResult);
  assert(alt.text.startsWith("Show the thing."), "alt draft leads with the creator's intent");
  assert.strictEqual(alt.source, "assembled");
  ok("alt text draft leads with intent and labels its source honestly");

  assert.strictEqual(readiness(passResult, { warningAcknowledged: false, altTextApproved: true }).ready, true);
  const warnResult = {
    ...passResult,
    privacyWarning: { name: "A readable address.", detail: "Posting makes it public." },
    privacyWarningSource: "model",
  };
  const blocked = readiness(warnResult, { warningAcknowledged: false, altTextApproved: true });
  assert.strictEqual(blocked.ready, false);
  assert(blocked.reasons.some((r) => r.includes("has not been acknowledged")), "warning blocks until acknowledged");
  assert.strictEqual(readiness(warnResult, { warningAcknowledged: true, altTextApproved: true }).ready, true);
  const fixResult = {
    ...passResult,
    checks: [{ id: "crop", name: "Crop safety", verdict: "fix", detail: "Cut.", source: "measured" }],
  };
  assert.strictEqual(readiness(fixResult, { warningAcknowledged: false, altTextApproved: true }).ready, false);
  ok("readiness: warning acknowledgement and outstanding fixes both gate, approval alone never suffices");

  // 5. Repairs: offered from verdicts, and the re-check flips the verdict.
  const p4buf = fs.readFileSync(path.join(mediaDir, "ST-P4.png"));
  const p4gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P4.json"), "utf8"));
  const p4m = await measureImage(p4buf, p4gt);
  const p4offers = availableRepairs(p4m, p4gt).map((r) => r.id);
  assert(p4offers.includes("reframe-fit-crops"), "P4 offers the crop reframe");
  const p4fixed = await applyRepair(p4buf, p4gt, "reframe-fit-crops", p4m);
  const p4after = await measureImage(p4fixed.buffer, p4fixed.groundTruth, p4fixed.contentBox);
  assert.strictEqual(p4after.cropSafety.verdict, "pass", "after the reframe, the measured crop verdict flips to pass");
  assert.strictEqual(p4after.quality.verdict, "pass", "after the reframe, quality still passes — the measurement judges the picture, not the repair's border");
  assert(p4fixed.changes.length >= 2, "the repair describes what changed in measurable terms");
  ok("ST-P4: crop repair is offered, performed, and the re-check passes");

  const p2buf = fs.readFileSync(path.join(mediaDir, "ST-P2.png"));
  const p2gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P2.json"), "utf8"));
  const p2m = await measureImage(p2buf, p2gt);
  assert(availableRepairs(p2m, p2gt).some((r) => r.id === "reframe-margin"));
  const p2fixed = await applyRepair(p2buf, p2gt, "reframe-margin", p2m);
  const p2after = await measureImage(p2fixed.buffer, p2fixed.groundTruth, p2fixed.contentBox);
  assert.strictEqual(p2after.framing.verdict, "pass", "after the reframe, the measured framing verdict flips to pass");
  assert.strictEqual(p2after.quality.verdict, "pass", "after the reframe, quality still passes on the scoped measurement");
  ok("ST-P2: framing repair is offered, performed, and the re-check passes");

  const darkBuf = await applyGain(fs.readFileSync(path.join(mediaDir, "ST-P1.png")), 0.12);
  const p1gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P1.json"), "utf8"));
  const darkM = await measureImage(darkBuf, p1gt);
  assert.strictEqual(darkM.quality.verdict, "fix", "a darkened take fails quality");
  assert(availableRepairs(darkM, p1gt).some((r) => r.id === "brightness-auto"));
  const brightFixed = await applyRepair(darkBuf, p1gt, "brightness-auto", darkM);
  const brightAfter = await measureImage(brightFixed.buffer, brightFixed.groundTruth);
  assert.strictEqual(brightAfter.quality.verdict, "pass", "after the automatic exposure repair, quality passes");
  assert(brightFixed.changes[0].includes("total gain"), "the exposure repair reports its measured before/after");
  ok("automatic exposure repair rescues a darkened take, measured end to end");

  const blownBuf = await applyGain(fs.readFileSync(path.join(mediaDir, "ST-P1.png")), 3.2);
  const blownM = await measureImage(blownBuf, p1gt);
  assert.strictEqual(blownM.quality.verdict, "fix", "a blown-out take fails quality");
  assert(blownM.quality.detail.includes("blown out"), "the failure names the blown exposure");
  assert(availableRepairs(blownM, p1gt).some((r) => r.id === "brightness-auto"), "the exposure repair is offered for a blown take too");
  const blownFixed = await applyRepair(blownBuf, p1gt, "brightness-auto", blownM);
  const blownAfter = await measureImage(blownFixed.buffer, blownFixed.groundTruth);
  assert(!blownAfter.quality.detail.includes("blown out"), "after the repair, the exposure itself measures in range");
  assert(!blownAfter.quality.detail.includes("very dark"), "and it is not overcorrected into darkness");
  ok("automatic exposure repair handles the blown-out direction too, without overcorrecting");

  // 6. Tier 2 public description: audience text from verified facts only.
  const pd = buildPublicDescription(fakeTake, passResult);
  assert.strictEqual(pd.available, true);
  assert(pd.text.startsWith("Show the thing."), "public description leads with the scene the creator intended");
  assert(!/measured|model check|source/i.test(pd.text), "public text carries no pipeline jargon");
  const pdVideo = buildPublicDescription({ ...fakeTake, kind: "video" }, passResult);
  assert.strictEqual(pdVideo.available, false, "a video with no media gets no invented description");
  ok("Tier 2 public description: facts only for photos, honest unavailability for media-less video");

const { sweep } = require("../server/library");

  // 7. Library Sweep slice: the pinned sort from the design record.
  const sw = sweep();
  assert.strictEqual(sw.simulated, true, "the slice labels itself simulated");
  assert.strictEqual(sw.totalItems, 6);
  assert.strictEqual(sw.totalFiles, 7, "the duplicate pair makes 7 files from 6 items");
  const shots = sw.categories.find((c) => c.name === "Screenshots");
  assert.strictEqual(shots.itemCount, 2, "two screenshots");
  const sl3 = sw.items.find((i) => i.id === "SL-3");
  assert.strictEqual(sl3.category, "Documents and text-heavy");
  assert.strictEqual(sw.privacyWarnings.length, 1, "exactly one warning at library scale");
  assert.strictEqual(sw.privacyWarnings[0].itemId, "SL-3");
  assert(sw.privacyWarnings[0].name.includes("readable home address"), "the warning states its reason");
  const sl4 = sw.items.find((i) => i.id === "SL-4");
  assert.strictEqual(sl4.files, 2, "the duplicate pair is one item of two files");
  ok("Library Sweep slice: pinned sort, totals, and the warning standing alone");

  // 8. ST-V2 video path: measured from its committed frames. Framing is
  // judged on the posted frame, crop and quality on the recorded frame —
  // the composition measureVideoFrames performs — and the verdicts match
  // the design record (SEED-TAKES, ST-V2): framing and crop fail, the
  // take itself is sharp and lit.
  const { measureVideoFrames } = require("../server/measure");
  const v2frame = fs.readFileSync(path.join(mediaDir, "ST-V2-frame.png"));
  const v2posted = fs.readFileSync(path.join(mediaDir, "ST-V2-posted.png"));
  const v2sidecar = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-V2.json"), "utf8"));
  const v2m = await measureVideoFrames(v2frame, v2posted, v2sidecar);
  assert.strictEqual(v2m.framing.verdict, "fix", "ST-V2 framing fails in the posted frame");
  assert.strictEqual(v2m.cropSafety.verdict, "fix", "ST-V2 crop fails");
  assert(v2m.cropSafety.detail.includes("banner"), "the crop failure names the banner, not a generic sign");
  assert.strictEqual(v2m.quality.verdict, "pass", "ST-V2 itself is sharp and lit");
  ok("ST-V2: framing, crop, and quality measured from its frames match the design record");

  const v2gt = { subject: v2sidecar.subject, sign: v2sidecar.banner, labels: { sign: "banner" } };
  const v2offers = availableRepairs(v2m, v2gt, { kind: "video", coverFrameAtSeconds: 10.5 }).map((r) => r.id);
  assert(v2offers.includes("reframe-fit-crops"), "the crop reframe is offered for the Reel");
  assert(v2offers.includes("cover-frame-hands-up"), "the cover-frame choice is offered for the Reel");
  assert(!v2offers.includes("reframe-margin"), "the photo margin reframe is not offered for a Reel");
  ok("ST-V2: the crop reframe and the cover-frame choice are offered; the photo margin reframe is not");

  const v2fixed = await applyRepair(v2frame, v2gt, "reframe-fit-crops", v2m);
  const { Jimp } = require("jimp");
  const v2win = v2sidecar.postedCropWindow;
  const v2rimg = await Jimp.fromBuffer(v2fixed.buffer);
  v2rimg.crop({
    x: Math.round(v2win.x0),
    y: Math.round(v2win.y0),
    w: Math.round(v2win.x1 - v2win.x0),
    h: Math.round(v2win.y1 - v2win.y0),
  });
  const v2repairedPosted = await v2rimg.getBuffer("image/png");
  const v2after = await measureVideoFrames(v2fixed.buffer, v2repairedPosted, {
    ...v2sidecar,
    subject: v2fixed.groundTruth.subject,
    banner: v2fixed.groundTruth.sign,
    contentBox: v2fixed.contentBox,
  });
  assert.strictEqual(v2after.cropSafety.verdict, "pass", "after the reframe, the measured crop verdict flips to pass");
  assert.strictEqual(v2after.framing.verdict, "pass", "after the reframe, the posted-frame framing verdict flips to pass");
  assert.strictEqual(v2after.quality.verdict, "pass", "after the reframe, quality still passes — the repair's own border is not graded");
  assert(v2after.quality.detail.includes("picture itself"), "the quality detail states the scoped basis plainly");
  ok("ST-V2: the reframe is performed and the re-check passes crop and framing");

  // The same repaired frame measured WITHOUT the repair's declared box
  // still fails quality: the box, and only the box, changes the basis —
  // the threshold never moved (Nexus ruling, Oct 29, 2026).
  const v2unscoped = await measureVideoFrames(v2fixed.buffer, v2repairedPosted, {
    ...v2sidecar,
    subject: v2fixed.groundTruth.subject,
    banner: v2fixed.groundTruth.sign,
  });
  assert.strictEqual(v2unscoped.quality.verdict, "fix", "without the declared box, the same frame still fails — the threshold did not move");
  ok("ST-V2: scoped and unscoped measurements of one frame differ only by the declared box");

  // 9. Blur discrimination, both directions: blurring a sharp take fails
  // quality, and reframing the blurred take does not rescue it — the
  // scoped measurement judges the picture, and the picture is blurred.
  const blurImg = await Jimp.fromBuffer(p2buf);
  blurImg.blur(3);
  const blurredBuf = await blurImg.getBuffer("image/png");
  const blurredM = await measureImage(blurredBuf, p2gt);
  assert.strictEqual(blurredM.quality.verdict, "fix", "a blurred take fails quality");
  assert(blurredM.quality.detail.includes("edges are smeared"), "the blur failure names the smeared edges");
  const blurredFixed = await applyRepair(blurredBuf, p2gt, "reframe-margin", blurredM);
  const blurredAfter = await measureImage(blurredFixed.buffer, blurredFixed.groundTruth, blurredFixed.contentBox);
  assert.strictEqual(blurredAfter.quality.verdict, "fix", "a reframed blurred take still fails quality on the scoped measurement");
  assert(blurredAfter.quality.detail.includes("edges are smeared"), "the scoped failure still names the smeared edges");
  ok("blur discrimination: the scoped measurement never rescues a genuinely blurred picture");

  // 10. Repair stacking: a chain applies each repair to the result of
  // the last. For ST-V2 the demo directs reframe, then the cover-frame
  // choice — and the cover only pays off inside the reframed frame, so
  // the choice replays the reframe's own transform on the hands-up
  // moment (Nexus ruling, Oct 29, 2026: "that's the point of the app").
  const { applyTransform, composeTransforms } = require("../server/repair");
  const sampleBox = { x0: 100, y0: 50, x1: 300, y1: 200 };
  const t1 = { factor: 0.5, offX: 10, offY: 20 };
  const t2 = { factor: 0.5, offX: 5, offY: 5 };
  const composed = composeTransforms(t1, t2);
  assert.strictEqual(composed.factor, 0.25, "composed transform multiplies the factors");
  assert.strictEqual(composed.offX, 10, "composed offset follows f2*o1 + o2");
  const v2chainCtx = { kind: "video", coverFrameAtSeconds: 10.5, chain: ["reframe-fit-crops"] };
  const v2chainOffers = availableRepairs(v2after, v2gt, v2chainCtx).map((r) => r.id);
  assert(v2chainOffers.includes("cover-frame-hands-up"), "on the reframed variant, the cover choice is offered");
  const v2fullCtx = { kind: "video", coverFrameAtSeconds: 10.5, chain: ["reframe-fit-crops", "cover-frame-hands-up"] };
  assert(
    !availableRepairs(v2after, v2gt, v2fullCtx).some((r) => r.id === "cover-frame-hands-up"),
    "a chain never offers a repair it already contains"
  );
  ok("stacking: transforms compose, and a chain never re-offers its own repairs");

  const v2cover = fs.readFileSync(path.join(mediaDir, "ST-V2-cover-frame.png"));
  const v2stacked = await applyTransform(
    v2cover,
    { subject: v2sidecar.subject, sign: v2sidecar.banner, privateItem: v2sidecar.privateItem },
    v2fixed.transform
  );
  const v2simg = await Jimp.fromBuffer(v2stacked.buffer);
  v2simg.crop({
    x: Math.round(v2win.x0),
    y: Math.round(v2win.y0),
    w: Math.round(v2win.x1 - v2win.x0),
    h: Math.round(v2win.y1 - v2win.y0),
  });
  const v2stackedM = await measureVideoFrames(v2stacked.buffer, await v2simg.getBuffer("image/png"), {
    ...v2sidecar,
    subject: v2stacked.groundTruth.subject,
    banner: v2stacked.groundTruth.sign,
    contentBox: v2stacked.contentBox,
  });
  assert.strictEqual(v2stackedM.framing.verdict, "pass", "stacked variant: framing passes in the posted frame");
  assert.strictEqual(v2stackedM.cropSafety.verdict, "pass", "stacked variant: the banner survives the crops");
  assert.strictEqual(v2stackedM.quality.verdict, "pass", "stacked variant: quality passes on the scoped measurement");
  ok("ST-V2 stacked chain: reframe, then the hands-up cover inside it — framing, crop, quality all pass");

  // 11. SAM wiring (Oct 30, 2026): the designed model supplies the
  // boxes when it answers; the take's recorded facts stand when it
  // returns no match; a failed call is reported, never papered over.
  // All branches run through injected segmenters — no network.
  const { locateBoxes, resolvePhotoBoxes } = require("../server/sam");
  const { ModelCallsDisabled } = require("../server/model-api");
  const p1buf = fs.readFileSync(path.join(mediaDir, "ST-P1.png"));

  const located = await locateBoxes(p1buf, async (buf, concept) =>
    concept === "person"
      ? [{ x0: 0, y0: 0, x1: 10, y1: 10 }, { x0: 324, y0: 201, x1: 676, y1: 798 }]
      : [{ x0: 301, y0: 621, x1: 699, y1: 720 }]
  );
  assert.strictEqual(located.status, "ok");
  assert.deepStrictEqual(located.subject, { x0: 324, y0: 201, x1: 676, y1: 798 }, "the largest person box is the subject");
  assert.deepStrictEqual(located.sign, { x0: 301, y0: 621, x1: 699, y1: 720 });
  ok("SAM locate: one call per concept, the largest box per concept is used");

  const samResolved = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: p1gt,
    segmenter: async (buf, concept) =>
      concept === "person" ? [{ x0: 324, y0: 201, x1: 676, y1: 798 }] : [{ x0: 301, y0: 621, x1: 699, y1: 720 }],
  });
  assert.strictEqual(samResolved.kind, "sam");
  const samMeasured = await measureImage(p1buf, samResolved.groundTruth);
  assert.strictEqual(samMeasured.framing.verdict, "pass", "ST-P1 framing passes on SAM's boxes");
  assert.strictEqual(samMeasured.cropSafety.verdict, "pass", "ST-P1 crop passes on SAM's boxes");
  ok("SAM boxes feed the measurement in place of the sidecar, verdicts unchanged");

  const noMatch = await resolvePhotoBoxes({
    buffer: p4buf,
    recorded: p4gt,
    segmenter: async () => [],
  });
  assert.strictEqual(noMatch.kind, "recorded");
  assert.strictEqual(noMatch.samAnswered, true, "a no-match is SAM's answer, not silence");
  const noMatchMeasured = await measureImage(p4buf, noMatch.groundTruth);
  assert.strictEqual(noMatchMeasured.cropSafety.verdict, "fix", "ST-P4's designed crop fix survives on the recorded facts");
  ok("SAM no-match: the take's recorded facts stand and the designed verdict holds");

  const callsOff = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: p1gt,
    segmenter: async () => { throw new ModelCallsDisabled(); },
  });
  assert.strictEqual(callsOff.kind, "recorded");
  assert.strictEqual(callsOff.samAnswered, false, "calls off is not reported as a SAM answer");
  const failed = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: p1gt,
    segmenter: async () => { throw new Error("SAM call failed with HTTP 500."); },
  });
  assert.strictEqual(failed.kind, "failed");
  assert(failed.reason.includes("HTTP 500"), "the failure reason is carried for the uncertain verdicts");
  ok("SAM resolution: calls-off falls back quietly; a real failure is reported, never hidden");

  // 12. Audio check, wired to transcription (stubs; no network). The
  // silent branch must not touch the transcriber at all — there is no
  // track to transcribe.
  const { runAudioCheck } = require("../server/audio");
  const silentAudio = await runAudioCheck({
    sidecar: { silent: true },
    transcriber: async () => { throw new Error("must never be called for a silent take"); },
  });
  assert.strictEqual(silentAudio.source, "determined");
  assert(silentAudio.detail.includes("Muse Voice Transcribe"), "the silent result names the transcription step");
  assert(silentAudio.detail.includes("silence is part of the take"), "and states the silence is part of the take");
  assert.strictEqual(silentAudio.transcript, null);
  ok("audio: a silent take names the transcription step and its own silence, with no model call");

  const speechSidecar = { silent: false, audioFile: "ST-X.wav" };
  const readSome = () => Buffer.from("fake audio bytes");
  const spoken = await runAudioCheck({
    sidecar: speechSidecar,
    readAudio: readSome,
    transcriber: async () => "hello everyone this is the announcement",
  });
  assert.strictEqual(spoken.verdict, "pass");
  assert.strictEqual(spoken.source, "model");
  assert(spoken.transcript.includes("announcement"), "the transcript is returned for the proof copy");
  const emptyTranscript = await runAudioCheck({
    sidecar: speechSidecar,
    readAudio: readSome,
    transcriber: async () => "   ",
  });
  assert.strictEqual(emptyTranscript.verdict, "uncertain", "no recovered words stays uncertain — words are never invented");
  const transcribeOff = await runAudioCheck({
    sidecar: speechSidecar,
    readAudio: readSome,
    transcriber: async () => { throw new ModelCallsDisabled(); },
  });
  assert.strictEqual(transcribeOff.source, "model-off");
  const transcribeFailed = await runAudioCheck({
    sidecar: speechSidecar,
    readAudio: readSome,
    transcriber: async () => { throw new Error("Transcribe call failed with HTTP 500."); },
  });
  assert.strictEqual(transcribeFailed.source, "model-error");
  assert.strictEqual(transcribeFailed.verdict, "uncertain");
  const noAudioFile = await runAudioCheck({
    sidecar: speechSidecar,
    readAudio: () => null,
    transcriber: async () => "unreachable",
  });
  assert.strictEqual(noAudioFile.verdict, "uncertain");
  assert(noAudioFile.detail.includes("no separate audio file"), "a speech track the backend cannot reach is stated plainly");
  ok("audio: transcription judges speech takes — pass on recovered words, uncertain on every failure shape");

  const spokenResult = { ...passResult, transcript: "hello everyone this is the announcement" };
  const spokenProof = buildProofCopy(fakeTake, spokenResult);
  assert(spokenProof.includes("What was said (transcribed by Muse Voice Transcribe):"), "the proof copy carries the speech as its own section");
  assert(spokenProof.includes("announcement"));
  ok("proof copy: the transcript appears as the speech section, separate from the visual checks");

  // 13. Described-audio script for ST-V2: drafted from the recorded
  // timeline, model when it answers readably, recorded-facts otherwise,
  // always a draft. A speech take without a transcript gets no script.
  const { buildDescribedAudio, parseScript } = require("../server/narrate");
  const { TAKES } = require("../server/seed-takes");
  const v2take = TAKES.find((t) => t.id === "ST-V2");
  const daOff = await buildDescribedAudio(v2take, v2sidecar, null, async () => { throw new ModelCallsDisabled(); });
  assert.strictEqual(daOff.available, true);
  assert.strictEqual(daOff.state, "draft", "a script is a draft until the creator approves it");
  assert.strictEqual(daOff.source, "recorded-facts");
  assert.deepStrictEqual(
    daOff.segments.map((s) => [s.start, s.end]),
    [[0, 9], [9, 12], [12, 15]],
    "segments follow the recorded timeline: banner, hands up 9-12, ending"
  );
  assert(daOff.segments[0].text.includes("SIGNAL OVER NOISE TOUR"), "the opening segment reads the banner's recorded text");
  assert(daOff.segments[1].text.includes("signs"), "the hands-up window is described as signing");
  ok("described audio: ST-V2's script drafts from the recorded timeline when calls are off");

  const daModel = await buildDescribedAudio(v2take, v2sidecar, null, async () =>
    JSON.stringify({ segments: [{ start: 0, end: 15, text: "The creator stands before a banner for the whole video." }] })
  );
  assert.strictEqual(daModel.source, "model");
  assert.strictEqual(daModel.segments.length, 1);
  const daGarbage = await buildDescribedAudio(v2take, v2sidecar, null, async () => "no json here");
  assert.strictEqual(daGarbage.source, "recorded-facts", "an unreadable model reply falls back to the recorded-facts draft");
  assert.strictEqual(parseScript(JSON.stringify({ segments: [{ start: 5, end: 5, text: "x" }] }), 15), null, "an empty span is distrusted");
  assert.strictEqual(parseScript(JSON.stringify({ segments: [{ start: 0, end: 99, text: "x" }] }), 15), null, "a segment past the duration is distrusted");
  ok("described audio: a readable model draft is used; an unreadable one is distrusted to the fallback");

  const daSpeech = await buildDescribedAudio(v2take, { ...v2sidecar, silent: false }, null, async () => "unreachable");
  assert.strictEqual(daSpeech.available, false, "a speech take without a transcript gets no guessed timings");
  assert(daSpeech.reason.includes("transcript"));
  const daNoMedia = await buildDescribedAudio(v2take, null, null, async () => "unreachable");
  assert.strictEqual(daNoMedia.available, false);
  ok("described audio: gap honesty — no transcript, no script; no media, no script");

  // 14. The Spark-judgement tier (Oct 30, 2026): when SAM answers with
  // no match AND the take has no recorded facts, Muse Spark estimates
  // the boxes and the measurement runs on the estimate, labelled
  // judgement. Recorded facts outrank the estimate; garbage and
  // calls-off both end in uncertainty, never a verdict.
  const { estimateBoxes, parseBoxes } = require("../server/judge");
  const estimated = { subject: { x0: 324, y0: 201, x1: 676, y1: 798 }, sign: { x0: 301, y0: 621, x1: 699, y1: 720 } };

  const judged = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => [],
    judge: async () => ({ status: "ok", ...estimated }),
  });
  assert.strictEqual(judged.kind, "judgement", "no SAM match and no recorded facts reaches the judgement tier");
  const judgedMeasured = await measureImage(p1buf, judged.groundTruth);
  assert.strictEqual(judgedMeasured.framing.verdict, "pass", "framing is computed from the estimated box");
  assert.strictEqual(judgedMeasured.cropSafety.verdict, "pass", "crop safety is computed from the estimated boxes");
  ok("judgement tier: SAM no-match + no recorded facts → framing/crop measured from Spark's estimate");

  let judgeCalled = false;
  const recordedWins = await resolvePhotoBoxes({
    buffer: p4buf,
    recorded: p4gt,
    segmenter: async () => [],
    judge: async () => { judgeCalled = true; return { status: "ok", ...estimated }; },
  });
  assert.strictEqual(recordedWins.kind, "recorded", "recorded facts outrank the judgement tier");
  assert.strictEqual(recordedWins.samAnswered, true);
  assert.strictEqual(judgeCalled, false, "the estimate is never asked for when recorded facts exist");
  ok("judgement tier: a take with recorded facts never falls through to the estimate");

  // The parser's distrust discipline, same as the semantic pipeline's.
  assert.strictEqual(parseBoxes("not json at all", 1000, 1000), null);
  assert.strictEqual(
    parseBoxes(JSON.stringify({ subject: { x0: 0, y0: 0, x1: 1200, y1: 500 }, sign: null }), 1000, 1000),
    null,
    "an out-of-range box is distrusted"
  );
  assert.strictEqual(
    parseBoxes(JSON.stringify({ subject: { x0: 500, y0: 0, x1: 500, y1: 500 }, sign: null }), 1000, 1000),
    null,
    "a zero-extent box is distrusted"
  );
  assert.strictEqual(
    parseBoxes(JSON.stringify({ subject: { x0: 1, y0: 2, x1: 3, y1: 4 }, sign: { x0: 0, y0: 0, x1: 0, y1: 9 } }), 1000, 1000),
    null,
    "a malformed sign box distrusts the whole reply"
  );
  assert.deepStrictEqual(
    parseBoxes(JSON.stringify(estimated), 1000, 1000),
    estimated,
    "a well-formed reply parses"
  );
  ok("judgement parser: non-JSON, out-of-range, and zero-extent replies are all distrusted");

  const stubChatBoxes = await estimateBoxes(p1buf, "intent", async () =>
    JSON.stringify({ subject: { x0: 10, y0: 20, x1: 900, y1: 950 }, sign: null })
  );
  assert.strictEqual(stubChatBoxes.status, "ok");
  assert.deepStrictEqual(stubChatBoxes.subject, { x0: 10, y0: 20, x1: 900, y1: 950 });
  await assert.rejects(
    () => estimateBoxes(p1buf, "intent", async () => "no boxes here"),
    /not trusted/,
    "an unreadable estimate reply throws rather than returning boxes"
  );
  const garbage = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => [],
    judge: async () => { throw new Error("The model reply could not be read as the required box shape, so it is not trusted."); },
  });
  assert.strictEqual(garbage.kind, "judgement-unavailable");
  assert(garbage.reason.includes("uncertain rather than guessed"), "the untrusted estimate ends in stated uncertainty");
  ok("judgement tier: an untrusted Spark reply makes framing/crop uncertain, never a verdict on garbage");

  const offNoRecorded = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => { throw new ModelCallsDisabled(); },
    judge: async () => { judgeCalled = true; return { status: "ok", ...estimated }; },
  });
  assert.strictEqual(offNoRecorded.kind, "judgement-unavailable");
  assert.strictEqual(offNoRecorded.callsOff, true);
  assert(offNoRecorded.reason.includes("switched off"), "the reason names the funding switch");
  assert.strictEqual(judgeCalled, false, "with calls off, no estimate is attempted");
  const estimateOff = await estimateBoxes(p1buf, "intent", async () => { throw new ModelCallsDisabled(); });
  assert.strictEqual(estimateOff.status, "disabled", "the estimator reports calls-off as a status, not an error");
  ok("judgement tier: calls off + no recorded facts → uncertain, with the switch named as the reason");

  console.log(`\n${passed} test groups passed.`);
}

main().catch((err) => {
  console.error("TEST FAILURE:", err.message);
  process.exit(1);
});
