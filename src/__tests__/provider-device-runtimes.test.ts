import assert from 'node:assert/strict';
import { test } from 'vitest';
import { createDefaultProviderRuntimeComposition } from '../provider-device-runtimes.ts';

test('default provider runtimes skip Limrun when only the removed API key alias is configured', async () => {
  const { runtimes, platformModules } = await createDefaultProviderRuntimeComposition({
    LIM_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    false,
  );
  assert.deepEqual(
    platformModules.map((registration) => registration.runtime),
    runtimes,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});

test('default provider runtimes load Limrun when a Limrun API key is configured', async () => {
  const { runtimes, platformModules } = await createDefaultProviderRuntimeComposition({
    LIMRUN_API_KEY: 'lim_test_key',
  });

  assert.equal(
    runtimes.some((runtime) => runtime.provider === 'limrun'),
    true,
  );
  const limrun = runtimes.find((runtime) => runtime.provider === 'limrun');
  assert.equal(limrun ? 'loadRuntime' in limrun : true, false);
  assert.equal(platformModules.length, runtimes.length);
  assert.equal(
    platformModules.find((registration) => registration.runtime === limrun)?.runtime,
    limrun,
  );
  await Promise.all(runtimes.map(async (runtime) => await runtime.shutdown()));
});
