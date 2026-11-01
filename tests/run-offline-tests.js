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
// 4. The SAM wiring's branches (boxes used, no-match handing to the
//    judgement tier, calls-off, reported failure), the judgement
//    tier itself in the Nexus's corrected order (SAM, then judgement,
//    recorded facts last), the judgement tier's model order (Muse
//    Wonder primary, Muse Spark 1.3-contributor fallback — section
//    15), the audio check's branches (silent take,
//    judged transcript, every failure shape), and the described-audio
//    script (model draft, recorded-facts draft, gap honesty) — all
//    through injected stubs, still no network.
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
  // choice. The cover composes its moment into a poster (Option B,
  // Nexus ruling, Nov 1, 2026): computed in the chain's geometry and
  // applied to the hands-up frame in one pass, so a stacked cover
  // lands on the same poster the bare choice produces.
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

  const { composeCoverFrame } = require("../server/repair");
  const v2cover = fs.readFileSync(path.join(mediaDir, "ST-V2-cover-frame.png"));
  const v2coverBoxes = {
    subject: v2sidecar.subject,
    sign: v2sidecar.banner,
    privateItem: v2sidecar.privateItem,
    extras: {
      bannerTextBox: v2sidecar.bannerTextBox,
      noiseWordBox: v2sidecar.noiseWordBox,
      tourWordBox: v2sidecar.tourWordBox,
    },
  };
  const postedOf = async (buffer) => {
    const img = await Jimp.fromBuffer(buffer);
    img.crop({
      x: Math.round(v2win.x0),
      y: Math.round(v2win.y0),
      w: Math.round(v2win.x1 - v2win.x0),
      h: Math.round(v2win.y1 - v2win.y0),
    });
    return img.getBuffer("image/png");
  };
  const v2stacked = await composeCoverFrame(v2cover, v2coverBoxes, v2fixed.transform);
  const v2stackedSidecar = {
    ...v2sidecar,
    subject: v2stacked.groundTruth.subject,
    banner: v2stacked.groundTruth.sign,
    ...v2stacked.extras,
    contentBox: v2stacked.contentBox,
  };
  const v2stackedM = await measureVideoFrames(v2stacked.buffer, await postedOf(v2stacked.buffer), v2stackedSidecar);
  assert.strictEqual(v2stackedM.framing.verdict, "pass", "stacked variant: framing passes in the posted frame");
  assert.strictEqual(v2stackedM.cropSafety.verdict, "pass", "stacked variant: the banner survives the crops");
  assert.strictEqual(v2stackedM.quality.verdict, "pass", "stacked variant: quality passes on the scoped measurement");
  ok("ST-V2 stacked chain: reframe, then the cover composed as a poster — framing, crop, quality all pass");

  // The composed cover's geometry, against the uncomposed cover it
  // replaces (the reframe transform replayed on the hands-up frame,
  // which left the subject low — centre 402 of 720 — in the posted
  // frame): the composed poster centres the subject vertically, keeps
  // the whole banner and its words inside the picture it declares,
  // and is a different file from both the raw cover frame and the
  // uncomposed replay.
  const v2postedSubject = {
    x0: v2stacked.groundTruth.subject.x0 - v2win.x0,
    y0: v2stacked.groundTruth.subject.y0 - v2win.y0,
    x1: v2stacked.groundTruth.subject.x1 - v2win.x0,
    y1: v2stacked.groundTruth.subject.y1 - v2win.y0,
  };
  assert(
    Math.abs((v2postedSubject.y0 + v2postedSubject.y1) / 2 - 360) <= 30,
    "the composed poster's subject is centred vertically in the posted frame"
  );
  const v2cb = v2stacked.contentBox;
  const v2banner = v2stacked.groundTruth.sign;
  assert(
    v2banner.x0 >= v2cb.x0 && v2banner.x1 <= v2cb.x1 && v2banner.y0 >= v2cb.y0 && v2banner.y1 <= v2cb.y1,
    "the whole banner sits inside the composed picture"
  );
  const v2tb = v2stacked.extras.bannerTextBox;
  assert(
    v2tb.x0 >= v2cb.x0 && v2tb.x1 <= v2cb.x1 && v2tb.y0 >= v2cb.y0 && v2tb.y1 <= v2cb.y1,
    "the banner's words sit whole inside the composed picture"
  );
  const v2uncomposed = await applyTransform(
    v2cover,
    { subject: v2sidecar.subject, sign: v2sidecar.banner, privateItem: v2sidecar.privateItem },
    v2fixed.transform
  );
  assert(!v2stacked.buffer.equals(v2cover), "the composed cover differs from the raw cover frame");
  assert(!v2stacked.buffer.equals(v2uncomposed.buffer), "the composed cover differs from the uncomposed replay");
  ok("cover composition: subject centred, the whole banner and its words inside the picture");

  // Stacking order: the bare cover choice composes the same poster
  // from the original's own geometry — its measured framing, crop,
  // and quality pass too, and its subject lands within a few pixels
  // of the stacked poster's.
  const v2bare = await composeCoverFrame(v2cover, v2coverBoxes, null);
  const v2bareM = await measureVideoFrames(v2bare.buffer, await postedOf(v2bare.buffer), {
    ...v2sidecar,
    subject: v2bare.groundTruth.subject,
    banner: v2bare.groundTruth.sign,
    ...v2bare.extras,
    contentBox: v2bare.contentBox,
  });
  assert.strictEqual(v2bareM.framing.verdict, "pass", "bare cover: framing passes in the posted frame");
  assert.strictEqual(v2bareM.cropSafety.verdict, "pass", "bare cover: the banner survives the crops");
  assert.strictEqual(v2bareM.quality.verdict, "pass", "bare cover: quality passes on the scoped measurement");
  const centreOf = (b) => ({ x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 });
  const bareC = centreOf(v2bare.groundTruth.subject);
  const stackedC = centreOf(v2stacked.groundTruth.subject);
  assert(
    Math.abs(bareC.x - stackedC.x) <= 6 && Math.abs(bareC.y - stackedC.y) <= 6,
    "bare and stacked cover compositions land on the same poster"
  );
  assert(!v2bare.buffer.equals(v2cover), "the bare composed cover differs from the raw cover frame");
  ok("cover composition: cover on the original and cover on the reframe both produce the composed poster");

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

  // Option A (Nexus ruling, Nov 1, 2026): a private item is not
  // protected content for the crop check. When a locating tier
  // reports the private item itself as the "sign", the sign is
  // dropped before measuring; a genuine sign elsewhere is kept.
  const p8bufA = fs.readFileSync(path.join(mediaDir, "ST-P8.png"));
  const p8gtA = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P8.json"), "utf8"));
  const judgedPrivate = await resolvePhotoBoxes({
    buffer: p8bufA,
    recorded: p8gtA,
    segmenter: async () => [],
    judge: async () => ({
      status: "ok",
      subject: p8gtA.subject,
      sign: p8gtA.privateItem,
      model: "stub",
    }),
  });
  assert.strictEqual(judgedPrivate.kind, "judgement");
  assert.strictEqual(judgedPrivate.groundTruth.sign, null, "the letter read as a sign is dropped — it is the private item");
  const p8CropOnly = await measureImage(p8bufA, judgedPrivate.groundTruth);
  assert.strictEqual(p8CropOnly.cropSafety.verdict, "pass", "ST-P8's crop settles from its subject once the letter leaves the protected set");
  const judgedSign = await resolvePhotoBoxes({
    buffer: p8bufA,
    recorded: p8gtA,
    segmenter: async () => [],
    judge: async () => ({
      status: "ok",
      subject: p8gtA.subject,
      sign: { x0: 60, y0: 40, x1: 420, y1: 130 },
      model: "stub",
    }),
  });
  assert.deepStrictEqual(judgedSign.groundTruth.sign, { x0: 60, y0: 40, x1: 420, y1: 130 }, "an intended sign elsewhere in the frame is kept");
  const samPrivate = await resolvePhotoBoxes({
    buffer: p8bufA,
    recorded: p8gtA,
    segmenter: async (buf, concept) => (concept === "person" ? [p8gtA.subject] : [p8gtA.privateItem]),
  });
  assert.strictEqual(samPrivate.kind, "sam");
  assert.strictEqual(samPrivate.groundTruth.sign, null, "the guard applies to SAM's boxes too");
  ok("crop protection (Option A): a private item reported as the sign is dropped on every locating tier; intended text is kept");

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

  // 14. The Spark-judgement tier, in the Nexus's corrected order
  // (Oct 30, 2026): SAM first, then Spark judgement, recorded facts
  // LAST. A usable Spark estimate sources the measurement even when
  // recorded facts exist; only a judgement that cannot supply boxes
  // falls through to them.
  const { estimateBoxes, parseBoxes } = require("../server/judge");
  const estimated = { subject: { x0: 324, y0: 201, x1: 676, y1: 798 }, sign: { x0: 301, y0: 621, x1: 699, y1: 720 } };

  let judgeCalled = false;
  const judgedFirst = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: p1gt,
    segmenter: async () => [],
    judge: async () => { judgeCalled = true; return { status: "ok", ...estimated }; },
  });
  assert.strictEqual(judgedFirst.kind, "judgement", "a usable estimate sources the measurement even when recorded facts exist");
  assert.strictEqual(judgeCalled, true, "the judgement tier is asked before the recorded facts are used");
  const judgedMeasured = await measureImage(p1buf, judgedFirst.groundTruth);
  assert.strictEqual(judgedMeasured.framing.verdict, "pass", "framing is computed from the estimated box");
  assert.strictEqual(judgedMeasured.cropSafety.verdict, "pass", "crop safety is computed from the estimated boxes");
  ok("judgement tier (corrected order): SAM no-match → Spark's estimate sources framing/crop, recorded facts notwithstanding");

  const judgedNoRecorded = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => [],
    judge: async () => ({ status: "ok", ...estimated }),
  });
  assert.strictEqual(judgedNoRecorded.kind, "judgement", "with no recorded facts the estimate is still the second tier");
  ok("judgement tier: SAM no-match + no recorded facts → the estimate sources the measurement");

  const missFallsToRecorded = await resolvePhotoBoxes({
    buffer: p4buf,
    recorded: p4gt,
    segmenter: async () => [],
    judge: async () => { throw new Error("The model reply could not be read as the required box shape, so it is not trusted."); },
  });
  assert.strictEqual(missFallsToRecorded.kind, "recorded", "an untrusted estimate falls through to the recorded facts");
  assert.strictEqual(missFallsToRecorded.judgementMiss.mode, "error", "the miss is reported, not hidden");
  const missMeasured = await measureImage(p4buf, missFallsToRecorded.groundTruth);
  assert.strictEqual(missMeasured.cropSafety.verdict, "fix", "ST-P4's designed crop fix holds on the recorded facts");
  ok("judgement tier: Spark malformed → recorded facts used, source recorded, miss reported");

  const garbageNoRecorded = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => [],
    judge: async () => { throw new Error("The model reply could not be read as the required box shape, so it is not trusted."); },
  });
  assert.strictEqual(garbageNoRecorded.kind, "judgement-unavailable");
  assert(garbageNoRecorded.reason.includes("uncertain rather than guessed"), "with no tier left, the outcome is stated uncertainty");
  ok("judgement tier: an untrusted Spark reply with no recorded facts → uncertain, never a verdict on garbage");

  const offNoRecorded = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async () => { throw new ModelCallsDisabled(); },
    judge: async () => { judgeCalled = true; return { status: "ok", ...estimated }; },
  });
  assert.strictEqual(offNoRecorded.kind, "judgement-unavailable");
  assert.strictEqual(offNoRecorded.callsOff, true);
  assert(offNoRecorded.reason.includes("switched off"), "the reason names the funding switch");
  const offWithRecorded = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: p1gt,
    segmenter: async () => { throw new ModelCallsDisabled(); },
    judge: async () => { throw new Error("must never be called with calls off"); },
  });
  assert.strictEqual(offWithRecorded.kind, "recorded", "calls off + recorded facts → recorded");
  assert.strictEqual(offWithRecorded.samAnswered, false, "calls off is not reported as a SAM answer");
  assert.strictEqual(offWithRecorded.judgementMiss, null, "with calls off the judgement tier is never reached");
  const estimateOff = await estimateBoxes(p1buf, "intent", async () => { throw new ModelCallsDisabled(); });
  assert.strictEqual(estimateOff.status, "disabled", "the estimator reports calls-off as a status, not an error");
  ok("judgement tier: calls off → recorded facts where they exist, uncertain where they do not");

  judgeCalled = false;
  const samWins = await resolvePhotoBoxes({
    buffer: p1buf,
    recorded: null,
    segmenter: async (buf, concept) =>
      concept === "person" ? [{ x0: 324, y0: 201, x1: 676, y1: 798 }] : [{ x0: 301, y0: 621, x1: 699, y1: 720 }],
    judge: async () => { judgeCalled = true; return { status: "ok", subject: { x0: 0, y0: 0, x1: 5, y1: 5 }, sign: null }; },
  });
  assert.strictEqual(samWins.kind, "sam", "a SAM match still wins over everything");
  assert.strictEqual(judgeCalled, false, "the judgement tier is never asked when SAM matches");
  ok("judgement tier: a SAM match outranks the estimate entirely");

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
  ok("judgement parser: non-JSON, out-of-range, and zero-extent replies are all distrusted");

  // 15. The judgement tier's model order (Nexus ruling, Xander, Oct 31,
  // 2026): Muse Wonder primary, Muse Spark 1.3-contributor fallback.
  // The wrap is shared (model-api.js's chatJudgement), so the cases run
  // through all three callers — box estimation, semantic checks, and
  // the described-audio draft — with recording stubs: no network.
  const { JUDGEMENT_PRIMARY_MODEL, JUDGEMENT_FALLBACK_MODEL } = require("../server/model-api");
  assert.strictEqual(JUDGEMENT_PRIMARY_MODEL, "muse-wonder-1.0");
  assert.strictEqual(JUDGEMENT_FALLBACK_MODEL, "muse-spark-1.3-contributor");
  function recordingChat(behaviors) {
    const calls = [];
    const chat = async (args) => {
      calls.push(args);
      const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)];
      if (behavior instanceof Error) throw behavior;
      return behavior;
    };
    return { chat, calls };
  }
  const goodBoxes = JSON.stringify(estimated);
  const http500 = new Error("Model API chat call failed with HTTP 500.");

  // (a) Wonder answers readably → the fallback is never called.
  {
    const { chat, calls } = recordingChat([goodBoxes]);
    const r = await estimateBoxes(p1buf, "intent", chat);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.model, "muse-wonder-1.0", "the answering model is reported");
    assert.strictEqual(calls.length, 1, "no fallback call when Wonder succeeds");
    assert.strictEqual(calls[0].model, "muse-wonder-1.0");
    ok("model fallback (a): Wonder success → no fallback call, model named");
  }

  // (b) Wonder's call fails → the same call is retried once on the
  // contributor fallback, identical but for the model.
  {
    const { chat, calls } = recordingChat([http500, goodBoxes]);
    const r = await estimateBoxes(p1buf, "intent", chat);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.model, "muse-spark-1.3-contributor");
    assert.strictEqual(calls.length, 2, "exactly one fallback attempt");
    assert.strictEqual(calls[1].model, "muse-spark-1.3-contributor");
    assert.deepStrictEqual(calls[1].messages, calls[0].messages, "the retry sends the identical prompt");
    assert.strictEqual(calls[1].temperature, calls[0].temperature, "and the identical temperature");
    ok("model fallback (b): Wonder transport error → contributor answers the identical call");
  }

  // (c) Wonder's reply is distrusted → the fallback is tried, and its
  // trusted reply is what sources the estimate.
  {
    const { chat, calls } = recordingChat(["no boxes here", goodBoxes]);
    const r = await estimateBoxes(p1buf, "intent", chat);
    assert.strictEqual(r.status, "ok");
    assert.strictEqual(r.model, "muse-spark-1.3-contributor");
    assert.strictEqual(calls.length, 2);
    ok("model fallback (c): Wonder reply distrusted → contributor used");
  }

  // (d) Both fail → the existing honest behaviour: a distrusted pair
  // throws "not trusted"; a failed pair surfaces the call error. No
  // verdict is ever built on either.
  {
    const bothGarbage = recordingChat(["junk", "also junk"]);
    await assert.rejects(() => estimateBoxes(p1buf, "intent", bothGarbage.chat), /not trusted/);
    assert.strictEqual(bothGarbage.calls.length, 2, "the fallback was tried before giving up");
    const bothDown = recordingChat([http500, new Error("Model API chat call failed with HTTP 503.")]);
    await assert.rejects(() => estimateBoxes(p1buf, "intent", bothDown.chat), /HTTP 503/, "the fallback attempt's error is the one reported");
    ok("model fallback (d): both models fail → the existing uncertain behaviour, nothing guessed");
  }

  // Calls off is not a fallback trigger: the switch gates every model,
  // so the disabled status returns after a single attempt.
  {
    const { chat, calls } = recordingChat([new ModelCallsDisabled()]);
    const r = await estimateBoxes(p1buf, "intent", chat);
    assert.strictEqual(r.status, "disabled");
    assert.strictEqual(calls.length, 1, "no fallback attempt when calls are switched off");
    ok("model fallback: calls off propagates at once — the switch gates both models");
  }

  // The same semantics in the semantic pipeline: Wonder distrusted →
  // contributor's verdicts are used and the model is named; both
  // distrusted → model-unreadable; both failing → model-error.
  {
    const semFallback = recordingChat(["not json", good]);
    const sem = await runSemanticChecks(p1buf, "intent", semFallback.chat);
    assert.strictEqual(sem.source, "model");
    assert.strictEqual(sem.model, "muse-spark-1.3-contributor");
    assert.strictEqual(sem.text.verdict, "fix", "the contributor reply's verdicts are the ones used");
    const semUnreadable = await runSemanticChecks(p1buf, "intent", recordingChat(["junk", "junk"]).chat);
    assert.strictEqual(semUnreadable.source, "model-unreadable");
    assert.strictEqual(semUnreadable.text.verdict, "uncertain");
    const semError = await runSemanticChecks(p1buf, "intent", recordingChat([http500, http500]).chat);
    assert.strictEqual(semError.source, "model-error");
    assert.strictEqual(semError.text.verdict, "uncertain");
    const semPrimary = await runSemanticChecks(p1buf, "intent", recordingChat([good]).chat);
    assert.strictEqual(semPrimary.model, "muse-wonder-1.0");
    ok("model fallback: semantic checks share the order — Wonder, contributor, then honest uncertainty");
  }

  // And in the described-audio draft: Wonder distrusted → the
  // contributor draft is used; both distrusted → the recorded-facts
  // draft, exactly as before the tier change.
  {
    const script = JSON.stringify({ segments: [{ start: 0, end: 15, text: "The creator stands before a banner." }] });
    const daFallback = await buildDescribedAudio(v2take, v2sidecar, null, recordingChat(["junk", script]).chat);
    assert.strictEqual(daFallback.source, "model", "the contributor draft is used when Wonder's is distrusted");
    const daBothBad = await buildDescribedAudio(v2take, v2sidecar, null, recordingChat(["junk", "junk"]).chat);
    assert.strictEqual(daBothBad.source, "recorded-facts");
    ok("model fallback: described audio shares the order, recorded-facts draft last");
  }

  // 16. Check your own photo (Nexus ruling, Xander, Oct 31, 2026): the
  // upload pipeline and its working session. A supplied photo has no
  // recorded facts and no stated intent, so the box chain ends at SAM
  // or the judgement tier — or at honest uncertainty, never a pass and
  // never a "recorded" source. The check opens a session (the seeded
  // flow at parity: repairs, re-check, copy) over a working copy that
  // lives at most two hours. The HTTP cases run the real handlers on
  // an ephemeral port with stubbed model pieces: no network, no spend.
  const {
    buildUploadChecks,
    handleUploadCheck,
    handleUploadRoutes,
    sessionMediaPath,
    sweepUploadSessions,
    UPLOAD_TMP_DIR,
    MAX_UPLOAD_BYTES,
  } = require("../server/upload");
  const http = require("http");
  // Start from a clean temp dir so leftovers can be asserted exactly.
  fs.mkdirSync(UPLOAD_TMP_DIR, { recursive: true });
  for (const f of fs.readdirSync(UPLOAD_TMP_DIR)) {
    fs.rmSync(path.join(UPLOAD_TMP_DIR, f), { recursive: true, force: true });
  }
  const uploadSeg = async (buf, concept) =>
    concept === "person"
      ? [{ x0: 324, y0: 201, x1: 676, y1: 798 }]
      : [{ x0: 301, y0: 621, x1: 699, y1: 720 }];
  const uploadChat = async () => good;

  const upSam = await buildUploadChecks(p1buf, { segmenter: uploadSeg, chat: uploadChat });
  assert.strictEqual(upSam.origin, "upload");
  assert.strictEqual(upSam.measurementSource, "sam");
  assert.strictEqual(upSam.checks.length, 6, "the upload result carries all six checks");
  assert.strictEqual(upSam.checks.find((c) => c.id === "framing").verdict, "pass");
  assert.strictEqual(upSam.checks.find((c) => c.id === "framing").source, "sam");
  assert.strictEqual(upSam.checks.find((c) => c.id === "quality").source, "measured");
  assert(
    upSam.checks.every((c) => c.source !== "recorded"),
    "an upload's checks never claim a recorded source"
  );
  assert(upSam.note.includes("no recorded facts"), "the response states the missing recorded facts plainly");
  ok("upload (a): a valid PNG returns the checks shape, sourced from SAM, never recorded");

  const upJudged = await buildUploadChecks(p1buf, {
    segmenter: async () => [],
    judge: async () => ({ status: "ok", ...estimated, model: "muse-wonder-1.0" }),
    chat: uploadChat,
  });
  assert.strictEqual(upJudged.measurementSource, "judgement");
  assert.strictEqual(upJudged.checks.find((c) => c.id === "crop").source, "judgement");
  assert.strictEqual(upJudged.checks.find((c) => c.id === "framing").verdict, "pass");
  ok("upload: SAM no-match → the judgement tier sources a supplied photo's framing/crop");

  const upLost = await buildUploadChecks(p1buf, {
    segmenter: async () => [],
    judge: async () => {
      throw new Error("The model reply could not be read as the required box shape, so it is not trusted.");
    },
    chat: uploadChat,
  });
  assert.strictEqual(upLost.measurementSource, "judgement-unavailable");
  assert.strictEqual(upLost.checks.find((c) => c.id === "framing").verdict, "uncertain");
  assert.strictEqual(upLost.checks.find((c) => c.id === "crop").verdict, "uncertain");
  const upFailed = await buildUploadChecks(p1buf, {
    segmenter: async () => {
      throw new Error("SAM call failed with HTTP 500.");
    },
    chat: uploadChat,
  });
  assert.strictEqual(upFailed.measurementSource, "sam-failed");
  assert.strictEqual(upFailed.checks.find((c) => c.id === "framing").verdict, "uncertain");
  ok("upload (d): no tier can locate the subject → framing/crop uncertain, never a pass");

  // Option A for uploads (Nexus ruling, Nov 1, 2026): the semantic
  // step and the region estimate run before the boxes are resolved,
  // so when the boxes judge reports the private item itself as the
  // sign, the crop check drops it — and keeps it when no region
  // could be located, because then nothing proves it is private.
  const { runUploadChecks } = require("../server/upload");
  const p8upBuf = fs.readFileSync(path.join(mediaDir, "ST-P8.png"));
  const firingReplyA = JSON.stringify({
    text: { verdict: "pass", detail: "A letter is visible." },
    firstImpression: { verdict: "pass", detail: "A person at a desk." },
    privacy: { fires: true, name: "A readable home address on a letter.", detail: "Posting would make the address public." },
  });
  const letterJudge = async () => ({
    status: "ok",
    subject: { x0: 300, y0: 180, x1: 620, y1: 820 },
    sign: { x0: 700, y0: 800, x1: 950, y1: 950 },
    model: "stub",
  });
  const guardedUp = await runUploadChecks(p8upBuf, {
    segmenter: async () => [],
    judge: letterJudge,
    chat: async () => firingReplyA,
    regionEstimator: async () => ({ status: "ok", region: { x0: 700, y0: 800, x1: 950, y1: 950 } }),
  });
  assert.strictEqual(guardedUp.result.privacyRedactionOffered, true, "the located letter still offers its removal");
  assert.strictEqual(guardedUp.boxes.sign, null, "the letter is dropped from the crop check's protected set");
  assert.strictEqual(
    guardedUp.result.checks.find((c) => c.id === "crop").verdict,
    "pass",
    "the upload's crop settles from its subject once the letter leaves the protected set"
  );
  const unguardedUp = await runUploadChecks(p8upBuf, {
    segmenter: async () => [],
    judge: letterJudge,
    chat: async () => firingReplyA,
    regionEstimator: async () => ({ status: "ok", region: null }),
  });
  assert.deepStrictEqual(unguardedUp.boxes.sign, { x0: 700, y0: 800, x1: 950, y1: 950 }, "no located region — the reported sign stands");
  assert.strictEqual(
    unguardedUp.result.checks.find((c) => c.id === "crop").verdict,
    "fix",
    "without a located region the same box still flags the crop"
  );
  ok("upload (Option A): a located private item leaves the crop protected set; an unlocated one changes nothing");

  const uploadHttp = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/uploads/")) {
      handleUploadRoutes(req, res, url, { segmenter: uploadSeg, chat: uploadChat }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => uploadHttp.listen(0, "127.0.0.1", resolve));
  const upBase = `http://127.0.0.1:${uploadHttp.address().port}`;
  try {
    // (e) A completed request opens exactly one session — its own —
    // and keeps the original inside it for the flow that follows.
    const okRes = await fetch(`${upBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: p1buf,
    });
    assert.strictEqual(okRes.status, 200);
    const okBody = await okRes.json();
    assert.strictEqual(okBody.origin, "upload");
    assert.strictEqual(okBody.measurementSource, "sam");
    assert.match(okBody.sessionId, /^[a-f0-9]{32}$/, "the check answers with its session id");
    assert.deepStrictEqual(
      fs.readdirSync(UPLOAD_TMP_DIR),
      [okBody.sessionId],
      "the temp dir holds exactly the new session"
    );
    assert(
      fs.readdirSync(path.join(UPLOAD_TMP_DIR, okBody.sessionId)).includes("original.png"),
      "the session keeps the original photo"
    );
    fs.rmSync(path.join(UPLOAD_TMP_DIR, okBody.sessionId), { recursive: true, force: true });
    assert.deepStrictEqual(fs.readdirSync(UPLOAD_TMP_DIR), [], "cleanup leaves the temp dir empty");
    ok("upload (e): a completed request creates exactly its own session and keeps the original");

    // (c) A non-PNG body is rejected before any file exists.
    const badRes = await fetch(`${upBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.from("this is not a png"),
    });
    assert.strictEqual(badRes.status, 415);
    const badBody = await badRes.json();
    assert(badBody.error.includes("not a PNG"), "the rejection says why, plainly");
    assert.deepStrictEqual(fs.readdirSync(UPLOAD_TMP_DIR), [], "a rejected body leaves nothing behind");
    ok("upload (c): a non-PNG body is rejected with a clear error, nothing stored");

    // (b) An over-cap body is rejected under the cap — 413, and no
    // file ever reaches the temp dir.
    const bigRes = await fetch(`${upBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: Buffer.alloc(MAX_UPLOAD_BYTES + 1024, 1),
    });
    assert.strictEqual(bigRes.status, 413);
    assert.deepStrictEqual(
      fs.readdirSync(UPLOAD_TMP_DIR),
      [],
      "an over-cap upload never reaches the temp dir"
    );
    ok("upload (b): an over-cap body is rejected at the cap, no file left behind");
  } finally {
    uploadHttp.close();
  }

  // 17. The upload session flow, end to end over HTTP with stubs: a
  // photo whose sign runs off the crop (the ST-P4 shape) must be
  // offered the fit-crops reframe; applying it must re-check and
  // report the measured outcome; the copy endpoint must answer from
  // the session's own results. The stub segmenter plays a segmenter
  // that sees what it is given: the original bytes get the wide,
  // crop-cutting boxes; any other bytes (the repaired picture) get
  // the fitted boxes a real segmenter would find in it.
  const p4Seg = async (buf, concept) => {
    const original = buf.equals(p1buf);
    if (concept === "person") return [original ? { x0: 350, y0: 200, x1: 650, y1: 800 } : { x0: 350, y0: 275, x1: 650, y1: 725 }];
    return [original ? { x0: 250, y0: 600, x1: 1000, y1: 700 } : { x0: 300, y0: 620, x1: 700, y1: 700 }];
  };
  const sessionHttp = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/uploads/")) {
      handleUploadRoutes(req, res, url, { segmenter: p4Seg, chat: uploadChat }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => sessionHttp.listen(0, "127.0.0.1", resolve));
  const sBase = `http://127.0.0.1:${sessionHttp.address().port}`;
  try {
    const checkRes = await fetch(`${sBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: p1buf,
    });
    assert.strictEqual(checkRes.status, 200);
    const checkBody = await checkRes.json();
    const sid = checkBody.sessionId;
    assert.match(sid, /^[a-f0-9]{32}$/);
    assert.strictEqual(checkBody.checks.find((c) => c.id === "crop").verdict, "fix", "the wide sign reads crop fix");

    const repairsRes = await fetch(`${sBase}/api/uploads/${sid}/repairs`);
    assert.strictEqual(repairsRes.status, 200);
    const repairsBody = await repairsRes.json();
    assert(
      repairsBody.repairs.some((r) => r.id === "reframe-fit-crops"),
      "the crop fix offers the fit-crops reframe"
    );
    ok("upload session: creation, and the crop fix offers its reframe repair");

    const applyRes = await fetch(`${sBase}/api/uploads/${sid}/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repairId: "reframe-fit-crops" }),
    });
    assert.strictEqual(applyRes.status, 200);
    const applyBody = await applyRes.json();
    assert.strictEqual(applyBody.variantId, "reframe-fit-crops");
    assert(applyBody.changes.length >= 2, "the repair reports what changed");
    assert.strictEqual(applyBody.outcome.checkId, "crop");
    assert.strictEqual(applyBody.outcome.before, "fix");
    assert.strictEqual(applyBody.outcome.after, "pass", "the re-check measures the repaired picture and the crop passes");
    assert.strictEqual(applyBody.outcome.improved, true);
    assert.strictEqual(applyBody.result.variant, "reframe-fit-crops");
    assert(
      fs.existsSync(path.join(UPLOAD_TMP_DIR, sid, "reframe-fit-crops.png")),
      "the repaired variant is a file in the session"
    );
    ok("upload session: applying the reframe re-checks and reports the measured outcome");

    const copyRes = await fetch(`${sBase}/api/uploads/${sid}/copy?variant=reframe-fit-crops`);
    assert.strictEqual(copyRes.status, 200);
    const copyBody = await copyRes.json();
    assert(copyBody.proofCopy.includes("Proof copy for your photo"), "the proof copy is the upload's own");
    assert(copyBody.proofCopy.includes("no recorded facts"), "the proof copy states the missing record plainly");
    assert(copyBody.altText.text.startsWith("A photo."), "the alt text draft is assembled from the checks");
    assert.strictEqual(copyBody.altText.source, "assembled");
    ok("upload session: the copy endpoint builds proof copy and an alt text draft from the session's results");

    const mediaRes = await fetch(`${sBase}/api/uploads/${sid}/media?variant=reframe-fit-crops`);
    assert.strictEqual(mediaRes.status, 200);
    assert((mediaRes.headers.get("content-type") || "").includes("image/png"));
    const mediaBuf = Buffer.from(await mediaRes.arrayBuffer());
    assert.strictEqual(mediaBuf.subarray(0, 4).toString("hex"), "89504e47", "the media route serves the variant PNG");
    const origMediaRes = await fetch(`${sBase}/api/uploads/${sid}/media`);
    assert.strictEqual(origMediaRes.status, 200);
    ok("upload session: the media route serves the current variant and the original");

    const readyRes = await fetch(`${sBase}/api/uploads/${sid}/readiness`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variant: "reframe-fit-crops", warningAcknowledged: true, altTextApproved: true }),
    });
    assert.strictEqual(readyRes.status, 200);
    const readyBody = await readyRes.json();
    assert.strictEqual(typeof readyBody.ready, "boolean");
    assert(Array.isArray(readyBody.reasons));
    ok("upload session: readiness answers over the session's own results");

    // Isolation: a second session cannot be served the first
    // session's repaired file, and traversal shapes are rejected
    // before any path is built.
    const check2Res = await fetch(`${sBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: p1buf,
    });
    const sid2 = (await check2Res.json()).sessionId;
    const crossRes = await fetch(`${sBase}/api/uploads/${sid2}/media?variant=reframe-fit-crops`);
    assert.strictEqual(crossRes.status, 404, "one session cannot address another session's variant");
    const travRes = await fetch(`${sBase}/api/uploads/${sid}/media?variant=${encodeURIComponent("../../secret")}`);
    assert.strictEqual(travRes.status, 400, "a traversal-shaped variant chain is rejected");
    const badSidRes = await fetch(`${sBase}/api/uploads/${encodeURIComponent("../../etc")}/media`);
    assert.strictEqual(badSidRes.status, 404, "a traversal-shaped session id is rejected");
    const ghostRes = await fetch(`${sBase}/api/uploads/${"0".repeat(32)}/checks`);
    assert.strictEqual(ghostRes.status, 404, "a well-formed but unknown session is a 404");
    assert.strictEqual(sessionMediaPath(sid, "../../secret"), null, "the path resolver refuses traversal chains");
    assert.strictEqual(sessionMediaPath("../../etc", null), null, "the path resolver refuses traversal session ids");
    const ownPath = sessionMediaPath(sid, "reframe-fit-crops");
    assert(ownPath && ownPath.startsWith(path.join(UPLOAD_TMP_DIR, sid)), "a valid path stays inside its session");
    ok("upload session: isolation — no session can address another's files; traversal shapes are rejected");

    fs.rmSync(path.join(UPLOAD_TMP_DIR, sid), { recursive: true, force: true });
    fs.rmSync(path.join(UPLOAD_TMP_DIR, sid2), { recursive: true, force: true });
  } finally {
    sessionHttp.close();
  }

  // 18. The age sweep: a session directory older than two hours is
  // deleted; a fresh one is left alone.
  {
    const oldId = "a".repeat(32);
    const freshId = "b".repeat(32);
    for (const id of [oldId, freshId]) {
      fs.mkdirSync(path.join(UPLOAD_TMP_DIR, id), { recursive: true });
      fs.writeFileSync(path.join(UPLOAD_TMP_DIR, id, "original.png"), p1buf);
    }
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000);
    fs.utimesSync(path.join(UPLOAD_TMP_DIR, oldId), threeHoursAgo, threeHoursAgo);
    await sweepUploadSessions(Date.now());
    assert(!fs.existsSync(path.join(UPLOAD_TMP_DIR, oldId)), "the stale session is swept");
    assert(fs.existsSync(path.join(UPLOAD_TMP_DIR, freshId)), "the fresh session survives the sweep");
    fs.rmSync(path.join(UPLOAD_TMP_DIR, freshId), { recursive: true, force: true });
    ok("upload session: the two-hour sweep deletes stale sessions and keeps fresh ones");
  }

  // 19. Privacy redaction (Nexus order, Nov 1, 2026): the privacy
  // warning must have an action, not just words. The repair paints an
  // opaque cover over the located private region; it is offered only
  // while the warning is active and a region is known; and it counts
  // only when the re-check can no longer read the information.
  const { REDACT_REPAIR_ID } = require("../server/repair");
  const { estimatePrivateRegion, parsePrivateRegion } = require("../server/judge");
  const p8buf = fs.readFileSync(path.join(mediaDir, "ST-P8.png"));
  const p8gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P8.json"), "utf8"));
  const p8m = await measureImage(p8buf, p8gt);
  assert(
    availableRepairs(p8m, p8gt, { privacy: { active: true, region: p8gt.privateItem } }).some((r) => r.id === REDACT_REPAIR_ID),
    "an active warning with a located region offers the redaction"
  );
  assert(
    !availableRepairs(p8m, p8gt, { privacy: { active: false, region: p8gt.privateItem } }).some((r) => r.id === REDACT_REPAIR_ID),
    "no warning, no redaction offer"
  );
  assert(
    !availableRepairs(p8m, p8gt, { privacy: { active: true, region: null } }).some((r) => r.id === REDACT_REPAIR_ID),
    "a warning without a located region offers nothing"
  );
  assert(
    !availableRepairs(p8m, p8gt, { chain: [REDACT_REPAIR_ID], privacy: { active: true, region: p8gt.privateItem } }).some((r) => r.id === REDACT_REPAIR_ID),
    "a chain never re-offers the redaction it already contains"
  );
  ok("redaction: offered only while the warning is active, a region is located, and the chain lacks it");

  const p8redacted = await applyRepair(p8buf, p8gt, REDACT_REPAIR_ID, p8m);
  const p8img = await Jimp.fromBuffer(p8redacted.buffer);
  assert.strictEqual(p8img.getPixelColor(825, 875), 0x000000ff, "the private region is under an opaque black cover");
  const p8orig = await Jimp.fromBuffer(p8buf);
  assert.strictEqual(p8img.getPixelColor(10, 10), p8orig.getPixelColor(10, 10), "outside the cover, the picture is untouched");
  assert.deepStrictEqual(p8redacted.groundTruth.privateItem, p8gt.privateItem, "the record of the region is carried forward");
  assert(p8redacted.changes.length >= 2, "the repair describes what changed in measurable terms");
  ok("redaction: the cover is opaque over the region and nothing else changes");

  const p8stacked = await applyRepair(
    p8redacted.buffer,
    p8redacted.groundTruth,
    "reframe-margin",
    await measureImage(p8redacted.buffer, p8redacted.groundTruth)
  );
  const stackedImg = await Jimp.fromBuffer(p8stacked.buffer);
  const st = p8stacked.groundTruth.privateItem;
  assert.strictEqual(
    stackedImg.getPixelColor(Math.round((st.x0 + st.x1) / 2), Math.round((st.y0 + st.y1) / 2)),
    0x000000ff,
    "the cover survives stacking under a reframe"
  );
  ok("redaction: stacks with another repair without breaking the chain");

  assert.deepStrictEqual(
    parsePrivateRegion(JSON.stringify({ privateItem: { x0: 1, y0: 2, x1: 30, y1: 40 } }), 100, 100),
    { region: { x0: 1, y0: 2, x1: 30, y1: 40 } }
  );
  assert.deepStrictEqual(
    parsePrivateRegion(JSON.stringify({ privateItem: null }), 100, 100),
    { region: null },
    "the model may say the item cannot be located — a trusted answer, not a failure"
  );
  assert.strictEqual(
    parsePrivateRegion(JSON.stringify({ privateItem: { x0: 0, y0: 0, x1: 500, y1: 40 } }), 100, 100),
    null,
    "an out-of-range region is distrusted"
  );
  assert.strictEqual(parsePrivateRegion("no json", 100, 100), null);
  const estOk = await estimatePrivateRegion(p1buf, "A readable home address on a letter.", async () =>
    JSON.stringify({ privateItem: { x0: 10, y0: 10, x1: 100, y1: 100 } })
  );
  assert.strictEqual(estOk.status, "ok");
  assert.deepStrictEqual(estOk.region, { x0: 10, y0: 10, x1: 100, y1: 100 });
  await assert.rejects(
    () => estimatePrivateRegion(p1buf, "x", async () => "garbage"),
    /not trusted/,
    "an unreadable region reply throws rather than returning a box"
  );
  ok("redaction: the region estimate is parsed with the same distrust as every judgement reply");

  // The upload session, end to end over HTTP: a firing warning with a
  // located region offers the redaction; applying it clears the
  // warning on the re-check, reported in the before/after pattern.
  // The semantic stub fires for the original's checks (creation, the
  // repairs listing, the repair's own before-check) and clears for
  // the re-check of the covered picture.
  const firingReply = JSON.stringify({
    text: { verdict: "pass", detail: "No text." },
    firstImpression: { verdict: "pass", detail: "A person at a desk." },
    privacy: { fires: true, name: "A readable home address on a letter.", detail: "Posting would make the address public." },
  });
  const clearReply = JSON.stringify({
    text: { verdict: "pass", detail: "No text." },
    firstImpression: { verdict: "pass", detail: "A person at a desk." },
    privacy: { fires: false, name: "", detail: "" },
  });
  let semCalls = 0;
  const privacyChat = async () => (++semCalls <= 3 ? firingReply : clearReply);
  const regionStub = async () => ({
    status: "ok",
    region: { x0: 700, y0: 800, x1: 950, y1: 950 },
    model: "muse-wonder-1.0",
  });
  const privacyHttp = http.createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/uploads/")) {
      handleUploadRoutes(req, res, url, { segmenter: uploadSeg, chat: privacyChat, regionEstimator: regionStub }).catch((err) => {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: err.message }));
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => privacyHttp.listen(0, "127.0.0.1", resolve));
  const prBase = `http://127.0.0.1:${privacyHttp.address().port}`;
  try {
    const checkRes = await fetch(`${prBase}/api/uploads/check`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: p8buf,
    });
    assert.strictEqual(checkRes.status, 200);
    const checkBody = await checkRes.json();
    const psid = checkBody.sessionId;
    assert(checkBody.privacyWarning, "the warning fires on the supplied photo");
    assert.deepStrictEqual(checkBody.privacyRegion, { x0: 700, y0: 800, x1: 950, y1: 950 }, "the region is stored in the check result");
    assert.strictEqual(checkBody.privacyRedactionOffered, true);

    const repairsRes = await fetch(`${prBase}/api/uploads/${psid}/repairs`);
    const repairsBody = await repairsRes.json();
    assert(repairsBody.repairs.some((r) => r.id === REDACT_REPAIR_ID), "the session offers the redaction");
    ok("redaction (upload): a firing warning with a located region offers the repair");

    const applyRes = await fetch(`${prBase}/api/uploads/${psid}/repair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repairId: REDACT_REPAIR_ID }),
    });
    assert.strictEqual(applyRes.status, 200);
    const applyBody = await applyRes.json();
    assert.strictEqual(applyBody.variantId, REDACT_REPAIR_ID);
    assert.strictEqual(applyBody.outcome.checkId, "privacy");
    assert.strictEqual(applyBody.outcome.checkName, "Private-information warning");
    assert.strictEqual(applyBody.outcome.before, "showing");
    assert.strictEqual(applyBody.outcome.after, "clear", "the re-run privacy check can no longer read the information");
    assert.strictEqual(applyBody.outcome.improved, true);
    assert.strictEqual(applyBody.result.privacyWarning, null);
    const variantMedia = await fetch(`${prBase}/api/uploads/${psid}/media?variant=${REDACT_REPAIR_ID}`);
    assert.strictEqual(variantMedia.status, 200, "the covered variant is served by the session media route");
    ok("redaction (upload): applied, re-checked clear, and reported in the before/after pattern");

    fs.rmSync(path.join(UPLOAD_TMP_DIR, psid), { recursive: true, force: true });
  } finally {
    privacyHttp.close();
  }

  // A firing warning whose region cannot be located: no offer, and
  // the client's plain-sentence path exists in the shipped client.
  const noRegion = await buildUploadChecks(p8buf, {
    segmenter: uploadSeg,
    chat: async () => firingReply,
    regionEstimator: async () => ({ status: "ok", region: null }),
  });
  assert(noRegion.privacyWarning, "the warning still fires");
  assert.strictEqual(noRegion.privacyRegion, null);
  assert.strictEqual(noRegion.privacyRedactionOffered, false);
  const clientSrc = fs.readFileSync(path.join(__dirname, "..", "client", "app.js"), "utf8");
  assert(
    clientSrc.includes("cannot locate it precisely enough to take it off automatically"),
    "the client carries the plain no-region sentence"
  );
  assert(
    clientSrc.includes("A repair below can take the private information off this photo."),
    "the client carries the offered-repair line under the warning"
  );
  ok("redaction (upload): a warning without a locatable region offers nothing, and the client says so plainly");

  // Described-audio playback wiring (Nexus decision, Nov 1, 2026):
  // the device-voice playback exists in the shipped client, labelled
  // as the device's own voice, with the no-synthesis sentence path
  // and a stop on take switch. Hearing it is a real-device check;
  // what is asserted here is that the code path is served.
  assert(clientSrc.includes("speechSynthesis"), "the client wires the browser's speech synthesis");
  assert(clientSrc.includes('"Play description"') && clientSrc.includes('"Stop"'), "playback controls carry the short labels");
  assert(clientSrc.includes("this device's own voice"), "the playback explanation names the device's own voice before the controls");
  assert(clientSrc.includes("not a Meta model and not a recorded narration"), "and states plainly what the voice is not");
  assert(clientSrc.includes("Playback is not available in this browser"), "the no-synthesis path is a sentence, not a dead button");
  assert(clientSrc.includes("stopDescriptionPlayback"), "playback stops when the take's unit is rebuilt");
  ok("described audio playback: device-voice wiring, honest labelling, and the no-synthesis path are in the client");

  console.log(`\n${passed} test groups passed.`);
}

main().catch((err) => {
  console.error("TEST FAILURE:", err.message);
  process.exit(1);
});
