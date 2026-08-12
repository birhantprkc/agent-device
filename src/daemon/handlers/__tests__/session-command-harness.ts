import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';
import {
  applicationLifecycleOperationFacts,
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type EnsureReadyInput,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import { deviceShape, type DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, vi } from 'vitest';
import { applicationLifecycleRuntimeFixture } from '../../__tests__/application-lifecycle-runtime-fixture.ts';

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);
const prepareUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-platform-leaf',
  hint: 'Apple runner preparation is supported only for Apple targets.',
} as const);

export const mockInspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  readinessFacts(device),
);
export const mockEnsureReadyRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockEnsureReadyHeadlessRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockBindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) =>
  narrowDeviceBinding(await readinessBinding(device), use),
);

beforeEach(() => {
  mockInspectDeviceRuntimeFacts.mockClear();
  mockEnsureReadyRuntime.mockClear();
  mockEnsureReadyHeadlessRuntime.mockClear();
  mockBindDeviceRuntime.mockClear();
});

/** Unit-handler default is explicitly fail-closed; production must inject exact-owner recovery. */
export function handleSessionCommands(
  params: Omit<SessionCommandInput, 'reconcileOrphanedDeviceClaim'>,
): ReturnType<typeof handleProductionSessionCommands> {
  return handleProductionSessionCommands({
    ...params,
    inspectFacts: params.inspectFacts ?? mockInspectDeviceRuntimeFacts,
    bindDevice: params.bindDevice ?? mockBindDeviceRuntime,
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'test-harness-has-no-exact-owner-recovery',
    }),
  });
}

function readinessFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: fact(device.platform === 'android'),
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: fact(device.appleOs !== 'watchos'),
      bootTarget: fact(supportsBoot(device)),
      bootTargetHeadless: fact(device.platform === 'android' && device.kind === 'emulator'),
      listApps: unavailable,
      ...readinessLifecycleFacts(device),
    },
  };
}

function supportsBoot(device: DeviceInfo): boolean {
  if (device.platform === 'android') return true;
  return device.platform === 'apple' && device.appleOs !== 'macos' && device.appleOs !== 'watchos';
}

function readinessLifecycleFacts(device: DeviceInfo) {
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: available,
    prepareApplicationOpen: available,
    openApplication: available,
    applyRuntimeHints: available,
    clearRuntimeHints: available,
    closeApplication: available,
    finalizeApplicationClose: available,
    prepareAppleRunner: device.platform === 'apple' ? available : prepareUnavailable,
    configureProviderPortReverse: unavailable,
  });
}

function fact(isAvailable: boolean) {
  return isAvailable ? available : unavailable;
}

async function readinessBinding(
  device: DeviceInfo,
): Promise<DeviceBinding<PlatformRuntimeOperations>> {
  const lifecycle = await applicationLifecycleRuntimeFixture(device);
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts: readinessFacts(device),
    operations: {
      ensureReady: async (input) =>
        (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
      ...(device.platform === 'android'
        ? { appState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }) }
        : {}),
      ...(readinessFacts(device).operations.bootTarget.available
        ? {
            bootTarget: async (input) =>
              (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      listApps: async () => [],
      ...(device.platform === 'android' && device.kind === 'emulator'
        ? {
            bootTargetHeadless: async (input) =>
              (await mockEnsureReadyHeadlessRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      ...lifecycle,
    },
    [Symbol.asyncDispose]: async () => {},
  };
}
