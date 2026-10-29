"use strict";

// Extracts the still frames the checks pipeline judges for the seeded
// VIDEO takes, from the seeded video files themselves. Run with:
// npm run make-seed-frames (ffmpeg must exist — build time only).
//
// Why stills: the deployed backend (node on Fly, no ffmpeg) cannot decode
// video, and the checks design is seeded and deterministic — so the frames
// are extracted ONCE, here, and committed as seed media next to the video.
// The server then measures and judges those frames exactly as it does a
// photo's pixels. The video file remains the take of record; these stills
// are its frames, named by the moment they come from, never redrawn.
//
// For ST-V2 it writes:
// - ST-V2-frame.png        the recorded frame at 7.5 s (the clip's geometry
//                          is constant but for a ±2 px sway and the hands,
//                          so one frame represents it; 7.5 s is the frame
//                          the generator's own posted preview came from)
// - ST-V2-posted.png       that frame through the posted 9:16 centre crop
//                          — the frame the audience actually sees
// - ST-V2-cover-frame.png  the recorded frame at 10.5 s, inside the
//                          hands-up window the sidecar records (9–12 s)
// - ST-V2-cover-posted.png its posted crop — the cover-frame repair's view

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { Jimp } = require("jimp");

const MEDIA_DIR = path.join(__dirname, "..", "server", "seed-media");

function extractFrame(mp4Path, seconds, outPath) {
  execFileSync("ffmpeg", [
    "-v", "error", "-y",
    "-ss", String(seconds),
    "-i", mp4Path,
    "-frames:v", "1",
    outPath,
  ]);
}

async function postedCrop(framePath, win, outPath) {
  const img = await Jimp.fromBuffer(fs.readFileSync(framePath));
  img.crop({
    x: Math.round(win.x0),
    y: Math.round(win.y0),
    w: Math.round(win.x1 - win.x0),
    h: Math.round(win.y1 - win.y0),
  });
  fs.writeFileSync(outPath, await img.getBuffer("image/png"));
  return { width: img.bitmap.width, height: img.bitmap.height };
}

async function main() {
  const sidecar = JSON.parse(fs.readFileSync(path.join(MEDIA_DIR, "ST-V2.json"), "utf8"));
  const mp4 = path.join(MEDIA_DIR, "ST-V2.mp4");
  const win = sidecar.postedCropWindow;
  const handsMid = (sidecar.handsUpSeconds[0] + sidecar.handsUpSeconds[1]) / 2;

  const framePath = path.join(MEDIA_DIR, "ST-V2-frame.png");
  const coverPath = path.join(MEDIA_DIR, "ST-V2-cover-frame.png");
  extractFrame(mp4, 7.5, framePath);
  extractFrame(mp4, handsMid, coverPath);

  for (const p of [framePath, coverPath]) {
    const img = await Jimp.fromBuffer(fs.readFileSync(p));
    if (img.bitmap.width !== sidecar.width || img.bitmap.height !== sidecar.height) {
      throw new Error(`${path.basename(p)} is ${img.bitmap.width}x${img.bitmap.height}, sidecar says ${sidecar.width}x${sidecar.height}`);
    }
  }

  const posted = await postedCrop(framePath, win, path.join(MEDIA_DIR, "ST-V2-posted.png"));
  const coverPosted = await postedCrop(coverPath, win, path.join(MEDIA_DIR, "ST-V2-cover-posted.png"));
  const wantW = Math.round(win.x1 - win.x0);
  if (posted.width !== wantW || coverPosted.width !== wantW) {
    throw new Error("posted crops do not match the sidecar's posted crop window");
  }
  console.log(
    `ST-V2 frames written: frame @7.5s, cover @${handsMid}s (hands-up window ${sidecar.handsUpSeconds[0]}-${sidecar.handsUpSeconds[1]}s), posted crops ${posted.width}x${posted.height}`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
