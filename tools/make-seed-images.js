"use strict";

// Generates the seeded photo takes as synthetic images, so the deterministic
// checks pipeline has real pixels to measure.
//
// Each image is an abstract composition — background, a subject block, a
// sign band — drawn to match the take's designed specification (SEED-TAKES).
// Alongside each image, a .json sidecar records the ground-truth boxes
// (subject, sign) the composition was drawn from; the measurement module
// compares those boxes against the frame and the platform crops. For real
// uploads the boxes will come from segmentation instead; the geometry is
// identical either way, and every verdict names its source.
//
// Run: node tools/make-seed-images.js   (writes server/seed-media/)
//
// Two takes outgrew pure abstraction, because the semantic pipeline judges
// pixels, not specifications: ST-P1's sign now carries its words as real
// glyphs and its figure is drawn as a recognisable person holding the sign,
// and ST-P8's letter carries a readable (invented) name and address. The
// sidecar geometry — the boxes every measured verdict comes from — is
// unchanged for every take, and ST-P2/ST-P4 still render exactly as before.

const fs = require("fs");
const path = require("path");
const { Jimp, loadFont, measureText } = require("jimp");

const PRINT_PKG = path.dirname(require.resolve("@jimp/plugin-print/package.json"));
const FONT_FILES = {
  sign: path.join(PRINT_PKG, "fonts", "open-sans", "open-sans-32-black", "open-sans-32-black.fnt"),
  small: path.join(PRINT_PKG, "fonts", "open-sans", "open-sans-16-black", "open-sans-16-black.fnt"),
};

const OUT = path.join(__dirname, "..", "server", "seed-media");
const W = 1000;
const H = 1000;

const COL = {
  bg: 0xb8b2a7ff,
  desk: 0x8a7f6fff,
  torso: 0x3f6186ff,
  head: 0xd9b596ff,
  sign: 0xf5f2e9ff,
  ink: 0x26221cff,
  letter: 0xfbfaf5ff,
  letterLine: 0x9a958aff,
  sleeve: 0x2f4c6bff,
  hair: 0x453322ff,
  mouth: 0x7a4a3aff,
  signEdge: 0x6b665aff,
};

function fillRect(img, box, color) {
  for (let y = box.y0; y < box.y1; y++) {
    for (let x = box.x0; x < box.x1; x++) {
      img.setPixelColor(color, x, y);
    }
  }
}

function fillCircle(img, cx, cy, r, color) {
  for (let y = cy - r; y < cy + r; y++) {
    for (let x = cx - r; x < cx + r; x++) {
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) img.setPixelColor(color, x, y);
    }
  }
}

function drawSubject(img, box) {
  fillRect(img, box, COL.torso);
  const cx = Math.floor((box.x0 + box.x1) / 2);
  const headR = Math.floor((box.x1 - box.x0) / 4);
  fillCircle(img, cx, box.y0 + headR, headR, COL.head);
}

function drawSign(img, box, lines = 3) {
  const clipped = { x0: box.x0, y0: box.y0, x1: Math.min(box.x1, W), y1: Math.min(box.y1, H) };
  fillRect(img, clipped, COL.sign);
  const lineH = Math.floor((box.y1 - box.y0) / (lines * 2));
  for (let i = 0; i < lines; i++) {
    const y0 = box.y0 + lineH * (2 * i + 1);
    fillRect(img, { x0: box.x0 + 20, y0, x1: Math.min(box.x1 - 20, W), y1: y0 + lineH }, COL.ink);
  }
}

function drawThickLine(img, x0, y0, x1, y1, r, color) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(x0 + ((x1 - x0) * i) / steps);
    const y = Math.round(y0 + ((y1 - y0) * i) / steps);
    fillCircle(img, x, y, r, color);
  }
}

function printCentered(img, font, cx, y, text) {
  const w = measureText(font, text);
  img.print({ font, x: Math.round(cx - w / 2), y, text });
}

// ST-P1's figure: the same subject/sign boxes as the abstract composition,
// drawn as a person a viewer — or a vision model — can recognise: a head
// with hair and a face, sleeved arms running down to the sign, and hands
// gripping the sign's top corners. The sign carries its words as real
// glyphs. Pixel dressing only; the sidecar geometry is untouched.
function drawPersonHoldingSign(img, gt, font) {
  const box = gt.subject;
  const sign = gt.sign;
  fillRect(img, box, COL.torso);
  const cx = Math.floor((box.x0 + box.x1) / 2);
  const headR = Math.floor((box.x1 - box.x0) / 4);
  const cy = box.y0 + headR;
  // Arms (sleeves) run from the shoulders down to the sign's top corners.
  drawThickLine(img, box.x0 + 30, box.y0 + 180, sign.x0 + 42, sign.y0 + 16, 21, COL.sleeve);
  drawThickLine(img, box.x1 - 30, box.y0 + 180, sign.x1 - 42, sign.y0 + 16, 21, COL.sleeve);
  // Head: skin disc, hair across the top, two eyes, a smile.
  fillCircle(img, cx, cy, headR, COL.head);
  for (let y = cy - headR; y < cy - 14; y++) {
    for (let x = cx - headR; x < cx + headR; x++) {
      if ((x - cx) ** 2 + (y - cy) ** 2 <= headR * headR) img.setPixelColor(COL.hair, x, y);
    }
  }
  fillCircle(img, cx - 26, cy + 4, 7, COL.ink);
  fillCircle(img, cx + 26, cy + 4, 7, COL.ink);
  drawThickLine(img, cx - 15, cy + 30, cx, cy + 38, 3, COL.mouth);
  drawThickLine(img, cx, cy + 38, cx + 15, cy + 30, 3, COL.mouth);
  // The sign: board with an edge, hands gripping its top corners, words.
  const clipped = { x0: sign.x0, y0: sign.y0, x1: Math.min(sign.x1, W), y1: Math.min(sign.y1, H) };
  fillRect(img, clipped, COL.sign);
  fillRect(img, { x0: clipped.x0, y0: clipped.y0, x1: clipped.x1, y1: clipped.y0 + 4 }, COL.signEdge);
  fillRect(img, { x0: clipped.x0, y0: clipped.y1 - 4, x1: clipped.x1, y1: clipped.y1 }, COL.signEdge);
  fillRect(img, { x0: clipped.x0, y0: clipped.y0, x1: clipped.x0 + 4, y1: clipped.y1 }, COL.signEdge);
  fillRect(img, { x0: clipped.x1 - 4, y0: clipped.y0, x1: clipped.x1, y1: clipped.y1 }, COL.signEdge);
  fillCircle(img, sign.x0 + 42, sign.y0 + 14, 19, COL.head);
  fillCircle(img, sign.x1 - 42, sign.y0 + 14, 19, COL.head);
  printCentered(img, font, cx, sign.y0 + 12, "FRACTURED");
  printCentered(img, font, cx, sign.y0 + 52, "FLOW");
}

const TAKES = [
  {
    id: "ST-P1",
    draw(img, fonts) {
      drawPersonHoldingSign(img, this.gt, fonts.sign);
    },
    gt: { subject: { x0: 350, y0: 200, x1: 650, y1: 800 }, sign: { x0: 300, y0: 620, x1: 700, y1: 720 } },
  },
  {
    id: "ST-P2",
    draw(img) {
      drawSubject(img, this.gt.subject);
    },
    gt: { subject: { x0: 350, y0: 0, x1: 650, y1: 780 }, sign: null },
  },
  {
    id: "ST-P4",
    draw(img) {
      drawSubject(img, this.gt.subject);
      drawSign(img, this.gt.sign);
    },
    gt: { subject: { x0: 350, y0: 200, x1: 650, y1: 800 }, sign: { x0: 250, y0: 600, x1: 1000, y1: 700 } },
  },
  {
    id: "ST-P8",
    draw(img, fonts) {
      // Desk band along the bottom, subject behind it, letter on the desk.
      fillRect(img, { x0: 0, y0: 780, x1: W, y1: H }, COL.desk);
      drawSubject(img, this.gt.subject);
      fillRect(img, this.gt.privateItem, COL.letter);
      // The letter carries a readable name and address as real glyphs —
      // invented, nobody's data — because that readability is exactly what
      // the privacy warning exists to catch. The lines below the address
      // stay abstract, as body text.
      const address = ["Ms. Robin Sample", "48 Invented Hollow Rd", "Faketown, OH 44000"];
      address.forEach((line, i) => {
        img.print({
          font: fonts.small,
          x: this.gt.privateItem.x0 + 14,
          y: this.gt.privateItem.y0 + 12 + i * 21,
          text: line,
        });
      });
      for (let i = 0; i < 2; i++) {
        const y0 = this.gt.privateItem.y0 + 84 + i * 24;
        fillRect(
          img,
          { x0: this.gt.privateItem.x0 + 14, y0, x1: this.gt.privateItem.x1 - 14, y1: y0 + 6 },
          COL.letterLine
        );
      }
    },
    gt: {
      subject: { x0: 300, y0: 180, x1: 620, y1: 820 },
      sign: null,
      privateItem: { x0: 700, y0: 800, x1: 950, y1: 950 },
    },
  },
];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const fonts = {
    sign: await loadFont(FONT_FILES.sign),
    small: await loadFont(FONT_FILES.small),
  };
  for (const take of TAKES) {
    const img = new Jimp({ width: W, height: H, color: COL.bg });
    take.draw(img, fonts);
    const pngPath = path.join(OUT, `${take.id}.png`);
    await img.write(pngPath);
    fs.writeFileSync(path.join(OUT, `${take.id}.json`), JSON.stringify(take.gt, null, 2));
    console.log(`wrote ${pngPath} + sidecar`);
  }
})();
