"use strict";

// Pre-Flight client logic.
//
// Everything the creator hears or reads is plain text. A check's meaning is
// always carried by its verdict word (pass, fix, uncertain) — never by
// colour, icon, or position alone.

const takeListEl = document.getElementById("take-list");
const resultsEl = document.getElementById("results");
const composerStatusEl = document.getElementById("composer-status");

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
    const button = el(
      "button",
      `${take.id}: ${take.title} (${take.kind}). Run the pre-flight check.`
    );
    button.type = "button";
    button.addEventListener("click", () => runCheck(take));
    li.appendChild(button);
    const intent = el("p", `Creator's intent: ${take.intent}`);
    li.appendChild(intent);
    takeListEl.appendChild(li);
  }
}

async function runCheck(take) {
  composerStatusEl.textContent = `Checking ${take.id}: ${take.title}.`;
  resultsEl.replaceChildren(el("p", "Running the six checks…"));
  const res = await fetch(`/api/takes/${take.id}/checks`);
  const data = await res.json();

  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", `${data.take.id}: ${data.take.title}`));
  frag.appendChild(
    el(
      "p",
      data.source === "live"
        ? "Every verdict below was measured from the take, judged by the model check, or determined by the take itself — each one says which."
        : "Each verdict says how it was reached. Where a model check has not run, the verdict is uncertain and says why — never a guess."
    )
  );

  const SOURCE_WORDS = {
    measured: "measured",
    model: "model check",
    determined: "from the take itself",
    "model-off": "model check not run",
    "model-error": "model check failed",
    "model-unreadable": "model reply unreadable",
  };
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
  loadCopy(take, data);
}

// --- Proof copy, alt text, approval, readiness ---------------------------
// The creator's side of the loop. The working session lives here in the
// client; the readiness RULE lives on the server (one implementation,
// tested once) and is asked fresh whenever the creator's state changes.

const copyAreaEl = document.getElementById("copy-area");
let session = null; // { takeId, warningAcknowledged, altTextApproved }

async function refreshReadiness() {
  if (!session) return;
  const res = await fetch(`/api/takes/${session.takeId}/readiness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
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
  session = { takeId: take.id, warningAcknowledged: false, altTextApproved: false };
  copyAreaEl.replaceChildren(el("p", "Building your proof copy and alt text draft…"));
  const res = await fetch(`/api/takes/${take.id}/copy`);
  const data = await res.json();

  const frag = document.createDocumentFragment();

  frag.appendChild(el("h3", "Proof copy — yours alone, never posted"));
  const pre = el("pre");
  pre.textContent = data.proofCopy;
  frag.appendChild(pre);
  const blob = new Blob([data.proofCopy], { type: "text/plain; charset=utf-8" });
  const download = el("a", "Download the proof copy as a plain text file (braille-ready).");
  download.href = URL.createObjectURL(blob);
  download.download = `proof-copy-${take.id}.txt`;
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
  editor.addEventListener("input", () => {
    // Any edit un-approves: approval must always be of the current words.
    if (session.altTextApproved) {
      session.altTextApproved = false;
      approveBtn.textContent = "Approve this alt text";
      approveState.textContent = "Edited since approval — approval cleared.";
      refreshReadiness();
    }
  });
  frag.appendChild(editor);
  const approveBtn = el("button", "Approve this alt text");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet.");
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
