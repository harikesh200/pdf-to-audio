import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cached, cachedBuffer } from '../src/cache.ts';

test('reuses completed work and refreshes it when input changes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kundli-cache-test-'));
  const path = join(directory, 'batch.json');
  let calls = 0;
  const generate = async () => ++calls;
  try {
    assert.equal(await cached(path, { page: 1 }, generate), 1);
    assert.equal(await cached(path, { page: 1 }, generate), 1);
    assert.equal(await cached(path, { page: 2 }, generate), 2);
    assert.equal(calls, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reuses saved audio and regenerates missing or invalid files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'kundli-cache-test-'));
  let calls = 0;
  const generate = async () => Buffer.from(`RIFF-${++calls}`);
  const isValid = (data: Buffer) => data.toString('ascii', 0, 4) === 'RIFF';
  try {
    const first = await cachedBuffer(directory, { text: 'एक' }, generate, isValid);
    const again = await cachedBuffer(directory, { text: 'एक' }, generate, isValid);
    const other = await cachedBuffer(directory, { text: 'दो' }, generate, isValid);
    assert.deepEqual([first.reused, again.reused, other.reused], [false, true, false]);
    assert.equal(again.data.toString(), 'RIFF-1');
    assert.equal(calls, 2);
    const [name] = (await readdir(directory)).sort();
    await writeFile(join(directory, name ?? ''), 'broken');
    const repaired = await cachedBuffer(directory, { text: 'एक' }, generate, isValid);
    const repairedOther = await cachedBuffer(directory, { text: 'दो' }, generate, isValid);
    assert.equal([repaired, repairedOther].filter((result) => !result.reused).length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
