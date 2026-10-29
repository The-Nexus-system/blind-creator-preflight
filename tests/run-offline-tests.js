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
//
// The 'whenLive' assertions in expected-verdicts.json run later, against
// the live pipeline, once the funding switch is on and video media exists.

const assert = require("node:assert");
const fs = require("fs");
const path = require("path");

const { parseSemanticReply, runSemanticChecks } = require("../server/semantic");
const { measureImage } = require("../server/measure");
const { buildProofCopy, draftAltText, readiness } = require("../server/copy");
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
  const p4after = await measureImage(p4fixed.buffer, p4fixed.groundTruth);
  assert.strictEqual(p4after.cropSafety.verdict, "pass", "after the reframe, the measured crop verdict flips to pass");
  assert(p4fixed.changes.length >= 2, "the repair describes what changed in measurable terms");
  ok("ST-P4: crop repair is offered, performed, and the re-check passes");

  const p2buf = fs.readFileSync(path.join(mediaDir, "ST-P2.png"));
  const p2gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P2.json"), "utf8"));
  const p2m = await measureImage(p2buf, p2gt);
  assert(availableRepairs(p2m, p2gt).some((r) => r.id === "reframe-margin"));
  const p2fixed = await applyRepair(p2buf, p2gt, "reframe-margin", p2m);
  const p2after = await measureImage(p2fixed.buffer, p2fixed.groundTruth);
  assert.strictEqual(p2after.framing.verdict, "pass", "after the reframe, the measured framing verdict flips to pass");
  ok("ST-P2: framing repair is offered, performed, and the re-check passes");

  const darkBuf = await applyGain(fs.readFileSync(path.join(mediaDir, "ST-P1.png")), 0.12);
  const p1gt = JSON.parse(fs.readFileSync(path.join(mediaDir, "ST-P1.json"), "utf8"));
  const darkM = await measureImage(darkBuf, p1gt);
  assert.strictEqual(darkM.quality.verdict, "fix", "a darkened take fails quality");
  assert(availableRepairs(darkM, p1gt).some((r) => r.id === "brightness-auto"));
  const brightFixed = await applyRepair(darkBuf, p1gt, "brightness-auto", darkM);
  const brightAfter = await measureImage(brightFixed.buffer, brightFixed.groundTruth);
  assert.strictEqual(brightAfter.quality.verdict, "pass", "after the brightness repair, quality passes");
  ok("brightness repair rescues a darkened take, measured end to end");

  console.log(`\n${passed} test groups passed.`);
}

main().catch((err) => {
  console.error("TEST FAILURE:", err.message);
  process.exit(1);
});
