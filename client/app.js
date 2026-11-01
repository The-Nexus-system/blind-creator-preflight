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
const shareAreaEl = document.getElementById("share-area");
const composerStatusEl = document.getElementById("composer-status");

const SOURCE_WORDS = {
  measured: "measured",
  sam: "measured by SAM 3.1",
  judgement: "measured by model judgement",
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

let allTakes = [];

async function loadTakes() {
  const res = await fetch("/api/takes");
  const data = await res.json();
  allTakes = data.takes;
  takeListEl.replaceChildren();
  for (const take of data.takes) {
    const li = el("li");
    li.appendChild(el("p", `${take.id}: ${take.title} (${take.kind}).`));
    li.appendChild(el("p", `Creator's intent: ${take.intent}`));
    const button = el("button", `Check ${take.id}`);
    button.type = "button";
    button.addEventListener("click", () => runCheck(take));
    li.appendChild(button);
    takeListEl.appendChild(li);
  }
}

// What the creator can do about a showing warning, stated under the
// warning itself: when the redaction repair is offered for this
// variant, one line points at it; when the warning fires but no
// region could be located, one plain sentence says the app cannot
// take the information off automatically. When a region is known but
// the redaction is already in the chain, neither line is added — the
// warning still showing is itself the information.
function appendWarningActionLines(frag, data) {
  if (!data.privacyWarning) return;
  if (data.privacyRedactionOffered) {
    frag.appendChild(el("p", "A repair below can take the private information off this photo."));
  } else if (!data.privacyRegion) {
    frag.appendChild(
      el(
        "p",
        "The app can tell private information is present but cannot locate it precisely enough to take it off automatically."
      )
    );
  }
}

function renderResults(take, data) {
  if (session && session.take === take) session.lastResult = data;
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
    appendWarningActionLines(frag, data);
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
  stopDescriptionPlayback();
  session = { take, variant: null, warningAcknowledged: false, altTextApproved: false, describedApproved: false };
  composerStatusEl.textContent = `Checking ${take.id}: ${take.title}.`;
  resultsEl.replaceChildren(el("p", "Running the six checks…"));
  repairsEl.replaceChildren();
  describedAreaEl.replaceChildren();
  shareAreaEl.replaceChildren();
  const res = await fetch(`/api/takes/${take.id}/checks`);
  const data = await res.json();
  renderResults(take, data);
  loadRepairs(take);
  loadCopy(take, data);
}

// --- Repairs ---------------------------------------------------------------

// One repairs list, rendered the standing way: for each repair, the
// explanation as text first, then a button carrying the short action
// name only. Repair names arrive as "Short name: explanation".
function appendRepairButtons(container, take, repairs) {
  const list = el("ul");
  for (const repair of repairs) {
    const li = el("li");
    const splitAt = repair.name.indexOf(": ");
    const shortName = splitAt > 0 ? repair.name.slice(0, splitAt) : repair.name;
    if (splitAt > 0) {
      const explanation = repair.name.slice(splitAt + 2);
      li.appendChild(
        el("p", explanation.charAt(0).toUpperCase() + explanation.slice(1) + (explanation.endsWith(".") ? "" : "."))
      );
    }
    const button = el("button", shortName);
    button.type = "button";
    button.addEventListener("click", () => applyRepair(take, repair));
    li.appendChild(button);
    list.appendChild(li);
  }
  container.appendChild(list);
}

async function loadRepairs(take) {
  const variantQuery =
    session && session.variant ? `?variant=${encodeURIComponent(session.variant)}` : "";
  const res = await fetch(`/api/takes/${take.id}/repairs${variantQuery}`);
  const data = await res.json();
  repairsEl.replaceChildren();
  if (!data.repairs.length) {
    repairsEl.appendChild(el("p", "No deterministic repairs are offered for this take's current verdicts."));
    return;
  }
  repairsEl.appendChild(el("p", "Repairs are performed on a copy — the original take is never changed, and you can undo at any time."));
  appendRepairButtons(repairsEl, take, data.repairs);
  appendUncoveredFixNotes(repairsEl, data.repairs);
}

// A check can say fix without a deterministic repair existing for it
// (the repairs are computed from the take's recorded measurement, so
// a fix that rests on a model estimate may have none). Say so plainly
// beside the offers rather than leaving the fix unexplained — the
// same honesty the upload flow applies beside its verdicts.
function appendUncoveredFixNotes(container, repairs) {
  const result = session && session.lastResult;
  if (!result) return;
  const offeredFor = new Set((repairs || []).map((r) => r.fixesCheck));
  for (const check of result.checks) {
    if (check.verdict === "fix" && !offeredFor.has(check.id)) {
      container.appendChild(el("p", `No deterministic repair is offered for the ${check.name} check.`));
    }
  }
}

async function applyRepair(take, repair) {
  repairsEl.replaceChildren(el("p", `Performing the repair: ${repair.name}…`));
  const res = await fetch(`/api/takes/${take.id}/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      repairId: repair.id,
      baseVariant: session && session.variant ? session.variant : undefined,
    }),
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
  if (data.outcome) {
    repairsEl.appendChild(
      el(
        "p",
        data.outcome.worse
          ? `Measured outcome: ${data.outcome.checkName} went from ${data.outcome.before} to ${data.outcome.after} — the repair did not improve this take, and undo is right there.`
          : `Measured outcome: ${data.outcome.checkName} went from ${data.outcome.before} to ${data.outcome.after}.`
      )
    );
  }
  repairsEl.appendChild(el("p", "The checks have run again on the repaired take — see the results above."));
  repairsEl.appendChild(
    el("p", "Undoing returns to the original take; the repaired copy is set aside and nothing is kept.")
  );
  const undo = el("button", "Undo repair");
  undo.type = "button";
  undo.addEventListener("click", () => runCheck(take));
  repairsEl.appendChild(undo);

  // Repairs stack: whatever the repaired take's new verdicts offer is
  // listed here too, performed on the repaired take when chosen — the
  // same chain the repair endpoint applies server-side.
  const moreRes = await fetch(
    `/api/takes/${take.id}/repairs?variant=${encodeURIComponent(data.variantId)}`
  );
  const more = await moreRes.json();
  if (more.repairs && more.repairs.length) {
    repairsEl.appendChild(el("h3", "Repairs for the repaired take"));
    repairsEl.appendChild(
      el("p", "These are performed on the repaired take you are looking at now, on top of the repair above.")
    );
    appendRepairButtons(repairsEl, take, more.repairs);
  }
  renderResults(take, data.result);
  appendUncoveredFixNotes(repairsEl, more.repairs || []);
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
  const approveBtn = el("button", "Approve alt text");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet.");
  editor.addEventListener("input", () => {
    // Any edit un-approves: approval must always cover the current words.
    // The button label never changes — the state lives in approveState.
    if (session.altTextApproved) {
      session.altTextApproved = false;
      approveState.textContent = "Edited since approval — approval cleared.";
      refreshReadiness();
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    session.altTextApproved = true;
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
  loadPublicDescription(take, checkData);
  loadDescribedAudio(take, checkData);
  renderShareArea(take);
}

// --- Public description (Tier 2) -------------------------------------------
// The audience-facing sibling of the proof copy: same verified facts,
// written for the people who will see the post. Optional — readiness never
// depends on it — and, like the alt text, used only with the creator's
// approval of its exact current words.

const publicAreaEl = document.getElementById("public-area");

async function loadPublicDescription(take, checkData) {
  if (session) session.publicApproved = false;
  publicAreaEl.replaceChildren(el("p", "Building the public description…"));
  const variantQuery = checkData.variant ? `?variant=${encodeURIComponent(checkData.variant)}` : "";
  const res = await fetch(`/api/takes/${take.id}/public-description${variantQuery}`);
  const data = await res.json();
  const pd = data.publicDescription;

  const frag = document.createDocumentFragment();
  if (!pd.available) {
    frag.appendChild(el("p", pd.reason));
    publicAreaEl.replaceChildren(frag);
    return;
  }
  frag.appendChild(el("p", pd.note));
  const label = el("label", "Public description — edit it into your own words:");
  label.htmlFor = "public-editor";
  frag.appendChild(label);
  const editor = document.createElement("textarea");
  editor.id = "public-editor";
  editor.rows = 4;
  editor.cols = 60;
  editor.value = pd.text;
  const approveBtn = el("button", "Approve public description");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet. It will not be used anywhere until you approve it.");
  editor.addEventListener("input", () => {
    if (session && session.publicApproved) {
      session.publicApproved = false;
      approveState.textContent = "Edited since approval — approval cleared.";
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    if (session) session.publicApproved = true;
    approveState.textContent = "You approved this description exactly as it stands. It is ready to paste into your post's caption or first comment, or to carry to another platform.";
  });
  frag.appendChild(approveBtn);
  frag.appendChild(approveState);
  const blob = new Blob([pd.text], { type: "text/plain; charset=utf-8" });
  const download = el("a", "Download the description as a plain text file, to carry to another platform.");
  download.href = URL.createObjectURL(blob);
  download.download = `public-description-${take.id}.txt`;
  frag.appendChild(download);
  publicAreaEl.replaceChildren(frag);
}

// --- Described audio (video takes) -----------------------------------------
// The described-audio draft script for a video take, inside the take's
// own unit: the timed segments the server drafted from the take's
// recorded timeline, then the script as editable text with the same
// draft/approve rule as the alt text — approval covers the exact
// current words, and any edit clears it. The script can be taken away
// as a plain text file: the download is built from the editor's
// current words when pressed, so what is approved is what is carried
// away. For a photo take there is no timeline to narrate and this
// area stays empty; the server says why when a video's script cannot
// be drafted, and that reason is shown plainly.

const describedAreaEl = document.getElementById("described-area");

// Stops any device-voice playback of the description. Called whenever
// the take's unit is rebuilt — a new check, a repair, a different
// take — so the voice never keeps reading a script that has left the
// page.
function stopDescriptionPlayback() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
}

function formatSeconds(s) {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${String(sec).padStart(2, "0")}`;
}

async function loadDescribedAudio(take, checkData) {
  stopDescriptionPlayback();
  if (session) session.describedApproved = false;
  if (take.kind !== "video") {
    describedAreaEl.replaceChildren();
    return;
  }
  describedAreaEl.replaceChildren(el("p", "Drafting the described-audio script…"));
  const variantQuery = checkData.variant ? `?variant=${encodeURIComponent(checkData.variant)}` : "";
  const res = await fetch(`/api/takes/${take.id}/described-audio${variantQuery}`);
  const data = await res.json();
  const da = data.describedAudio;

  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "Described audio — draft script"));
  if (!da || !da.available) {
    frag.appendChild(
      el("p", da && da.reason ? da.reason : "No described-audio script can be drafted for this take.")
    );
    describedAreaEl.replaceChildren(frag);
    return;
  }
  frag.appendChild(el("p", da.note));
  frag.appendChild(
    el(
      "p",
      da.source === "model"
        ? "Draft source: drafted by the model check from the take's recorded timeline."
        : "Draft source: assembled from the take's recorded facts."
    )
  );
  const list = el("ul");
  for (const seg of da.segments) {
    list.appendChild(el("li", `${formatSeconds(seg.start)} to ${formatSeconds(seg.end)}: ${seg.text}`));
  }
  frag.appendChild(list);

  const label = el("label", "Described-audio script — edit it into your own words:");
  label.htmlFor = "described-editor";
  frag.appendChild(label);
  const editor = document.createElement("textarea");
  editor.id = "described-editor";
  editor.rows = 6;
  editor.cols = 60;
  editor.value = da.segments
    .map((s) => `${formatSeconds(s.start)} to ${formatSeconds(s.end)}: ${s.text}`)
    .join("\n");
  const approveBtn = el("button", "Approve described audio");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet. It stays a draft until you approve it.");
  editor.addEventListener("input", () => {
    if (session && session.describedApproved) {
      session.describedApproved = false;
      approveState.textContent = "Edited since approval — approval cleared.";
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    if (session) session.describedApproved = true;
    approveState.textContent = "You approved this script exactly as it stands.";
  });
  frag.appendChild(approveBtn);
  frag.appendChild(approveState);

  // Playback of the script with the DEVICE'S OWN voice (Nexus
  // decision, Nov 1, 2026): the browser's speech synthesis reads the
  // script's current words — the editor's text, timing labels
  // stripped — in order. It is not a Meta model and not a recorded
  // narration, and the explanation before the controls says exactly
  // that. Where the browser has no speech synthesis there are no
  // buttons at all — a plain sentence instead, never a dead control.
  if ("speechSynthesis" in window) {
    frag.appendChild(
      el(
        "p",
        "You can hear the script read aloud by this device's own voice — the browser's built-in speech, not a Meta model and not a recorded narration. It reads the words exactly as the editor above holds them now."
      )
    );
    const playBtn = el("button", "Play description");
    playBtn.type = "button";
    const stopBtn = el("button", "Stop");
    stopBtn.type = "button";
    const playState = el("p", "Not playing.");
    playBtn.addEventListener("click", () => {
      window.speechSynthesis.cancel();
      const lines = editor.value
        .split("\n")
        .map((line) => line.replace(/^\s*\d+:\d{2}(?:\.\d+)?\s+to\s+\d+:\d{2}(?:\.\d+)?\s*:\s*/, "").trim())
        .filter((line) => line.length > 0);
      if (!lines.length) {
        playState.textContent = "There is no script text to play.";
        return;
      }
      lines.forEach((line, i) => {
        const utterance = new SpeechSynthesisUtterance(line);
        if (i === lines.length - 1) {
          utterance.onend = () => {
            playState.textContent = "Finished playing the description.";
          };
          utterance.onerror = () => {
            playState.textContent = "Playback stopped.";
          };
        }
        window.speechSynthesis.speak(utterance);
      });
      playState.textContent = "Playing the description with this device's voice.";
    });
    stopBtn.addEventListener("click", () => {
      window.speechSynthesis.cancel();
      playState.textContent = "Playback stopped.";
    });
    frag.appendChild(playBtn);
    frag.appendChild(stopBtn);
    frag.appendChild(playState);
  } else {
    frag.appendChild(
      el("p", "Playback is not available in this browser: it has no built-in speech voice to read the script aloud.")
    );
  }

  frag.appendChild(
    el("p", "Take the script away as a plain text file, ready to record or hand to a voice. The file holds the words exactly as the editor holds them when you press the button.")
  );
  const downloadBtn = el("button", "Download the script as a text file");
  downloadBtn.type = "button";
  downloadBtn.addEventListener("click", () => {
    const blob = new Blob([editor.value], { type: "text/plain; charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `described-audio-${take.id}${checkData.variant ? "-repaired" : ""}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  frag.appendChild(downloadBtn);
  describedAreaEl.replaceChildren(frag);
}

// --- Share -----------------------------------------------------------------
// The last step of each per-photo flow. The explanation stands before
// the button, and the button's label is just "Share". Sharing goes
// through the Web Share API: the current picture as a file when the
// platform accepts files (navigator.canShare decides), the words
// alone when it does not. Where this browser has no Web Share API at
// all there is no button — a plain statement says so instead, so the
// creator is never handed a control that does nothing.

async function doShare(getParts) {
  try {
    const { file, text } = await getParts();
    let data = text ? { text } : {};
    if (file && navigator.canShare && navigator.canShare({ files: [file], ...(text ? { text } : {}) })) {
      data = { files: [file], ...(text ? { text } : {}) };
    }
    if (!data.files && !data.text) return;
    await navigator.share(data);
  } catch {
    // The creator cancelled the share sheet, or the share failed;
    // either way there is nothing they need to hear about it here.
  }
}

function renderShareBlock(container, { explanation, noShareText, getParts }) {
  container.replaceChildren();
  if (!navigator.share) {
    container.appendChild(el("p", noShareText));
    return;
  }
  container.appendChild(el("p", explanation));
  const button = el("button", "Share");
  button.type = "button";
  button.addEventListener("click", () => doShare(getParts));
  container.appendChild(button);
}

// A seeded take shares its current still: the repaired variant's
// image when repairs have been applied, otherwise the original (for
// a video take, its posted frame) — fetched from the read-only media
// route — with the alt text above as the words: the approved text
// when it stands approved, the current draft when it does not; both
// are simply what the editor holds when Share is pressed.
async function seededShareParts(take) {
  const editor = document.getElementById("alt-text-editor");
  const text = editor ? editor.value : `${take.id}: ${take.title}`;
  let file = null;
  try {
    const variantQuery =
      session && session.variant ? `?variant=${encodeURIComponent(session.variant)}` : "";
    const res = await fetch(`/api/takes/${take.id}/media${variantQuery}`);
    if (res.ok) {
      const blob = await res.blob();
      file = new File([blob], `${take.id}${session && session.variant ? "-repaired" : ""}.png`, {
        type: "image/png",
      });
    }
  } catch {
    file = null;
  }
  return { file, text };
}

function renderShareArea(take) {
  renderShareBlock(shareAreaEl, {
    explanation:
      "Share this take's current picture — the repaired version if you have repaired it, otherwise the original — together with the alt text above, to another app.",
    noShareText:
      "This browser cannot share from a web page, so there is no share button here. The proof copy above is ready to copy and paste instead.",
    getParts: () => seededShareParts(take),
  });
}

loadTakes().catch(() => {
  resultsEl.replaceChildren(
    el("p", "The take list could not be loaded. The backend may not be running.")
  );
});

// --- Library Sweep (simulated slice) ---------------------------------------
// The sweep data comes from the server (the seeded mini-library and its
// pinned sort). The working state — what the creator has culled and what
// they have approved to share — lives here in the client session, like
// every other working state in Pre-Flight. Culling in this slice deletes
// nothing anywhere; the confirmation text says so every time.

const libraryEl = document.getElementById("library-area");
let sweepData = null;
const culledIds = new Set();
const approvedShareIds = new Set();
let armedCullCategory = null;

async function loadLibrary() {
  const res = await fetch("/api/library/sweep");
  sweepData = await res.json();
  renderLibrary();
}

function renderLibrary() {
  if (!sweepData) return;
  const frag = document.createDocumentFragment();
  frag.appendChild(el("p", sweepData.note));
  frag.appendChild(
    el("p", `Your library, swept: ${sweepData.totalItems} items, ${sweepData.totalFiles} files in total.`)
  );

  frag.appendChild(el("h4", "Categories"));
  const catList = el("ul");
  for (const cat of sweepData.categories) {
    const remaining = cat.itemIds.filter((id) => !culledIds.has(id));
    const remainingFiles = remaining.reduce(
      (n, id) => n + (sweepData.items.find((i) => i.id === id) || { files: 0 }).files,
      0
    );
    const line = `${cat.name}: ${remaining.length} item${remaining.length === 1 ? "" : "s"} (${remainingFiles} files)${remaining.length < cat.itemIds.length ? ` — ${cat.itemIds.length - remaining.length} culled this session` : ""}.`;
    const li = el("li", line);
    if (remaining.length) {
      const cullBtn = el("button", `Cull ${cat.name}`);
      cullBtn.type = "button";
      cullBtn.addEventListener("click", () => {
        armedCullCategory = armedCullCategory === cat.name ? null : cat.name;
        renderLibrary();
      });
      li.appendChild(cullBtn);
      if (armedCullCategory === cat.name) {
        const flagged = remaining
          .map((id) => sweepData.items.find((i) => i.id === id))
          .filter((i) => i && i.privacyWarning);
        const confirmText =
          `Cull the ${cat.name} set — ${remaining.length} item${remaining.length === 1 ? "" : "s"} (${remaining.join(", ")})? ` +
          (flagged.length
            ? `This set contains a flagged item, named once more before you confirm: ${flagged.map((i) => `${i.id} — ${i.privacyWarning.name}`).join(" ")} `
            : "") +
          "This sweep is simulated: culling here deletes nothing from any real library.";
        li.appendChild(el("p", confirmText));
        const confirmBtn = el("button", "Confirm cull");
        confirmBtn.type = "button";
        confirmBtn.addEventListener("click", () => {
          for (const id of remaining) {
            culledIds.add(id);
            approvedShareIds.delete(id);
          }
          armedCullCategory = null;
          renderLibrary();
        });
        li.appendChild(confirmBtn);
      }
    }
    catList.appendChild(li);
  }
  frag.appendChild(catList);

  // The warning stands alone — never a line inside a category.
  for (const warning of sweepData.privacyWarnings) {
    if (culledIds.has(warning.itemId)) continue;
    frag.appendChild(el("h4", `Warning — ${warning.itemId}: ${warning.name}`));
    frag.appendChild(el("p", warning.detail));
  }

  frag.appendChild(el("h4", "Every item, in words"));
  const itemList = el("ul");
  for (const item of sweepData.items) {
    // A culled item leaves the sweep's results entirely — it is gone
    // from this list, from its category's counts, and from the
    // warnings; the footer line below names what was culled.
    if (culledIds.has(item.id)) continue;
    const state = approvedShareIds.has(item.id)
      ? "In your Approved to share set."
      : "Not culled, not approved.";
    const li = el(
      "li",
      `${item.id} (${item.category}${item.files > 1 ? `, ${item.files} files` : ""}): ${item.description} ${state}`
    );
    {
      const toggle = el(
        "button",
        approvedShareIds.has(item.id)
          ? `Remove ${item.id} from share set`
          : `Add ${item.id} to share set`
      );
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        if (approvedShareIds.has(item.id)) approvedShareIds.delete(item.id);
        else approvedShareIds.add(item.id);
        renderLibrary();
      });
      li.appendChild(toggle);
      if (item.takeId) {
        const send = el("button", `Check ${item.id}`);
        send.type = "button";
        send.addEventListener("click", () => {
          const take = allTakes.find((t) => t.id === item.takeId);
          if (take) runCheck(take);
        });
        li.appendChild(send);
      }
    }
    itemList.appendChild(li);
  }
  frag.appendChild(itemList);

  frag.appendChild(
    el(
      "p",
      approvedShareIds.size
        ? `Approved to share: ${approvedShareIds.size} item${approvedShareIds.size === 1 ? "" : "s"} — ${[...approvedShareIds].join(", ")}. In the full sweep, this set is what you would limit a social app to in your phone's per-app photo-access settings; Pre-Flight curates the set and guides the setting, and says plainly that it cannot change another app's permission for you.`
        : "Approved to share: empty. Add items above to build the set you would let a social app see."
    )
  );
  if (culledIds.size) {
    frag.appendChild(
      el("p", `Culled this session (simulated — nothing deleted): ${[...culledIds].join(", ")}.`)
    );
  }

  libraryEl.replaceChildren(frag);
}

loadLibrary().catch(() => {
  libraryEl.replaceChildren(el("p", "The sweep could not be loaded. The backend may not be running."));
});

// --- Check your own photo --------------------------------------------------
// The creator picks one photo from their own library or files — the
// phone's own permission and picker stand between the app and the
// library, and the app receives only the photo chosen. The browser
// decodes it with its EXIF orientation applied (HEIC included, where
// the browser can) and re-encodes it as PNG, so the server receives
// the format its pipeline already reads.
//
// iOS Safari refuses canvases over 16,777,216 total pixels — a 24 or
// 48 megapixel photo at native size fails, often silently (a blank
// canvas) — so the working size is capped at decode time, safely
// under that ceiling, and the draw down to it goes in halving steps
// rather than one large reduction. If the resulting PNG would still
// exceed the server's cap, the copy is scaled down further — longest
// side at most 3000 pixels, then smaller if the limit still requires
// it — and the server is told, so the result says a scaled copy was
// checked. The check opens a working session on the server (the
// seeded flow at parity: repairs, re-check, proof copy, share) over
// a copy kept only while the creator works with it; the results
// render with textContent only, like every result here.

const ownPhotoInput = document.getElementById("own-photo-input");
const ownPhotoStatusEl = document.getElementById("own-photo-status");
const ownPhotoResultsEl = document.getElementById("own-photo-results");
const ownPhotoRepairsEl = document.getElementById("own-photo-repairs");
const ownPhotoCopyEl = document.getElementById("own-photo-copy");
const ownPhotoShareEl = document.getElementById("own-photo-share");
// The working session for the photo most recently checked: its id,
// the current variant chain (null = the original), and the two
// approval flags readiness depends on — the seeded flow's session
// state, for the creator's own photo.
let ownSession = null;
// The rendered result list items by check id, so the repairs step
// can say plainly beside a verdict that no deterministic repair is
// offered for it.
let ownCheckItems = {};
// The latest result summary line, the share text's fallback when no
// alt text editor stands on the page yet.
let ownLastSummary = "";
const UPLOAD_CAP_BYTES = 15 * 1024 * 1024; // the server's cap (server/upload.js)
const SCALED_LONG_EDGE = 3000;
const CANVAS_PIXEL_CEILING = 16000000; // safely under iOS Safari's 16,777,216

function canvasPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error("The browser could not encode the photo as PNG."))),
      "image/png"
    );
  });
}

// Decodes the picked file with its EXIF orientation applied, via
// createImageBitmap where it is offered, and via an image element
// otherwise (which applies the orientation itself in current
// browsers). Returns { source, width, height, dispose }.
async function decodePhoto(file) {
  if (window.createImageBitmap) {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, dispose: () => bitmap.close() };
    } catch {
      // Fall through to the image-element path.
    }
  }
  const objectUrl = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("the browser could not decode the photo"));
      image.src = objectUrl;
    });
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, dispose: () => {} };
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function cappedDims(width, height, maxPixels) {
  const total = width * height;
  if (total <= maxPixels) return { width, height, capped: false };
  const f = Math.sqrt(maxPixels / total);
  return {
    width: Math.max(1, Math.floor(width * f)),
    height: Math.max(1, Math.floor(height * f)),
    capped: true,
  };
}

// Encodes the decoded photo as PNG at the target size. The draw goes
// in halving steps while the picture is more than twice the target,
// so no canvas is ever larger than the step being drawn and large
// reductions stay sharp; the last draw lands on the exact target.
async function encodePhotoPng(source, srcW, srcH, targetW, targetH) {
  let cur = source;
  let curW = srcW;
  let curH = srcH;
  while (curW > targetW * 2 && curH > targetH * 2) {
    const hw = Math.max(1, Math.floor(curW / 2));
    const hh = Math.max(1, Math.floor(curH / 2));
    const step = document.createElement("canvas");
    step.width = hw;
    step.height = hh;
    step.getContext("2d").drawImage(cur, 0, 0, hw, hh);
    cur = step;
    curW = hw;
    curH = hh;
  }
  const canvas = document.createElement("canvas");
  canvas.width = targetW;
  canvas.height = targetH;
  canvas.getContext("2d").drawImage(cur, 0, 0, targetW, targetH);
  return canvasPngBlob(canvas);
}

// --- The own-photo unit ------------------------------------------------------
// One photo, one unit, in the order a person acts on it — the seeded
// flow at parity: results, repairs, proof copy and alt text with
// approval, then share. Each step renders into its own container
// inside the "Check your own photo" section, exactly as the seeded
// unit renders into its containers beside the selected take.

function renderUploadResults(data) {
  ownCheckItems = {};
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "Your photo — pre-flight results"));
  frag.appendChild(el("p", data.note));
  if (data.scalingNote) frag.appendChild(el("p", data.scalingNote));
  if (data.measurementNote) frag.appendChild(el("p", data.measurementNote));
  const list = el("ul");
  for (const check of data.checks) {
    const sourceWord = SOURCE_WORDS[check.source] || check.source;
    const li = el("li", `${check.name}: ${check.verdict} (${sourceWord}) — ${check.detail}`);
    ownCheckItems[check.id] = li;
    list.appendChild(li);
  }
  frag.appendChild(list);

  if (data.privacyWarning) {
    const warnSource =
      data.privacyWarningSource === "model"
        ? "found by the model check"
        : "source unconfirmed";
    frag.appendChild(el("h3", `Warning — ${data.privacyWarning.name}`));
    frag.appendChild(el("p", data.privacyWarning.detail));
    frag.appendChild(el("p", `Warning source: ${warnSource}.`));
    appendWarningActionLines(frag, data);
  }

  const fixes = data.checks.filter((c) => c.verdict === "fix").length;
  const uncertains = data.checks.filter((c) => c.verdict === "uncertain").length;
  ownLastSummary = data.privacyWarning
    ? "Not ready to post: a private-information warning needs your decision first."
    : fixes > 0
      ? `Not ready to post yet: ${fixes} check${fixes === 1 ? "" : "s"} to fix.`
      : uncertains > 0
        ? "Some checks could not be settled for this photo — each one says why above."
        : "Ready to post: every check passes.";
  frag.appendChild(el("p", ownLastSummary));
  ownPhotoResultsEl.replaceChildren(frag);
}

// The full unit for the session's current version: results first,
// then the repairs offered for them, then the copy step (which ends
// by rendering the share step, as the seeded loadCopy does).
async function renderOwnUnit(result) {
  renderUploadResults(result);
  await loadOwnRepairs(result);
  await loadOwnCopy(result);
}

async function loadOwnRepairs(result) {
  if (!ownSession) return;
  ownPhotoRepairsEl.replaceChildren(el("p", "Looking for repairs for these verdicts…"));
  const variantQuery = ownSession.variant
    ? `?variant=${encodeURIComponent(ownSession.variant)}`
    : "";
  const res = await fetch(`/api/uploads/${ownSession.sessionId}/repairs${variantQuery}`);
  const data = await res.json();
  ownPhotoRepairsEl.replaceChildren();
  if (data.error) {
    ownPhotoRepairsEl.appendChild(el("p", `The repairs could not be listed: ${data.error}`));
    return;
  }
  const offeredFor = new Set((data.repairs || []).map((r) => r.fixesCheck));
  for (const check of result.checks) {
    if (check.verdict === "fix" && !offeredFor.has(check.id) && ownCheckItems[check.id]) {
      ownCheckItems[check.id].textContent += " No deterministic repair is offered for this check.";
    }
  }
  if (!data.repairs || data.repairs.length === 0) {
    ownPhotoRepairsEl.appendChild(el("p", "No deterministic repairs are offered for this photo's current verdicts."));
    return;
  }
  ownPhotoRepairsEl.appendChild(el("p", "Repairs are performed on the working copy — your original file on this device is never touched, and you can undo at any time. The working copy itself is deleted within two hours."));
  const list = el("ul");
  for (const repair of data.repairs) {
    const li = el("li");
    // Repair names arrive as "Short name: explanation". The button
    // carries the short name only; the explanation stands before it.
    const splitAt = repair.name.indexOf(": ");
    const shortName = splitAt > 0 ? repair.name.slice(0, splitAt) : repair.name;
    if (splitAt > 0) {
      const explanation = repair.name.slice(splitAt + 2);
      li.appendChild(
        el("p", explanation.charAt(0).toUpperCase() + explanation.slice(1) + (explanation.endsWith(".") ? "" : "."))
      );
    }
    const button = el("button", shortName);
    button.type = "button";
    button.addEventListener("click", () => applyOwnRepair(repair));
    li.appendChild(button);
    list.appendChild(li);
  }
  ownPhotoRepairsEl.appendChild(list);
}

async function applyOwnRepair(repair) {
  if (!ownSession) return;
  ownPhotoRepairsEl.replaceChildren(el("p", `Performing the repair: ${repair.name}…`));
  const res = await fetch(`/api/uploads/${ownSession.sessionId}/repair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ repairId: repair.id, baseVariant: ownSession.variant }),
  });
  const data = await res.json();
  if (data.error) {
    ownPhotoRepairsEl.replaceChildren(el("p", `The repair could not be performed: ${data.error}`));
    return;
  }
  ownSession.variant = data.variantId;
  ownSession.warningAcknowledged = false;
  ownSession.altTextApproved = false;

  ownPhotoRepairsEl.replaceChildren();
  ownPhotoRepairsEl.appendChild(el("h3", "What changed"));
  const changes = el("ul");
  for (const change of data.changes) changes.appendChild(el("li", change));
  ownPhotoRepairsEl.appendChild(changes);
  if (data.outcome) {
    ownPhotoRepairsEl.appendChild(
      el(
        "p",
        data.outcome.worse
          ? `Measured outcome: ${data.outcome.checkName} went from ${data.outcome.before} to ${data.outcome.after} — the repair did not improve this photo, and undo is right there.`
          : `Measured outcome: ${data.outcome.checkName} went from ${data.outcome.before} to ${data.outcome.after}.`
      )
    );
  }
  ownPhotoRepairsEl.appendChild(el("p", "The checks have run again on the repaired photo — see the results above."));
  ownPhotoRepairsEl.appendChild(
    el("p", "Undoing returns to your photo as it arrived; the repaired working copy is set aside.")
  );
  const undo = el("button", "Undo repair");
  undo.type = "button";
  undo.addEventListener("click", undoOwnRepair);
  ownPhotoRepairsEl.appendChild(undo);

  renderUploadResults(data.result);
  loadOwnCopy(data.result);
}

async function undoOwnRepair() {
  if (!ownSession) return;
  ownSession.variant = null;
  ownSession.warningAcknowledged = false;
  ownSession.altTextApproved = false;
  const res = await fetch(`/api/uploads/${ownSession.sessionId}/checks`);
  const data = await res.json();
  if (data.error) {
    ownPhotoRepairsEl.replaceChildren(el("p", `The original could not be re-checked: ${data.error}`));
    return;
  }
  renderOwnUnit(data);
}

async function refreshOwnReadiness() {
  if (!ownSession) return;
  const res = await fetch(`/api/uploads/${ownSession.sessionId}/readiness`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      variant: ownSession.variant,
      warningAcknowledged: ownSession.warningAcknowledged,
      altTextApproved: ownSession.altTextApproved,
    }),
  });
  const r = await res.json();
  const region = document.getElementById("own-readiness-region");
  if (!region) return;
  region.replaceChildren();
  region.appendChild(el("h3", "Ready to post"));
  if (r.ready) {
    region.appendChild(el("p", "Ready. Every check is settled, and you have approved the words."));
  } else {
    region.appendChild(el("p", "Not ready yet:"));
    const list = el("ul");
    for (const reason of r.reasons || []) list.appendChild(el("li", reason));
    region.appendChild(list);
  }
}

async function loadOwnCopy(checkData) {
  if (!ownSession) return;
  ownPhotoCopyEl.replaceChildren(el("p", "Building your proof copy and alt text draft…"));
  const variantQuery = checkData.variant ? `?variant=${encodeURIComponent(checkData.variant)}` : "";
  const res = await fetch(`/api/uploads/${ownSession.sessionId}/copy${variantQuery}`);
  const data = await res.json();
  if (data.error) {
    ownPhotoCopyEl.replaceChildren(el("p", `The proof copy could not be built: ${data.error}`));
    return;
  }

  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "Proof copy — yours alone, never posted"));
  const pre = el("pre");
  pre.textContent = data.proofCopy;
  frag.appendChild(pre);
  const blob = new Blob([data.proofCopy], { type: "text/plain; charset=utf-8" });
  const download = el("a", "Download the proof copy as a plain text file (braille-ready).");
  download.href = URL.createObjectURL(blob);
  download.download = `proof-copy-your-photo${checkData.variant ? "-repaired" : ""}.txt`;
  frag.appendChild(download);

  frag.appendChild(el("h3", "Alt text for the post"));
  frag.appendChild(el("p", data.altText.note));
  const label = el("label", "Alt text — edit it into your own words:");
  label.htmlFor = "own-alt-text-editor";
  frag.appendChild(label);
  const editor = document.createElement("textarea");
  editor.id = "own-alt-text-editor";
  editor.rows = 4;
  editor.cols = 60;
  editor.value = data.altText.text;
  const approveBtn = el("button", "Approve alt text");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet.");
  editor.addEventListener("input", () => {
    // Any edit un-approves: approval must always cover the current words.
    // The button label never changes — the state lives in approveState.
    if (ownSession.altTextApproved) {
      ownSession.altTextApproved = false;
      approveState.textContent = "Edited since approval — approval cleared.";
      refreshOwnReadiness();
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    ownSession.altTextApproved = true;
    approveState.textContent = "You approved the alt text exactly as it stands.";
    refreshOwnReadiness();
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
      ownSession.warningAcknowledged = ack.checked;
      refreshOwnReadiness();
    });
    ackLabel.prepend(ack);
    frag.appendChild(ackLabel);
  }

  const region = el("div");
  region.id = "own-readiness-region";
  region.setAttribute("aria-live", "polite");
  frag.appendChild(region);

  ownPhotoCopyEl.replaceChildren(frag);
  refreshOwnReadiness();
  renderOwnShare();
}

// An uploaded photo shares its current version — the repaired
// variant when repairs have been applied, otherwise the photo as it
// arrived — fetched from the session's read-only media route, with
// the alt text above as the words: the approved text when it stands
// approved, the current draft when it does not; both are simply what
// the editor holds when Share is pressed.
async function ownShareParts() {
  const editor = document.getElementById("own-alt-text-editor");
  const text = editor ? editor.value : ownLastSummary;
  let file = null;
  try {
    const variantQuery = ownSession.variant
      ? `?variant=${encodeURIComponent(ownSession.variant)}`
      : "";
    const res = await fetch(`/api/uploads/${ownSession.sessionId}/media${variantQuery}`);
    if (res.ok) {
      const blob = await res.blob();
      file = new File([blob], `your-photo${ownSession.variant ? "-repaired" : ""}.png`, {
        type: "image/png",
      });
    }
  } catch {
    file = null;
  }
  return { file, text };
}

function renderOwnShare() {
  renderShareBlock(ownPhotoShareEl, {
    explanation:
      "Share your photo — the repaired version if you have repaired it, otherwise the photo as it arrived — together with the alt text above, to another app.",
    noShareText:
      "This browser cannot share from a web page, so there is no share button here. The proof copy above is ready to copy and paste instead.",
    getParts: () => ownShareParts(),
  });
}

async function checkOwnPhoto() {
  const file = ownPhotoInput.files && ownPhotoInput.files[0];
  if (!file) return;
  session = null;
  ownSession = null;
  ownPhotoRepairsEl.replaceChildren();
  ownPhotoCopyEl.replaceChildren();
  ownPhotoShareEl.replaceChildren();
  ownPhotoStatusEl.textContent = "Reading your photo…";
  ownPhotoResultsEl.replaceChildren(el("p", "Running the six checks on your photo…"));
  let decoded = null;
  try {
    decoded = await decodePhoto(file);
    if (!decoded.width || !decoded.height) {
      throw new Error("the browser decoded the photo to no size");
    }

    // The working size is capped at decode time (the canvas ceiling),
    // then by file size: a copy over the server's cap is reduced to a
    // 3000-pixel longest side, and further in steps if it must.
    let dims = cappedDims(decoded.width, decoded.height, CANVAS_PIXEL_CEILING);
    let scaled = dims.capped;
    let blob = await encodePhotoPng(decoded.source, decoded.width, decoded.height, dims.width, dims.height);
    if (blob.size > UPLOAD_CAP_BYTES) {
      const f = Math.min(1, SCALED_LONG_EDGE / Math.max(dims.width, dims.height));
      dims = {
        width: Math.max(1, Math.round(dims.width * f)),
        height: Math.max(1, Math.round(dims.height * f)),
      };
      scaled = true;
      blob = await encodePhotoPng(decoded.source, decoded.width, decoded.height, dims.width, dims.height);
      while (blob.size > UPLOAD_CAP_BYTES && dims.width > 64 && dims.height > 64) {
        dims = {
          width: Math.max(1, Math.floor(dims.width * 0.8)),
          height: Math.max(1, Math.floor(dims.height * 0.8)),
        };
        blob = await encodePhotoPng(decoded.source, decoded.width, decoded.height, dims.width, dims.height);
      }
    }
    if (blob.size > UPLOAD_CAP_BYTES) {
      ownPhotoStatusEl.textContent = "That photo is still too large to check even after scaling down. Nothing was sent.";
      ownPhotoResultsEl.replaceChildren(el("p", "The photo was not checked: even a scaled copy exceeds the 15 MB limit."));
      return;
    }

    ownPhotoStatusEl.textContent = scaled
      ? "Checking a scaled copy of your photo…"
      : "Checking your photo…";
    const res = await fetch(`/api/uploads/check${scaled ? "?scaled=1" : ""}`, {
      method: "POST",
      headers: { "Content-Type": "image/png" },
      body: blob,
    });
    const data = await res.json();
    if (data.error) {
      ownPhotoStatusEl.textContent = `The check could not run: ${data.error}`;
      ownPhotoResultsEl.replaceChildren(el("p", `The photo was not checked: ${data.error}`));
      return;
    }
    ownPhotoStatusEl.textContent =
      "Your photo has been checked. The results are just below, in this section, with any repairs, the proof copy, and the share step after them. The working copy is kept only while you work with it and is deleted within two hours.";
    ownSession = {
      sessionId: data.sessionId,
      variant: null,
      warningAcknowledged: false,
      altTextApproved: false,
    };
    renderOwnUnit(data);
  } catch (err) {
    ownPhotoStatusEl.textContent =
      "That photo could not be read in this browser, so it was not checked. A JPEG or PNG copy of it will work.";
    ownPhotoResultsEl.replaceChildren(
      el("p", "The photo was not checked: this browser could not decode it.")
    );
  } finally {
    if (decoded) decoded.dispose();
    ownPhotoInput.value = "";
  }
}

ownPhotoInput.addEventListener("change", checkOwnPhoto);
