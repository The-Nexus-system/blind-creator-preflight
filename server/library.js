"use strict";

// Library Sweep — the demo slice (MODULE-CONTRACTS section 9; seeded
// library pinned in SEED-TAKES).
//
// The promise at library scale: know what is in your library before any
// app sees it — in words, counts, and lists, never a visual grid.
//
// This slice is SIMULATED and says so: a seeded mini-library stands in
// for a creator's real one. In the full module the sorting happens on the
// device, from signals the device already knows (screenshots are an asset
// type the phone itself records) plus on-device triage; nothing leaves
// the device, and cloud deep-checks are per-item at the creator's
// direction only. Here, each item's category is its seeded specification
// from the design record — the slice demonstrates the sweep's behaviour
// (sort, warn, cull, approve) without pretending to have scanned a real
// library.
//
// Invariants carried over from the contract:
// - The private-information warning is first-class: it is returned as its
//   own list, never as a line inside a category.
// - A duplicate pair is counted as ONE item of TWO files, described once.
// - Culling is a session action in this slice (nothing is deleted
//   anywhere), and confirming a cull names any flagged item inside the
//   set once more before it completes — that rule lives in the client
//   flow, driven by the warnings data returned here.

const ITEMS = [
  {
    id: "SL-1",
    description: "Screenshot of a chat conversation.",
    category: "Screenshots",
    files: 1,
    privacyWarning: null,
    takeId: null,
  },
  {
    id: "SL-2",
    description: "Screenshot of a settings screen.",
    category: "Screenshots",
    files: 1,
    privacyWarning: null,
    takeId: null,
  },
  {
    id: "SL-3",
    description: "A desk photo: an opened letter beside a keyboard.",
    category: "Documents and text-heavy",
    files: 1,
    privacyWarning: {
      name: "Private information visible — an opened letter with a readable home address.",
      detail:
        "This is the ST-P8 desk photo at library scale. The letter's home address is readable; any app given this photo can read it too.",
    },
    takeId: "ST-P8",
  },
  {
    id: "SL-4",
    description: "The same clean portrait, saved twice — a duplicate pair, described once.",
    category: "Duplicates",
    files: 2,
    privacyWarning: null,
    takeId: null,
  },
  {
    id: "SL-5",
    description: "A blurry accidental shot: dark, motion-smeared, no subject.",
    category: "Blurry or accidental",
    files: 1,
    privacyWarning: null,
    takeId: null,
  },
  {
    id: "SL-6",
    description: "A clean portrait of the creator holding a sign.",
    category: "Photos",
    files: 1,
    privacyWarning: null,
    takeId: "ST-P1",
  },
];

function sweep() {
  const categories = [];
  for (const item of ITEMS) {
    let cat = categories.find((c) => c.name === item.category);
    if (!cat) {
      cat = { name: item.category, itemCount: 0, fileCount: 0, itemIds: [] };
      categories.push(cat);
    }
    cat.itemCount += 1;
    cat.fileCount += item.files;
    cat.itemIds.push(item.id);
  }
  return {
    simulated: true,
    note:
      "Simulated slice: this is a seeded mini-library standing in for your real one. In the full sweep, this sorting happens on your device and nothing leaves it; here it demonstrates the sweep's behaviour — sort, warn, cull, approve.",
    totalItems: ITEMS.length,
    totalFiles: ITEMS.reduce((n, i) => n + i.files, 0),
    categories,
    items: ITEMS,
    privacyWarnings: ITEMS.filter((i) => i.privacyWarning).map((i) => ({
      itemId: i.id,
      name: i.privacyWarning.name,
      detail: i.privacyWarning.detail,
    })),
  };
}

module.exports = { sweep, ITEMS };
