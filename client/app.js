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
      data.source === "stub"
        ? "These verdicts are the take's designed state, standing in for the measured checks while the pipeline is built."
        : "These verdicts were measured by the checks pipeline."
    )
  );

  const list = el("ul");
  for (const check of data.checks) {
    list.appendChild(el("li", `${check.name}: ${check.verdict} — ${check.detail}`));
  }
  frag.appendChild(list);

  if (data.privacyWarning) {
    frag.appendChild(el("h3", `Warning — ${data.privacyWarning.name}`));
    frag.appendChild(el("p", data.privacyWarning.detail));
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
