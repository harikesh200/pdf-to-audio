import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatUsage } from '../src/http.ts';
import { UsageLog } from '../src/usage.ts';

test('reads OpenAI-style token usage including cached and reasoning tokens', () => {
  assert.deepEqual(chatUsage({
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 400,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens_details: { reasoning_tokens: 300 },
    },
  }), { input: 1_000, cachedInput: 200, output: 400, reasoning: 300 });
  assert.equal(chatUsage({ choices: [] }), undefined);
});

test('prices chat tokens and speech characters per provider currency', () => {
  const usage = new UsageLog();
  usage.recordChat('gpt-6-luna', { input: 2_000_000, cachedInput: 1_000_000, output: 1_000_000, reasoning: 600_000 });
  usage.recordChat('gpt-6-luna', undefined);
  usage.recordSpeech(10_000);
  usage.recordSpeech(5_000);
  const summary = usage.summary();
  // 1M uncached × $0.10 + 1M cached × $0.01 + 1M output × $0.50 = $0.61
  assert.match(summary, /gpt-6-luna: 2 calls, .* = \$0\.6100; 1 calls reported no usage/);
  assert.match(summary, /Sarvam Bulbul v3: 2 requests, 15,000 characters = ₹45\.00/);
  assert.match(summary, /Total: \$0\.6100 \+ ₹45\.00/);
  assert.equal(new UsageLog().summary(), '');
});
