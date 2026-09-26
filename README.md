# Kundli PDF to Hindi audio

One text-based kundli PDF in, one single-voice Hindi MP3 out. The CLI extracts PDF text, builds page-linked facts, plans the episode from the whole report (GPT-6 Luna only), writes a Hindi narration, calls Sarvam Bulbul v3 for speech, and joins the audio with FFmpeg. It uses OpenAI's GPT-6 Luna for the text steps by default, or Sarvam-105B with `--llm sarvam`.

PDF text is sent to OpenAI's API (or Sarvam's with `--llm sarvam`), and the generated narration is sent to Sarvam's API for speech. Do not use this cloud workflow for a private report without the owner's consent.

## Run

Requires Node.js 22.13+ **or** Bun, FFmpeg on `PATH`, an OpenAI API key, and a Sarvam API key. The PDF must contain selectable text; scanned PDFs need OCR first.

```powershell
npm.cmd install
npm.cmd start -- "suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf" "kundli-hindi.mp3"
```

Put `OPENAI_API_KEY=your-key` and `SARVAM_API_KEY=your-key` on separate lines in `.env` in this directory. The start command loads it automatically; an existing environment variable also works. `.env` is git-ignored.

To try the first planned section (about four minutes) before generating the full report:

```powershell
npm.cmd start -- "suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf" "kundli-preview.mp3" --preview
```

Preview mode processes only that section's chapters. Every run saves a Hindi script beside the MP3 (`kundli-preview.txt` or `kundli-hindi.txt`) so you can review it. Actual audio length depends on the generated text and speech pacing. Use a separate output name for the full report. Completed source batches and sections are saved in an ignored `<output.mp3>.work` directory so a failed run can resume. Changing the text model, extraction prompt, or narration prompt regenerates the affected text automatically; delete that directory if you want fresh text anyway.

To write the script with Sarvam-105B instead of GPT-6 Luna, add `--llm sarvam`; the OpenAI key is then not needed. Use a different output name to compare the two:

```powershell
npm.cmd start -- "suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf" "kundli-preview-sarvam.mp3" --preview --llm sarvam
```

With Bun, use `bun install` and `bun src/cli.ts <report.pdf> <output.mp3>` instead. The CLI creates an MP3 only after every extraction, narration, and synthesis step succeeds. An existing output remains intact on failure.

## Checks

```powershell
npm.cmd run typecheck
npm.cmd test
bun test
```

The script aims for roughly 30 minutes, but actual duration depends on narration and speech pacing. Page-quote checks and chapter coverage reduce unsupported claims; they cannot guarantee that every detail in a long PDF survives a 30-minute summary. Review the final audio before relying on it. No live Sarvam call is included in the local tests.
