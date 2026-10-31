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
  loadPublicDescription(take, checkData);
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
  const approveBtn = el("button", "Approve this public description");
  approveBtn.type = "button";
  const approveState = el("p", "Not approved yet. It will not be used anywhere until you approve it.");
  editor.addEventListener("input", () => {
    if (session && session.publicApproved) {
      session.publicApproved = false;
      approveBtn.textContent = "Approve this public description";
      approveState.textContent = "Edited since approval — approval cleared.";
    }
  });
  frag.appendChild(editor);
  approveBtn.addEventListener("click", () => {
    if (session) session.publicApproved = true;
    approveBtn.textContent = "Public description approved";
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

  frag.appendChild(el("h3", "Categories"));
  const catList = el("ul");
  for (const cat of sweepData.categories) {
    const remaining = cat.itemIds.filter((id) => !culledIds.has(id));
    const line = `${cat.name}: ${remaining.length} item${remaining.length === 1 ? "" : "s"} (${cat.itemIds.reduce(
      (n, id) => n + (sweepData.items.find((i) => i.id === id) || { files: 0 }).files,
      0
    )} files)${remaining.length < cat.itemIds.length ? ` — ${cat.itemIds.length - remaining.length} culled this session` : ""}.`;
    const li = el("li", line);
    if (remaining.length) {
      const cullBtn = el("button", `Cull the ${cat.name} category`);
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
        const confirmBtn = el("button", `Confirm culling ${cat.name}`);
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
    frag.appendChild(el("h3", `Warning — ${warning.itemId}: ${warning.name}`));
    frag.appendChild(el("p", warning.detail));
  }

  frag.appendChild(el("h3", "Every item, in words"));
  const itemList = el("ul");
  for (const item of sweepData.items) {
    const state = culledIds.has(item.id)
      ? "Culled this session."
      : approvedShareIds.has(item.id)
        ? "In your Approved to share set."
        : "Not culled, not approved.";
    const li = el(
      "li",
      `${item.id} (${item.category}${item.files > 1 ? `, ${item.files} files` : ""}): ${item.description} ${state}`
    );
    if (!culledIds.has(item.id)) {
      const toggle = el(
        "button",
        approvedShareIds.has(item.id)
          ? `Remove ${item.id} from Approved to share`
          : `Add ${item.id} to Approved to share`
      );
      toggle.type = "button";
      toggle.addEventListener("click", () => {
        if (approvedShareIds.has(item.id)) approvedShareIds.delete(item.id);
        else approvedShareIds.add(item.id);
        renderLibrary();
      });
      li.appendChild(toggle);
      if (item.takeId) {
        const send = el("button", `Run the full pre-flight check on ${item.id}`);
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
// checked. The photo is processed for the check and not stored; the
// results render with textContent only, like every result here.

const ownPhotoInput = document.getElementById("own-photo-input");
const ownPhotoStatusEl = document.getElementById("own-photo-status");
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

function renderUploadResults(data) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el("h3", "Your photo — pre-flight results"));
  frag.appendChild(el("p", data.note));
  if (data.scalingNote) frag.appendChild(el("p", data.scalingNote));
  if (data.measurementNote) frag.appendChild(el("p", data.measurementNote));
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
        : "source unconfirmed";
    frag.appendChild(el("h3", `Warning — ${data.privacyWarning.name}`));
    frag.appendChild(el("p", data.privacyWarning.detail));
    frag.appendChild(el("p", `Warning source: ${warnSource}.`));
  }

  const fixes = data.checks.filter((c) => c.verdict === "fix").length;
  const uncertains = data.checks.filter((c) => c.verdict === "uncertain").length;
  const summary = data.privacyWarning
    ? "Not ready to post: a private-information warning needs your decision first."
    : fixes > 0
      ? `Not ready to post yet: ${fixes} check${fixes === 1 ? "" : "s"} to fix.`
      : uncertains > 0
        ? "Some checks could not be settled for this photo — each one says why above."
        : "Ready to post: every check passes.";
  frag.appendChild(el("p", summary));
  composerStatusEl.textContent = summary;
  resultsEl.replaceChildren(frag);
}

async function checkOwnPhoto() {
  const file = ownPhotoInput.files && ownPhotoInput.files[0];
  if (!file) return;
  session = null;
  ownPhotoStatusEl.textContent = "Reading your photo…";
  resultsEl.replaceChildren(el("p", "Running the six checks on your photo…"));
  repairsEl.replaceChildren(
    el("p", "Repairs belong to the seeded takes; a photo of your own gets the checks themselves.")
  );
  copyAreaEl.replaceChildren(
    el("p", "Proof copy and alt text belong to the seeded takes in this demo; a photo of your own gets the checks themselves.")
  );
  publicAreaEl.replaceChildren(
    el("p", "The public description belongs to the seeded takes in this demo.")
  );
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
      resultsEl.replaceChildren(el("p", "The photo was not checked: even a scaled copy exceeds the 15 MB limit."));
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
      resultsEl.replaceChildren(el("p", `The photo was not checked: ${data.error}`));
      return;
    }
    ownPhotoStatusEl.textContent =
      "Your photo has been checked. The results are in the results section; the photo itself was not stored.";
    renderUploadResults(data);
  } catch (err) {
    ownPhotoStatusEl.textContent =
      "That photo could not be read in this browser, so it was not checked. A JPEG or PNG copy of it will work.";
    resultsEl.replaceChildren(
      el("p", "The photo was not checked: this browser could not decode it.")
    );
  } finally {
    if (decoded) decoded.dispose();
    ownPhotoInput.value = "";
  }
}

ownPhotoInput.addEventListener("change", checkOwnPhoto);
