"use strict";

// Proof copy, alt-text drafts, and the readiness rule.
//
// Proof copy is the creator's private, detailed account of their take —
// assembled DETERMINISTICALLY from the check results, word for word from
// what the pipelines actually reported (the quote-checked pattern: a claim
// in the copy is a claim a check made, with its source attached). No model
// prose is invented here. It is written to be spoken by a screen reader
// and read on a braille display: plain sentences, no tables, no symbols
// carrying meaning.
//
// Alt text is drafted from the take's facts plus the creator's stated
// intent. While the model pipeline is off, the draft is assembled from the
// intent and the measured facts and labelled as exactly that — a starting
// draft for the creator to edit into their own words. When the model runs,
// its draft takes the same slot, labelled "model". Either way: nothing is
// final until the creator edits and approves it.
//
// Readiness is one rule, implemented once, here: a take is ready to post
// when (1) every check is settled — no "fix" verdicts outstanding, and no
// verdict still waiting on a check that has not run; (2) a firing privacy
// warning has been explicitly acknowledged by the creator; and (3) the
// alt text has been approved. Approval of words never substitutes for
// acknowledgement of a warning.

function buildProofCopy(take, result) {
  const lines = [];
  lines.push(`Proof copy for ${take.id}: ${take.title} (${take.kind}).`);
  lines.push(`Your stated intent: ${take.intent}`);
  lines.push("");
  lines.push("What the checks found:");
  for (const c of result.checks) {
    lines.push(`${c.name}: ${c.verdict}. ${c.detail} (Source: ${c.source}.)`);
  }
  if (result.privacyWarning) {
    lines.push("");
    lines.push(`Warning. ${result.privacyWarning.name}`);
    lines.push(result.privacyWarning.detail);
    lines.push(`(Warning source: ${result.privacyWarningSource}.)`);
  }
  lines.push("");
  lines.push(
    "This proof copy is yours alone. It is not posted, attached, or shared anywhere."
  );
  return lines.join("\n");
}

function draftAltText(take, result) {
  // Assembled draft: intent first (the creator's own words lead), then the
  // measured facts that are safe to state. Model drafting replaces the
  // assembly when live; the slot, label, and approval flow are the same.
  const facts = [];
  const byId = Object.fromEntries(result.checks.map((c) => [c.id, c]));
  if (take.kind === "photo") facts.push("A photo.");
  if (take.kind === "video") facts.push("A short video.");
  if (byId.framing && byId.framing.source === "measured" && byId.framing.verdict === "pass") {
    facts.push("The subject is framed whole, with margin on every side.");
  }
  const source = "assembled";
  return {
    text: `${take.intent} ${facts.join(" ")}`.trim(),
    source,
    note:
      "Starting draft assembled from your intent and the measured facts — the model drafter is not wired into this slot yet. Edit it into your own words, then approve it.",
  };
}

function readiness(result, { warningAcknowledged, altTextApproved }) {
  const reasons = [];
  const fixes = result.checks.filter((c) => c.verdict === "fix");
  if (fixes.length) {
    reasons.push(
      `${fixes.length} check${fixes.length === 1 ? "" : "s"} still ${fixes.length === 1 ? "says" : "say"} fix: ${fixes.map((c) => c.name).join(", ")}.`
    );
  }
  const pending = result.checks.filter((c) =>
    ["model-off", "model-error", "model-unreadable", "pending"].includes(c.source)
  );
  if (pending.length) {
    reasons.push(
      `${pending.length} check${pending.length === 1 ? "" : "s"} (${pending.map((c) => c.name).join(", ")}) ha${pending.length === 1 ? "s" : "ve"} not run yet, so ${pending.length === 1 ? "its" : "their"} verdict is only "uncertain".`
    );
  }
  if (result.privacyWarning && !warningAcknowledged) {
    reasons.push("A private-information warning is showing and has not been acknowledged.");
  }
  if (!altTextApproved) {
    reasons.push("The alt text has not been approved yet.");
  }
  return { ready: reasons.length === 0, reasons };
}

module.exports = { buildProofCopy, draftAltText, readiness };
