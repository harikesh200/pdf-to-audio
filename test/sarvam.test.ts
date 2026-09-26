import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { OpenAI } from '../src/openai.ts';
import { Sarvam } from '../src/sarvam.ts';
import { planEpisode, ScriptRejected, writeSection } from '../src/script.ts';
import type { TextModel } from '../src/script.ts';

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
      model: 'bulbul:v3', pace: 0.85, temperature: 0.75,
      speech_sample_rate: 24_000, output_audio_codec: 'wav',
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('narration may omit low-value facts while covering every chapter', async () => {
  const client: TextModel = { id: 'test-model', readsWholeReport: false, chat: async () => ({}) };
  const facts = [
    { id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' },
    { id: 'F0002', chapter: 1, page: 4, quote: 'extra', hindi: 'अतिरिक्त तथ्य' },
    { id: 'F0003', chapter: 2, page: 5, quote: 'second', hindi: 'दूसरा तथ्य' },
  ];
  const section = { title: 'नमूना', first: 1, last: 2, minutes: 2 };
  client.chat = async () => ({ paragraphs: ['पहला तथ्य।', 'दूसरा तथ्य।'], covered_ids: ['F0001', 'F0003'] });
  assert.equal(await writeSection(client, section, facts, ''), 'पहला तथ्य।\n\nदूसरा तथ्य।');
  client.chat = async () => ({ paragraphs: ['पहला तथ्य।'], covered_ids: ['F0001'] });
  await assert.rejects(writeSection(client, section, facts, ''));
});

test('narration request frames the opening and closing parts', async () => {
  const client: TextModel = { id: 'test-model', readsWholeReport: false, chat: async () => ({}) };
  const facts = [{ id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' }];
  const section = { title: 'नमूना', first: 1, last: 1, minutes: 2 };
  const requests: string[] = [];
  client.chat = async (_task, _system, user) => {
    requests.push(user);
    return { paragraphs: ['पहला तथ्य।', 'और बात।'], covered_ids: ['F0001'] };
  };
  await writeSection(client, section, facts, '', 0, 3);
  await writeSection(client, section, facts, '', 2, 3);
  assert.match(requests[0] ?? '', /part 1 of 3\. Open with a concrete everyday scene/);
  assert.match(requests[0] ?? '', /without summarising/);
  assert.match(requests[1] ?? '', /short spoken bridge/);
  assert.match(requests[1] ?? '', /overall message/);
});

test('asks GPT-6 Luna for strict JSON without temperature', async () => {
  let requestBody: Record<string, unknown> = {};
  let authorization: string | undefined;
  const server = createServer(async (request, response) => {
    authorization = request.headers.authorization;
    requestBody = JSON.parse(await new Promise<string>((resolve) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => resolve(body));
    }));
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}', refusal: null }, finish_reason: 'stop' }] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const client = new OpenAI('test-key', `http://127.0.0.1:${address.port}`);
    assert.deepEqual(await client.chat('narrate', 'system', 'user', { type: 'object' }, 'sample'), { ok: true });
    assert.equal(authorization, 'Bearer test-key');
    assert.equal(requestBody.model, 'gpt-6-luna');
    assert.equal(requestBody.reasoning_effort, 'medium');
    assert.equal(requestBody.max_completion_tokens, 32_000);
    assert.equal('temperature' in requestBody, false);
    assert.deepEqual(requestBody.response_format, {
      type: 'json_schema',
      json_schema: { name: 'sample', strict: true, schema: { type: 'object' } },
    });
  } finally {
    server.close();
    await once(server, 'close');
  }
});

test('rejects narration that reads fact IDs aloud', async () => {
  const client: TextModel = {
    id: 'test-model',
    readsWholeReport: false,
    chat: async () => ({ paragraphs: ['F0001 के अनुसार पहला तथ्य।', 'और बात।'], covered_ids: ['F0001'] }),
  };
  const facts = [{ id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' }];
  await assert.rejects(writeSection(client, { title: 'नमूना', first: 1, last: 1, minutes: 2 }, facts, ''), ScriptRejected);
});

test('later sections see earlier narration for continuity', async () => {
  const requests: string[] = [];
  const client: TextModel = {
    id: 'test-model',
    readsWholeReport: false,
    chat: async (_task, _system, user) => {
      requests.push(user);
      return { paragraphs: ['पहला तथ्य।', 'और बात।'], covered_ids: ['F0001'] };
    },
  };
  const facts = [{ id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' }];
  const section = { title: 'नमूना', first: 1, last: 1, minutes: 2 };
  await writeSection(client, section, facts, '', 0, 2);
  await writeSection(client, section, facts, '', 1, 2, 'पिछला हिस्सा।');
  assert.doesNotMatch(requests[0] ?? '', /Earlier parts of this episode/);
  assert.match(requests[1] ?? '', /Earlier parts of this episode[^\n]*\nपिछला हिस्सा।/);
});

test('episode plan keeps only verified evidence and remaps threads', async () => {
  const pages = [
    { page: 4, chapter: 1, title: 'Intro', text: 'Your Moon seeks a quiet room when life is loud.' },
    { page: 9, chapter: 3, title: 'Timing', text: 'Rahu period asks for patience with new structures.' },
  ];
  const sections = [
    { title: 'पहला', first: 1, last: 2, minutes: 2 },
    { title: 'दूसरा', first: 3, last: 3, minutes: 2 },
  ];
  const evidence = (page: number, chapter: number, quote: string) => ({ page, chapter, quote, hindi: 'हिंदी अर्थ' });
  const plan = {
    arc: 'arc',
    threads: [
      { name: 'गढ़ा हुआ', summary: 'invented', evidence: [evidence(4, 1, 'a line that is not in the report')] },
      { name: 'सुकून', summary: 'quiet', evidence: [evidence(4, 1, 'seeks a quiet room'), evidence(7, 1, 'missing page')] },
      { name: 'समय', summary: 'timing', evidence: [evidence(9, 3, 'asks for patience')] },
    ],
    sections: [
      { section: 2, focus: 'second', threads: [3] },
      { section: 1, focus: 'first', threads: [1, 2, 3] },
    ],
  };
  const model: TextModel = { id: 'test-model', readsWholeReport: true, chat: async () => plan };
  const result = await planEpisode(model, pages, sections, '');
  assert.deepEqual(result.threads.map((thread) => thread.name), ['सुकून', 'समय']);
  assert.deepEqual(result.threads[0]?.evidence.map((item) => item.quote), ['seeks a quiet room']);
  assert.deepEqual(result.sections, [
    { focus: 'first', threads: [0, 1] },
    { focus: 'second', threads: [1] },
  ]);
  model.chat = async () => ({ ...plan, sections: [plan.sections[1]] });
  await assert.rejects(planEpisode(model, pages, sections, ''), ScriptRejected);
});

test('narration can cite connecting facts from the episode plan', async () => {
  const requests: string[] = [];
  const client: TextModel = {
    id: 'test-model',
    readsWholeReport: true,
    chat: async (_task, _system, user) => {
      requests.push(user);
      return { paragraphs: ['पहला तथ्य।', 'जुड़ी बात।'], covered_ids: ['F0001', 'F0002'] };
    },
  };
  const facts = [{ id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' }];
  const guide = {
    arc: 'the arc',
    focus: 'build the quiet-room thread',
    threads: [{ name: 'सुकून', summary: 'quiet' }],
    evidence: [{ id: 'F0002', chapter: 9, page: 30, quote: 'later', hindi: 'बाद का तथ्य' }],
  };
  await writeSection(client, { title: 'नमूना', first: 1, last: 1, minutes: 2 }, facts, '', 0, 1, '', guide);
  assert.match(requests[0] ?? '', /This part's focus: build the quiet-room thread/);
  assert.match(requests[0] ?? '', /F0002 \| chapter 9 \| PDF p\.30 \| बाद का तथ्य/);
});

test('with an episode plan, narration may skip chapters but must cite something', async () => {
  const facts = [
    { id: 'F0001', chapter: 1, page: 4, quote: 'first', hindi: 'पहला तथ्य' },
    { id: 'F0002', chapter: 2, page: 5, quote: 'second', hindi: 'दूसरा तथ्य' },
  ];
  const guide = { arc: 'arc', focus: 'focus', threads: [], evidence: [] };
  const section = { title: 'नमूना', first: 1, last: 2, minutes: 2 };
  const client: TextModel = {
    id: 'test-model',
    readsWholeReport: true,
    chat: async () => ({ paragraphs: ['पहला तथ्य। (विराम) सोचिए।', 'और बात।'], covered_ids: ['F0001'] }),
  };
  assert.equal(await writeSection(client, section, facts, '', 0, 1, '', guide), 'पहला तथ्य। [विराम] सोचिए।\n\nऔर बात।');
  client.chat = async () => ({ paragraphs: ['पहला तथ्य।', 'और बात।'], covered_ids: [] });
  await assert.rejects(writeSection(client, section, facts, '', 0, 1, '', guide), ScriptRejected);
  client.chat = async () => ({ paragraphs: ['[मुस्कुराते हुए] पहला तथ्य।', 'और बात।'], covered_ids: ['F0001'] });
  await assert.rejects(writeSection(client, section, facts, '', 0, 1, '', guide), ScriptRejected);
});
