import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceBinding,
  type EnsureReadyInput,
  type PlatformRuntimeOperations,
  type RuntimeFacts,
} from '@agent-device/contracts/platform';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import { deviceShape, isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { beforeEach, vi } from 'vitest';

const unavailable = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
} as const);
const available = Object.freeze({ available: true } as const);

export const mockInspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) =>
  readinessFacts(device),
);
export const mockEnsureReadyRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockEnsureReadyHeadlessRuntime = vi.fn(
  async (_input: EnsureReadyInput): Promise<DeviceInfo | undefined> => undefined,
);
export const mockShutdownTargetRuntime = vi.fn(
  async (): Promise<TargetShutdownResult | undefined> => undefined,
);
export const mockBindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) =>
  narrowDeviceBinding(readinessBinding(device), use),
);

beforeEach(() => {
  mockInspectDeviceRuntimeFacts.mockClear();
  mockEnsureReadyRuntime.mockClear();
  mockEnsureReadyHeadlessRuntime.mockClear();
  mockShutdownTargetRuntime.mockClear();
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
  const normalAvailable = isReadinessDevice(device);
  const headlessAvailable = isAndroidEmulator(device);
  const shutdownAvailable = isShutdownDevice(device);
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      appState: device.platform === 'android' ? available : unavailable,
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: device.appleOs === 'watchos' ? unavailable : available,
      bootTarget: normalAvailable ? available : unavailable,
      bootTargetHeadless: headlessAvailable ? available : unavailable,
      listApps: unavailable,
      shutdownTarget: shutdownAvailable ? available : unavailable,
    },
  };
}

function isReadinessDevice(device: DeviceInfo): boolean {
  return (
    (device.platform === 'apple' && device.appleOs !== 'macos' && device.appleOs !== 'watchos') ||
    device.platform === 'android'
  );
}

function isAndroidEmulator(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}

function isShutdownDevice(device: DeviceInfo): boolean {
  return isIosFamily(device) ? device.kind === 'simulator' : isAndroidEmulator(device);
}

function readinessBinding(device: DeviceInfo): DeviceBinding<PlatformRuntimeOperations> {
  const facts = readinessFacts(device);
  return {
    device,
    owner: localRuntimeOwner(device.platform),
    facts,
    operations: {
      ensureReady: async (input) =>
        (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
      ...(device.platform === 'android'
        ? { appState: async () => ({ package: 'com.example.app', activity: '.MainActivity' }) }
        : {}),
      ...(facts.operations.bootTarget.available
        ? {
            bootTarget: async (input) =>
              (await mockEnsureReadyRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      listApps: async () => [],
      ...(facts.operations.bootTargetHeadless.available
        ? {
            bootTargetHeadless: async (input) =>
              (await mockEnsureReadyHeadlessRuntime(input)) ?? { ...device, booted: true },
          }
        : {}),
      ...(facts.operations.shutdownTarget.available
        ? {
            shutdownTarget: async () =>
              (await mockShutdownTargetRuntime()) ?? {
                success: true,
                exitCode: 0,
                stdout: '',
                stderr: '',
              },
          }
        : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
}
