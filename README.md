# Blind Creator Pre-Flight

A pre-publish check for blind and DeafBlind creators, built during the Meta Global AI Developer Hackathon (October 26 – November 4, 2026), Indie track, theme: Build for Your World.

The idea and the design were discussed beforehand. Every line of code in this repository was written during the hackathon.

## What it does

Before a blind creator posts a photo or a short video, Pre-Flight runs six checks inside a simulated Instagram composer and reports each one — in plain text a screen reader and a braille display read directly — as pass, fix, or uncertain:

1. Framing — is the subject in the shot, and where?
2. Crop safety — would the platform's crop cut anything that matters?
3. Sharpness and quality — is the take usable?
4. Text in the image — what does any visible text say, and is it legible?
5. First impression — what does a sighted viewer see first?
6. Audio — what does the take sound like?

Alongside any verdict it can produce, a named private-information warning flags anything in the take that looks private (a readable address, a document, a screen notification) before the creator posts it publicly.

The creator then gets two things in their own words to approve: alt text drafted from their own stated intent for the post, and proof copy — a speech-and-braille-ready text version of what they are about to publish. Deterministic problems get deterministic repairs (re-crop, re-frame suggestions), the checks run again, and nothing is ever published, attached, or marked approved that the creator has not approved themselves.

## How it is built

- Checks are computed through the Meta Model API (Muse Spark, SAM 3.1, Muse Voice Transcribe, Muse Image for generative repairs only), called from a small backend that holds the API key in its secrets. The key never appears in this repository or in any client.
- Standard API data terms only. The discounted contributor tier, which permits training on prompts and completions, is never used.
- Accessibility is the requirement, not a feature: every flow completes with a screen reader and braille display alone, every status exists as plain text, and "uncertain" is always an allowed answer — the app never guesses a pass.

## Team

Created by the Nexus System (Nicholas A Abrahamson, applicant of record), with Wren, their assistant, building alongside them during the event.
