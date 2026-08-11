import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { shutdownTargetUse } from '@agent-device/contracts/platform';
import { commandDescriptors } from '../registry.ts';

const sessionStateSource = readFileSync(
  new URL('../../../daemon/handlers/session-state.ts', import.meta.url),
  'utf8',
);
const sessionCloseSource = readFileSync(
  new URL('../../../daemon/handlers/session-close.ts', import.meta.url),
  'utf8',
);
const closeAdapterSource = readFileSync(
  new URL('../../../daemon/session-close-shutdown.ts', import.meta.url),
  'utf8',
);
const sharedHostSource = readFileSync(
  new URL('../../../platform-runtime-device-shutdown-host.ts', import.meta.url),
  'utf8',
);

test('shutdown descriptor declares one canonical runtime operation', () => {
  const shutdown = commandDescriptors.find(({ name }) => name === 'shutdown');

  expect(shutdown).not.toHaveProperty('capability');
  expect(shutdown?.platformExecution).toEqual({
    kind: 'device-runtime',
    use: shutdownTargetUse,
  });
});

test('canonical shutdown and close parity share one concrete teardown mechanic', () => {
  const shutdownRoute = sessionStateSource.slice(
    sessionStateSource.indexOf("if (req.command === 'shutdown')"),
  );
  expect(shutdownRoute.match(/bindDevice\(device, shutdownTargetUse\)/g)).toHaveLength(1);
  expect(shutdownRoute).not.toContain('operations.ensureReady');
  expect(shutdownRoute).not.toContain('ensureReadyUse');
  expect(shutdownRoute).not.toContain('target-shutdown');

  expect(sessionCloseSource).toContain("from '../session-close-shutdown.ts'");
  expect(closeAdapterSource).toContain('shutdownLocalDeviceTarget');
  expect(closeAdapterSource).not.toContain('shutdownSimulator');
  expect(closeAdapterSource).not.toContain('runAndroidAdb');

  expect(sharedHostSource).toContain('createDeviceShutdownRuntimeHost');
  expect(sharedHostSource).toContain('shutdownLocalDeviceTarget');
  expect(sharedHostSource).toContain('shutdownIosSimulator');
  expect(sharedHostSource).toContain('shutdownAndroidEmulator');
});
