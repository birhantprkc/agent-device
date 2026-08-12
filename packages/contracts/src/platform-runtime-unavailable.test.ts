import assert from 'node:assert/strict';
import { test } from 'vitest';
import { localRuntimeOwner, providerRuntimeOwner } from './platform-runtime.ts';
import { applicationLifecycleOperationFacts } from './application-lifecycle-runtime.ts';
import {
  createUnavailablePlatformRuntimeBinding,
  createUnavailablePlatformRuntimeOwner,
} from './platform-runtime-unavailable.ts';

const device = {
  id: 'linux-host',
  name: 'Linux host',
  platform: 'linux',
  kind: 'device',
  state: 'booted',
} as const;

const scope = {
  signal: new AbortController().signal,
  diagnostics: { emit: () => undefined },
  progress: { report: () => undefined },
};
const lifecycle = applicationLifecycleOperationFacts({
  resolveOpenTarget: { available: false, reason: 'unsupported-platform-leaf' },
  prepareApplicationOpen: { available: false, reason: 'unsupported-platform-leaf' },
  openApplication: { available: false, reason: 'unsupported-platform-leaf' },
  applyRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
  clearRuntimeHints: { available: false, reason: 'unsupported-platform-leaf' },
  closeApplication: { available: false, reason: 'unsupported-platform-leaf' },
  finalizeApplicationClose: { available: false, reason: 'unsupported-platform-leaf' },
  prepareAppleRunner: { available: false, reason: 'unsupported-platform-leaf' },
  configureProviderPortReverse: { available: false, reason: 'unsupported-platform-leaf' },
});

test('builds one complete combined unavailable owner without fake operations', async () => {
  const owner = createUnavailablePlatformRuntimeOwner('linux', {
    appLog: { available: false, reason: 'unsupported-platform-leaf' },
    network: { available: false, reason: 'owner-capability-missing' },
    lifecycle,
  });
  const binding = await owner.bind({ device, intent: { kind: 'ordinary' }, scope });

  assert.deepEqual(Object.keys(binding.facts.operations).sort(), [
    'appLogCleanup',
    'appLogDoctor',
    'appLogInspect',
    'appLogReattach',
    'appLogStart',
    'appState',
    'applyRuntimeHints',
    'bootTarget',
    'bootTargetHeadless',
    'clearRuntimeHints',
    'closeApplication',
    'configureProviderPortReverse',
    'deployApp',
    'deployMaterializedApp',
    'ensureReady',
    'finalizeApplicationClose',
    'listApps',
    'materializeAppSource',
    'networkDump',
    'openApplication',
    'prepareAppleRunner',
    'prepareApplicationOpen',
    'resolveOpenTarget',
    'screenRecordingCleanup',
    'screenRecordingReattach',
    'screenRecordingStart',
    'sendPushNotification',
    'shutdownTarget',
  ]);
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});

test('rejects a planted wrong exact owner before producing a binding', async () => {
  const owner = createUnavailablePlatformRuntimeOwner('linux', {
    appLog: { available: false, reason: 'unsupported-platform-leaf' },
    network: { available: false, reason: 'unsupported-platform-leaf' },
    lifecycle,
  });
  await assert.rejects(
    owner.bind({
      device,
      intent: {
        kind: 'exact-owner',
        owner: localRuntimeOwner('vega'),
        fence: { token: 'token', generation: 1 },
      },
      scope,
    }),
    /identity does not match/,
  );
});

test('generic unavailable binding preserves exact provider ownership and mode', async () => {
  const owner = providerRuntimeOwner('webdriver', 'tenant-a');
  const binding = createUnavailablePlatformRuntimeBinding(device, owner, {
    appLog: { available: false, reason: 'unsupported-provider-mode' },
    network: { available: false, reason: 'owner-capability-missing' },
    lifecycle,
  });

  assert.equal(binding.owner, owner);
  assert.equal(binding.facts.device.providerMode, 'provider-runtime');
  assert.deepEqual(binding.operations, {});
  await binding[Symbol.asyncDispose]();
});
