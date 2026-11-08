# Pre-Flight

A pre-publish check for blind and DeafBlind creators, built during the Meta Global AI Developer Hackathon (October 26 – November 4, 2026), Indie track, theme: Build for Your World.

The idea and the design were discussed beforehand. Every line of code in this repository was written during the hackathon.

## What it does

Before a blind creator posts a photo or a short video, Pre-Flight runs six checks inside a simulated Instagram composer and reports each one — in plain text a screen reader and a braille display read directly — as pass, fix, or uncertain:

1. Framing — is the subject in the shot, and where?
2. Crop safety — would the platform's crop cut the subject, or text the creator means to show? Private items are not counted here; the privacy warning and its removal repair handle those.
3. Sharpness and quality — is the take usable?
4. Text in the image — what does any visible text say, and is it legible?
5. First impression — what does a sighted viewer see first?
6. Audio — what does the take sound like?

Alongside any verdict it can produce, a named private-information warning flags anything in the take that looks private (a readable address, a document, a screen notification) before the creator posts it publicly.

Visitors can also run the whole flow on a photo of their own: pick a photo and the same six checks run on it live, then the repairs those verdicts offer, the proof copy and alt text, and a share step — the seeded flow, on the visitor's own photo. The browser converts the photo to PNG and sends it to the backend, which keeps a working copy only while the creator works with it — the copy is deleted within two hours, and the page says exactly that. A supplied photo has no recorded facts and no stated intent, so its framing and crop safety are measured from SAM 3.1's boxes or the judgement tier's estimate, and read uncertain when neither can locate the subject: there is no record to fall back to.

The creator then gets two things in their own words to approve: alt text drafted from their own stated intent for the post, and proof copy — a speech-and-braille-ready text version of what they are about to publish. An optional public description for the audience can be approved the same way; for a video it is timestamped, assembled from the take's recorded timeline — the same recorded facts its described-audio script is drafted from. Deterministic problems get deterministic repairs (re-crop, re-frame suggestions), the checks run again, and nothing is ever published, attached, or marked approved that the creator has not approved themselves.

## Bringing a post to Pre-Flight

Pre-Flight cannot step inside Facebook or Instagram while a creator composes: those apps offer no pre-post doorway to outside apps, and the phone's sandbox keeps each app's contents to itself. The supported meeting point is the sharing step, and the app now stands there three ways:

- Share to Pre-Flight (installed web app). The app is installable (manifest + service worker). On Android and other browsers that put installed web apps in the Share sheet, Pre-Flight appears as a Share choice for photos: the shared photo arrives at POST /share-target, is converted to the PNG the pipeline reads and reduced to the upload cap when needed, and opens an ordinary upload session — the "Check your own photo" flow, already checked. A shared link is never fetched (a link is not the original photo, and fetching arbitrary URLs would be its own risk); a shared video is named as out of scope for the own-media flow, whose video checks run on the seeded take. Both cases land on plain sentences in the app, never silence.
- Start in Pre-Flight, share onward. The existing end-of-flow Share step sends the checked photo (or take still) and its approved alt text onward through the device's share sheet, where Facebook and Instagram appear when installed.
- A posting prompt on iPhone and iPad. Apple gives web apps no Share-sheet place, so the app carries exact steps for a Shortcuts automation — when Facebook or Instagram opens, show "Posting? Run Pre-Flight first" and open Pre-Flight. It is a nudge at the door; it cannot see what is picked inside Meta's apps, and the app says so.

## How it is built

- The checks run through the Meta Model API, called from a small backend that holds the API key in its secrets. The key never appears in this repository or in any client. Each model does the part the design assigns it:
  - SAM 3.1 locates the subject and the sign in a take, and framing and crop safety are measured from its boxes. When SAM returns no match in a take, the judgement tier estimates the boxes, and the take's recorded facts stand only when judgement cannot supply them either — the response says which source was used; a failed SAM call makes those checks uncertain, never guessed. Sharpness and quality are measured from the pixels directly. The fallback order for those measurements is: SAM 3.1's boxes first; then the judgement tier's estimate — Muse Wonder, falling back to Muse Spark 1.3-contributor when Wonder is unavailable or its reply cannot be trusted — labelled as judgement in the response; and the take's recorded facts last, where a take has them.
  - Muse Wonder judges the text in the image, the first impression, and the private-information warning, falling back to Muse Spark 1.3-contributor when Wonder is unavailable or its reply cannot be trusted.
  - Muse Voice Transcribe transcribes a video's speech track, and the audio check is judged from the transcript. A silent take reports that there is nothing to transcribe, because the silence is part of the take.
  - A described-audio script for a video is drafted from the take's recorded timeline — by Muse Wonder when live calls are on, with the same Muse Spark 1.3-contributor fallback, assembled from the recorded facts when they are off — and stays a draft until the creator approves it.
  - Repairs are deterministic operations the app performs itself (re-crop, reframe, exposure, cover-frame composition — the chosen moment fitted to the post with the subject centred in the frame — and an opaque cover painted over the private item a warning names, when its region is located). No generative model edits the media, and Muse Image is not used in this build.
- Data terms, stated plainly: every model call runs on standard API data terms except one — the judgement fallback, Muse Spark 1.3-contributor, runs in Contributor mode, under which Meta may use prompts and completions for training. That fallback fires only when Muse Wonder is unavailable or its reply cannot be trusted; the primary judgement model and all other calls stay on standard terms.
- Accessibility is the requirement, not a feature: every flow completes with a screen reader and braille display alone, every status exists as plain text, and "uncertain" is always an allowed answer — the app never guesses a pass.

## Team

Digital Dragons

Team Members: the Nexus System (Nicholas A Abrahamson, applicant of record), the Prism System, and Wren Popplestone.
