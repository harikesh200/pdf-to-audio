import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractPdf } from '../src/pdf.ts';
import { PAUSE_SECONDS, renderMp3, silenceLike, splitNarration } from '../src/audio.ts';
import { acceptFacts, planSections, sourceUnits, spokenChapters } from '../src/source.ts';

test('extracts the sample report into traceable chapters and source batches', async () => {
  const document = await extractPdf(new URL('../suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf', import.meta.url));
  assert.equal(document.pages.length, 110);
  assert.equal(document.chapters.length, 48);
  assert.equal(spokenChapters(document.chapters).length, 47);
  assert.ok(sourceUnits(document.pages, document.chapters).length > 0);
  assert.equal(planSections(document.chapters).length, 8);
});

test('source batches can be limited to the first preview section', async () => {
  const document = await extractPdf(new URL('../suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf', import.meta.url));
  const section = planSections(document.chapters)[0];
  assert.ok(section);
  const chapters = spokenChapters(document.chapters).filter((chapter) =>
    chapter.number >= section.first && chapter.number <= section.last,
  );
  const units = sourceUnits(document.pages, chapters);
  assert.ok(units.length > 0);
  assert.ok(units.flat().every((page) =>
    page.chapter >= section.first && page.chapter <= section.last,
  ));
  assert.ok(units.flat().length < sourceUnits(document.pages, document.chapters).flat().length);
});

test('accepts only facts with a quote on the stated page', () => {
  const unit = [{ page: 2, chapter: 1, title: 'Birth', text: 'Birth date is 24 September 2026.' }];
  const valid = { page: 2, chapter: 1, quote: '24 September 2026', hindi: 'जन्म तारीख 24 सितंबर 2026 है।' };
  assert.equal(acceptFacts([valid], unit, 1)[0]?.id, 'F0001');
  assert.throws(() => acceptFacts([{ ...valid, page: 3 }], unit, 1));
  assert.deepEqual(acceptFacts([{ ...valid, quote: '31 December 2025' }], unit, 1), []);
});

test('corrects a fact page when its quote uniquely matches another page in the chapter', () => {
  const unit = [
    { page: 5, chapter: 2, title: 'Birth', text: 'Date of birth is 7th Oct 2001.' },
    { page: 6, chapter: 2, title: 'Birth', text: 'Panchang details follow.' },
  ];
  const fact = { page: 6, chapter: 2, quote: '7th Oct 2001', hindi: 'जन्म तारीख 7 अक्टूबर 2001 है।' };
  assert.equal(acceptFacts([fact], unit, 1)[0]?.page, 5);
});

test('splits Hindi sentences without crossing the TTS character cap', () => {
  const segments = splitNarration(['पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।'], 25);
  assert.ok(segments.every((segment) => segment.text.length <= 25));
  assert.equal(segments.map((segment) => segment.text).join(' '), 'पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।');
  assert.deepEqual(segments.map((segment) => segment.pauseAfter), [PAUSE_SECONDS.chunk, 0]);
});

test('turns thinking marks, paragraphs, and sections into pauses', () => {
  assert.deepEqual(splitNarration(['पहला विचार? [विराम] दूसरा विचार।\n\nतीसरा। [विराम]\n\nचौथा।', 'नया हिस्सा।']), [
    { text: 'पहला विचार?', pauseAfter: PAUSE_SECONDS.thinking },
    { text: 'दूसरा विचार।', pauseAfter: PAUSE_SECONDS.paragraph },
    { text: 'तीसरा।', pauseAfter: PAUSE_SECONDS.thinking },
    { text: 'चौथा।', pauseAfter: PAUSE_SECONDS.section },
    { text: 'नया हिस्सा।', pauseAfter: 0 },
  ]);
});

test('keeps an existing MP3 untouched if synthesis fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kundli-test-'));
  const output = join(directory, 'output.mp3');
  try {
    await writeFile(output, 'previous audio');
    await assert.rejects(renderMp3([{ text: 'नमस्ते।', pauseAfter: 0 }], async () => { throw new Error('upstream failed'); }, output));
    assert.equal((await readFile(output)).toString(), 'previous audio');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('renders multiple WAV chunks into one MP3', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kundli-test-'));
  const output = join(directory, 'output.mp3');
  const samples = Buffer.alloc(2_400 * 2);
  const wav = Buffer.alloc(44 + samples.length);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(samples.length, 40);
  samples.copy(wav, 44);
  try {
    await renderMp3([{ text: 'पहला।', pauseAfter: 0.5 }, { text: 'दूसरा।', pauseAfter: 0 }], async () => wav, output);
    const mp3 = await readFile(output);
    assert.ok(mp3.length > 100);
    assert.equal(mp3.toString('ascii', 0, 3), 'ID3');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('builds silence in the same WAV format as the speech audio', () => {
  const wav = Buffer.alloc(44);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  const silence = silenceLike(wav, 0.5);
  assert.equal(silence.subarray(12, 36).compare(wav.subarray(12, 36)), 0);
  assert.equal(silence.toString('ascii', 36, 40), 'data');
  assert.equal(silence.readUInt32LE(40), 24_000);
  assert.equal(silence.length, 44 + 24_000);
  assert.ok(silence.subarray(44).every((byte) => byte === 0));
  assert.throws(() => silenceLike(Buffer.from('RIFF0000WAVE'), 1));
});
