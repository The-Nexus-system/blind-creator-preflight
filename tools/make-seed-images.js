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

const fs = require("fs");
const path = require("path");
const { Jimp } = require("jimp");

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

const TAKES = [
  {
    id: "ST-P1",
    draw(img) {
      drawSubject(img, this.gt.subject);
      drawSign(img, this.gt.sign);
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
    draw(img) {
      // Desk band along the bottom, subject behind it, letter on the desk.
      fillRect(img, { x0: 0, y0: 780, x1: W, y1: H }, COL.desk);
      drawSubject(img, this.gt.subject);
      fillRect(img, this.gt.privateItem, COL.letter);
      for (let i = 0; i < 5; i++) {
        const y0 = this.gt.privateItem.y0 + 18 + i * 26;
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
  for (const take of TAKES) {
    const img = new Jimp({ width: W, height: H, color: COL.bg });
    take.draw(img);
    const pngPath = path.join(OUT, `${take.id}.png`);
    await img.write(pngPath);
    fs.writeFileSync(path.join(OUT, `${take.id}.json`), JSON.stringify(take.gt, null, 2));
    console.log(`wrote ${pngPath} + sidecar`);
  }
})();
