"use strict";

// Pre-Flight client logic.
//
// Everything the creator hears or reads is plain text. A check's meaning is
// always carried by its verdict word (pass, fix, uncertain) and its source
// word — never by colour, icon, or position alone.
//
// The working session (which take, which repaired variant, what the
// creator has acknowledged and approved) lives here in the client. The
// readiness RULE lives on the server and is asked fresh whenever the
// creator's state changes.

const takeListEl = document.getElementById("take-list");
const resultsEl = document.getElementById("results");
const repairsEl = document.getElementById("repairs-area");
const copyAreaEl = document.getElementById("copy-area");
const composerStatusEl = document.getElementById("composer-status");

const SOURCE_WORDS = {
  measured: "measured",
  model: "model check",
  determined: "from the take itself",
  "model-off": "model check not run",
  "model-error": "model check failed",
  "model-unreadable": "model reply unreadable",
};

let session = null; // { take, variant, warningAcknowledged, altTextApproved }

function el(tag, text) {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  return node;
}

async function loadTakes() {
  const res = await fetch("/api/takes");
  const data = await res.json();
  takeListEl.replaceChildren();
  for (const take of data.takes) {
    const li = el("li");
    const button = el("button", `${take.id}: ${take.title} (${take.kind}). Run the pre-flight check.`);
    button.type = "button";
    button.addEventListener("click", () => runCheck(take));
    li.appendChild(button);
    li.appendChild(el("p", `Creator's intent: ${take.intent}`));
    takeListEl.appendChild(li);
  }
}

function renderResults(take, data) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", `${data.take.id}: ${data.take.title}${data.variant ? " (repaired)" : ""}`));
  frag.appendChild(
    el(
      "p",
      data.source === "live"
        ? "Every verdict below was measured from the take, judged by the model check, or determined by the take itself — each one says which."
        : "Each verdict says how it was reached. Where a model check has not run, the verdict is uncertain and says why — never a guess."
    )
  );
  const list = el("ul");
  for (const check of data.checks) {
    const sourceWord = SOURCE_WORDS[check.source] || check.source;
    list.appendChild(el("li", `${check.name}: ${check.verdict} (${sourceWord}) — ${check.detail}`));
  }
  frag.appendChild(list);

  if (data.privacyWarning) {
    const warnSource =
      data.privacyWarningSource === "model"
        ? "found by the model check"
        : data.privacyWarningSource === "designed"
          ? "from this take's designed state; the model check has not run yet"
          : "source unconfirmed";
    frag.appendChild(el("h3", `Warning — ${data.privacyWarning.name}`));
    frag.appendChild(el("p", data.privacyWarning.detail));
    frag.appendChild(el("p", `Warning source: ${warnSource}.`));
  }

  const fixes = data.checks.filter((c) => c.verdict === "fix").length;
  const summary = data.privacyWarning
    ? "Not ready to post: a private-information warning needs your decision first."
    : fixes > 0
      ? `Not ready to post yet: ${fixes} check${fixes === 1 ? "" : "s"} to fix.`
      : "Ready to post: every check passes.";
  frag.appendChild(el("p", summary));
  composerStatusEl.textContent = summary;
  resultsEl.replaceChildren(frag);
}

async function runCheck(take) {
  session = { take, variant: null, warningAcknowledged: false, altTextApproved: false };
  composerStatusEl.textContent = `Checking ${take.id}: ${take.title}.`;
  resultsEl.replaceChildren(el("p", "Running the six checks…"));
  repairsEl.replaceChildren();
  const res = await fetch(`/api/takes/${take.id}/checks`);
  const data = await res.json();
  renderResults(take, data);
  loadRepairs(take);
  loadCopy(take, data);
}

// --- Repairs ---------------------------------------------------------------

async function loadRepairs(take) {
  const res = await fetch(`/api/takes/${take.id}/repairs`);
  const data = await res.json();
  repairsEl.replaceChildren();
  if (!data.repairs.length) {
    repairsEl.appendChild(el("p", "No deterministic repairs are offered for this take's current verdicts."));
    return;
  }
  repairsEl.appendChild(el("p", "Repairs are performed on a copy — the original take is never changed, and you can undo at any time."));
  const list = el("ul");
  for (const repair of data.repairs) {
    const li = el("li");
    const button = el("button", repair.name);
    button.type = "button";
    button.addEventListener("click", () => applyRepair(take, repair));
    li.appendChild(button);
    list.appendChild(li);
  }
  repairsEl.appendChild(list);
}

async function applyRepair(take, repair) {
  repairsEl.replaceChildren(el("p", `Performing the repair: ${repair.name}…`));
  const res = await fetch(`/api/takes/${take.id}/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repairId: repair.id }),
  });
  const data = await res.json();
  if (data.error) {
    repairsEl.replaceChildren(el("p", `The repair could not be performed: ${data.error}`));
    return;
  }
  session.variant = data.variantId;
  session.warningAcknowledged = false;
  session.altTextApproved = false;

  repairsEl.replaceChildren();
  repairsEl.appendChild(el("h3", "What changed"));
  const changes = el("ul");
  for (const change of data.changes) changes.appendChild(el("li", change));
  repairsEl.appendChild(changes);
  repairsEl.appendChild(el("p", "The checks have run again on the repaired take — see the results above."));
  const undo = el("button", "Undo — return to the original take");
  undo.type = "button";
  undo.addEventListener("click", () => runCheck(take));
  repairsEl.appendChild(undo);

  renderResults(take, data.result);
  loadCopy(take, data.result);
}

// --- Proof copy, alt text, approval, readiness -----------------------------

async function refreshReadiness() {
  if (!session) return;
  const res = await fetch(`/api/takes/${session.take.id}/readiness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: session.variant,
      warningAcknowledged: session.warningAcknowledged,
      altTextApproved: session.altTextApproved,
    }),
  });
  const r = await res.json();
  const region = document.getElementById("readiness-region");
  if (!region) return;
  region.replaceChildren();
  region.appendChild(el("h3", "Ready to post"));
  if (r.ready) {
    region.appendChild(el("p", "Ready. Every check is settled, and you have approved the words."));
  } else {
    region.appendChild(el("p", "Not ready yet:"));
    const list = el("ul");
    for (const reason of r.reasons) list.appendChild(el("li", reason));
    region.appendChild(list);
  }
}

async function loadCopy(take, checkData) {
  copyAreaEl.replaceChildren(el("p", "Building your proof copy and alt text draft…"));
  const variantQuery = checkData.variant ? `?variant=${encodeURIComponent(checkData.variant)}` : "";
  const res = await fetch(`/api/takes/${take.id}/copy${variantQuery}`);
  const data = await res.json();

  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "Proof copy — yours alone, never posted"));
  const pre = el("pre");
  pre.textContent = data.proofCopy;
  frag.appendChild(pre);
  const blob = new Blob([data.proofCopy], { type: "text/plain; charset=utf-8" });
  const download = el("a", "Download the proof copy as a plain text file (braille-ready).");
  download.href = URL.createObjectURL(blob);
  download.download = `proof-copy-${take.id}${checkData.variant ? "-repaired" : ""}.txt`;
  frag.appendChild(download);

  frag.appendChild(el("h3", "Alt text for the post"));
  frag.appendChild(el("p", data.altText.note));
  const label = el("label", "Alt text — edit it into your own words:");
  label.htmlFor = "alt-text-editor";
  frag.appendChild(label);
  const editor = document.createElement("textarea");
  editor.id = "alt-text-editor";
  editor.rows = 4;
  editor.cols = 60;
  editor.value = data.altText.text;
  const approveBtn = el("button", "Approve this alt text");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet.");
  editor.addEventListener("input", () => {
    // Any edit un-approves: approval must always cover the current words.
    if (session.altTextApproved) {
      session.altTextApproved = false;
      approveBtn.textContent = "Approve this alt text";
      approveState.textContent = "Edited since approval — approval cleared.";
      refreshReadiness();
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    session.altTextApproved = true;
    approveBtn.textContent = "Alt text approved";
    approveState.textContent = "You approved the alt text exactly as it stands.";
    refreshReadiness();
  });
  frag.appendChild(approveBtn);
  frag.appendChild(approveState);

  if (checkData.privacyWarning) {
    frag.appendChild(el("h3", "Before this can be ready — the warning"));
    const ackLabel = el(
      "label",
      `I understand this warning and what posting would make public: ${checkData.privacyWarning.name}`
    );
    const ack = document.createElement("input");
    ack.type = "checkbox";
    ack.addEventListener("change", () => {
      session.warningAcknowledged = ack.checked;
      refreshReadiness();
    });
    ackLabel.prepend(ack);
    frag.appendChild(ackLabel);
  }

  const region = el("div");
  region.id = "readiness-region";
  region.setAttribute("aria-live", "polite");
  frag.appendChild(region);

  copyAreaEl.replaceChildren(frag);
  refreshReadiness();
}

loadTakes().catch(() => {
  resultsEl.replaceChildren(
    el("p", "The take list could not be loaded. The backend may not be running.")
  );
});
