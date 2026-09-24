# Kundli PDF to Hindi audio

One text-based kundli PDF in, one single-voice Hindi MP3 out. The CLI extracts PDF text, builds page-linked facts, writes a Hindi narration, calls Sarvam Bulbul v3 for speech, and joins the audio with FFmpeg. It uses Sarvam-105B for the text steps.

PDF text and generated narration are sent to Sarvam's API. Do not use this cloud workflow for a private report without the owner's consent.

## Run

Requires Node.js 22.13+ **or** Bun, FFmpeg on `PATH`, and a Sarvam API key. The PDF must contain selectable text; scanned PDFs need OCR first.

```powershell
npm install
$env:SARVAM_API_KEY = "your-key"
npm start -- "suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf" "kundli-hindi.mp3"
```

With Bun, use `bun install` and `bun src/cli.ts <report.pdf> <output.mp3>` instead. The CLI creates an MP3 only after every extraction, narration, and synthesis step succeeds. An existing output remains intact on failure.

## Checks

```powershell
npm run typecheck
npm test
bun test
```

The script aims for roughly 30 minutes, but actual duration depends on narration and speech pacing. Page-quote checks and chapter coverage reduce unsupported claims; they cannot guarantee that every detail in a long PDF survives a 30-minute summary. Review the final audio before relying on it. No live Sarvam call is included in the local tests.
