"use strict";

// Draws the seeded VIDEO takes as real media, the same way
// make-seed-images.js draws the photos: synthetic frames from the
// design record's specifications, with ground-truth boxes saved beside
// the file. Run with: npm run make-seed-videos (then ffmpeg must exist).
//
// ST-V2 (the demo take of record): recorded wider than the post. The
// posted 9:16 centre crop must show the banner as "SIGNAL OVER NOI" —
// the crop edge falls inside NOISE, after the I — and the creator,
// standing left of centre in the wide frame, must be pushed to the
// posted frame's edge. The text placement is SOLVED, not eyeballed:
// the generator measures the prefix "SIGNAL OVER NOI" with the actual
// font and sets the text start so the prefix's right edge lands on the
// crop's right edge. The assertions below fail the build if the
// geometry ever drifts from the spec.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { Jimp, JimpMime, loadFont, measureText } = require("jimp");
const { SANS_32_WHITE } = require("jimp/fonts");

const OUT_DIR = path.join(__dirname, "..", "server", "seed-media");
const W = 1280;
const H = 720;
const FPS = 12;
const SECONDS = 15;

const WALL = 0x2e3a46ff;
const BOARD = 0x14342bff;
const SKIN = 0xd9a17aff;
const SHIRT = 0x74551fff;

async function main() {
  const font = await loadFont(SANS_32_WHITE);
  const centreCrop = { x0: (W - (H * 9) / 16) / 2, x1: (W + (H * 9) / 16) / 2, y0: 0, y1: H };

  const banner = { x0: 150, y0: 56, x1: 1180, y1: 196 };
  const textY = 104;
  const prefix = "SIGNAL OVER NOI";
  const fullText = "SIGNAL OVER NOISE TOUR";
  const prefixWidth = measureText(font, prefix);
  const textX = Math.round(centreCrop.x1 - prefixWidth);
  const noiseX = textX + measureText(font, "SIGNAL OVER ");
  const noiseWidth = measureText(font, "NOISE");
  const tourX = textX + measureText(font, "SIGNAL OVER NOISE ");
  const tourWidth = measureText(font, "TOUR");

  const subject = { x0: 395, y0: 272, x1: 565, y1: 648 };

  // Geometry assertions against the pinned spec (SEED-TAKES, ST-V2).
  const eps = 4;
  if (Math.abs(textX + prefixWidth - centreCrop.x1) > eps)
    throw new Error("prefix right edge is not on the crop edge");
  if (!(textX >= centreCrop.x0))
    throw new Error("SIGNAL is not whole inside the posted crop — the post must read SIGNAL OVER NOI");
  if (!(tourX >= centreCrop.x1)) throw new Error("TOUR is not fully outside the posted crop");
  if (!(noiseX < centreCrop.x1 && noiseX + noiseWidth > centreCrop.x1))
    throw new Error("the crop does not fall inside NOISE");
  if (!(subject.x0 < centreCrop.x0 && subject.x1 > centreCrop.x0 && subject.x1 < centreCrop.x1))
    throw new Error("creator is not pushed to the posted frame's left edge");

  const framesDir = fs.mkdtempSync(path.join(os.tmpdir(), "stv2-frames-"));
  const total = FPS * SECONDS;
  for (let f = 0; f < total; f++) {
    const img = new Jimp({ width: W, height: H, color: WALL });
    img.scan((x, y, idx) => {
      if (x >= banner.x0 && x <= banner.x1 && y >= banner.y0 && y <= banner.y1) {
        img.bitmap.data[idx] = 0x14;
        img.bitmap.data[idx + 1] = 0x34;
        img.bitmap.data[idx + 2] = 0x2b;
      }
    });
    img.print({ font, x: textX, y: textY, text: fullText });
    const sway = Math.round(Math.sin(f / 9) * 2);
    // Torso and head.
    img.scan((x, y, idx) => {
      const inTorso = x >= subject.x0 + sway && x <= subject.x1 + sway && y >= 392 && y <= subject.y1;
      const dx = x - (480 + sway);
      const dy = y - 330;
      const inHead = dx * dx + dy * dy <= 58 * 58;
      if (inTorso) {
        img.bitmap.data[idx] = 0x74;
        img.bitmap.data[idx + 1] = 0x55;
        img.bitmap.data[idx + 2] = 0x1f;
      } else if (inHead) {
        img.bitmap.data[idx] = 0xd9;
        img.bitmap.data[idx + 1] = 0xa1;
        img.bitmap.data[idx + 2] = 0x7a;
      }
    });
    // Hands: raised (signing) during seconds 9-12, down otherwise.
    const tSec = f / FPS;
    const handsUp = tSec >= 9 && tSec < 12;
    const handSpots = handsUp
      ? [
          [368 + sway, 300],
          [592 + sway, 300],
        ]
      : [
          [372 + sway, 520],
          [588 + sway, 520],
        ];
    img.scan((x, y, idx) => {
      for (const [hx, hy] of handSpots) {
        const dx = x - hx;
        const dy = y - hy;
        if (dx * dx + dy * dy <= 20 * 20) {
          img.bitmap.data[idx] = 0xd9;
          img.bitmap.data[idx + 1] = 0xa1;
          img.bitmap.data[idx + 2] = 0x7a;
        }
      }
    });
    const framePath = path.join(framesDir, `frame-${String(f).padStart(4, "0")}.png`);
    fs.writeFileSync(framePath, await img.getBuffer(JimpMime.png));
    if (f === Math.floor(total / 2)) {
      // A posted-crop preview still: what the post would actually show.
      const crop = img.clone();
      crop.crop({ x: Math.round(centreCrop.x0), y: 0, w: Math.round(centreCrop.x1 - centreCrop.x0), h: H });
      fs.writeFileSync(path.join(OUT_DIR, "ST-V2-posted-preview.png"), await crop.getBuffer(JimpMime.png));
    }
  }

  const out = path.join(OUT_DIR, "ST-V2.mp4");
  execFileSync("ffmpeg", [
    "-v", "error", "-y", "-framerate", String(FPS), "-i", path.join(framesDir, "frame-%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", out,
  ]);
  fs.rmSync(framesDir, { recursive: true, force: true });

  const sidecar = {
    width: W,
    height: H,
    fps: FPS,
    seconds: SECONDS,
    silent: true,
    banner,
    bannerText: fullText,
    bannerTextBox: { x0: textX, y0: textY, x1: textX + measureText(font, fullText), y1: textY + 32 },
    noiseWordBox: { x0: noiseX, y0: textY, x1: noiseX + noiseWidth, y1: textY + 32 },
    tourWordBox: { x0: tourX, y0: textY, x1: tourX + tourWidth, y1: textY + 32 },
    postedCropWindow: centreCrop,
    subject,
    handsUpSeconds: [9, 12],
  };
  fs.writeFileSync(path.join(OUT_DIR, "ST-V2.json"), JSON.stringify(sidecar, null, 2));
  console.log(`ST-V2.mp4 written (${SECONDS}s, ${W}x${H}) — crop edge at x=${centreCrop.x1}, prefix ends at x=${textX + prefixWidth}, TOUR at x=${tourX}..${tourX + tourWidth}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
