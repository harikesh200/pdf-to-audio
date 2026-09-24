import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { extractPdf } from '../src/pdf.ts';
import { renderMp3, splitNarration } from '../src/audio.ts';
import { acceptFacts, planSections, sourceUnits, spokenChapters } from '../src/source.ts';

test('extracts the sample report into traceable chapters and source batches', async () => {
  const document = await extractPdf(new URL('../suraksha-sutra-kundli-harikesh-mishra-2026-09-24.pdf', import.meta.url));
  assert.equal(document.pages.length, 110);
  assert.equal(document.chapters.length, 48);
  assert.equal(spokenChapters(document.chapters).length, 47);
  assert.ok(sourceUnits(document.pages, document.chapters).length > 0);
  assert.equal(planSections(document.chapters).length, 8);
});

test('accepts only facts with a quote on the stated page', () => {
  const unit = [{ page: 2, chapter: 1, title: 'Birth', text: 'Birth date is 24 September 2026.' }];
  const valid = { page: 2, chapter: 1, quote: '24 September 2026', hindi: 'जन्म तारीख 24 सितंबर 2026 है।' };
  assert.equal(acceptFacts([valid], unit, 1)[0]?.id, 'F0001');
  assert.throws(() => acceptFacts([{ ...valid, page: 3 }], unit, 1));
  assert.throws(() => acceptFacts([{ ...valid, quote: '31 December 2025' }], unit, 1));
});

test('splits Hindi sentences without crossing the TTS character cap', () => {
  const chunks = splitNarration('पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।', 25);
  assert.ok(chunks.every((chunk) => chunk.length <= 25));
  assert.equal(chunks.join(' '), 'पहला वाक्य। दूसरा वाक्य। तीसरा वाक्य।');
});

test('keeps an existing MP3 untouched if synthesis fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kundli-test-'));
  const output = join(directory, 'output.mp3');
  try {
    await writeFile(output, 'previous audio');
    await assert.rejects(renderMp3(['नमस्ते।'], async () => { throw new Error('upstream failed'); }, output));
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
    await renderMp3(['पहला।', 'दूसरा।'], async () => wav, output);
    const mp3 = await readFile(output);
    assert.ok(mp3.length > 100);
    assert.equal(mp3.toString('ascii', 0, 3), 'ID3');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
