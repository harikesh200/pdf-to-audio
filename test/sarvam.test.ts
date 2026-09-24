import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { Sarvam } from '../src/sarvam.ts';

test('sends Hindi single-voice TTS request and decodes WAV', async () => {
  let requestBody: unknown;
  let requestKey: string | string[] | undefined;
  const server = createServer(async (request, response) => {
    requestKey = request.headers['api-subscription-key'];
    requestBody = JSON.parse(await new Promise<string>((resolve) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => resolve(body));
    }));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ audios: [Buffer.from('RIFF0000WAVE').toString('base64')] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new Sarvam('test-key', `http://127.0.0.1:${address.port}`);
    assert.equal((await client.synthesize('नमस्ते।')).toString(), 'RIFF0000WAVE');
    assert.equal(requestKey, 'test-key');
    assert.deepEqual(requestBody, {
      text: 'नमस्ते।', language_code: 'hi-IN', speaker: 'shubh',
      model: 'bulbul:v3', pace: 0.9, temperature: 0.6,
      speech_sample_rate: 24_000, output_audio_codec: 'wav',
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});
