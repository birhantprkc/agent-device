import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { WebDriverTransport } from './webdriver-transport.ts';

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

test('cancels a retry delay when the request binding aborts', async () => {
  const controller = new AbortController();
  const transport = new WebDriverTransport({
    clientVersion: '0.0.0-test',
    endpoint: 'http://cloud-webdriver.test/wd/hub/',
    requestPolicy: { timeoutMs: 30_000, retryAttempts: 1, retryDelayMs: 10_000 },
  });
  let calls = 0;
  let firstRequestObserved!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    firstRequestObserved = resolve;
  });
  globalThis.fetch = async () => {
    calls += 1;
    firstRequestObserved();
    return new Response(JSON.stringify({ value: { message: 'grid unavailable' } }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  const pending = transport.requestValue('GET', '/session/wd-1/source', undefined, {
    signal: controller.signal,
  });
  await firstRequest;
  // Let the failed response enter the retry sleep; aborting before retry policy
  // sees the 503 correctly preserves that primary transport failure instead.
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort(new Error('request cancelled during WebDriver retry'));

  await assert.rejects(pending, /abort|cancel/i);
  assert.equal(calls, 1);
});
