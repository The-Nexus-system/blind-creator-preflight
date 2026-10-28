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
}

loadTakes().catch(() => {
  resultsEl.replaceChildren(
    el("p", "The take list could not be loaded. The backend may not be running.")
  );
});
