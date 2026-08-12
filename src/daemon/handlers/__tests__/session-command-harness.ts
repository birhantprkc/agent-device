import {
  handleSessionCommands as handleProductionSessionCommands,
  type SessionCommandInput,
} from '../session.ts';
import {
  localRuntimeOwner,
  narrowDeviceBinding,
  type DeviceShutdownCloseCapability,
  type AppDeploymentInput,
  type AppDeploymentResult,
  type DeviceBinding,
  type DeployMaterializedAppInput,
  type EnsureReadyInput,
  type MaterializeAppSourceInput,
  type MaterializedAppSource,
  type PlatformRuntimeOperations,
  type PushNotificationInput,
  type PushNotificationResult,
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
export const mockCloseShutdownTarget = vi.fn(
  async (_device: DeviceInfo): Promise<TargetShutdownResult | undefined> => undefined,
);
const mockCloseShutdownCapability: DeviceShutdownCloseCapability = Object.freeze({
  canShutdownTarget: async (device) => isShutdownDevice(device),
  shutdownTarget: async (device) =>
    (await mockCloseShutdownTarget(device)) ?? {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    },
});
export const mockDeployAppRuntime = vi.fn(
  async (_input: AppDeploymentInput): Promise<AppDeploymentResult> => ({}),
);
export const mockMaterializeAppSourceRuntime = vi.fn(
  async (_input: MaterializeAppSourceInput): Promise<MaterializedAppSource> => ({
    installablePath: '/tmp/materialized-app',
    cleanup: async () => {},
  }),
);
export const mockDeployMaterializedAppRuntime = vi.fn(
  async (_input: DeployMaterializedAppInput): Promise<AppDeploymentResult> => ({}),
);
export const mockPushNotificationRuntime = vi.fn(
  async (_input: PushNotificationInput): Promise<PushNotificationResult> => ({}),
);
export const mockBindDeviceRuntime = vi.fn(async (device: DeviceInfo, use) =>
  narrowDeviceBinding(readinessBinding(device), use),
);

beforeEach(() => {
  mockInspectDeviceRuntimeFacts.mockClear();
  mockEnsureReadyRuntime.mockClear();
  mockEnsureReadyHeadlessRuntime.mockClear();
  mockShutdownTargetRuntime.mockClear();
  mockCloseShutdownTarget.mockClear();
  mockDeployAppRuntime.mockReset();
  mockDeployAppRuntime.mockResolvedValue({});
  mockMaterializeAppSourceRuntime.mockReset();
  mockMaterializeAppSourceRuntime.mockResolvedValue({
    installablePath: '/tmp/materialized-app',
    cleanup: async () => {},
  });
  mockDeployMaterializedAppRuntime.mockReset();
  mockDeployMaterializedAppRuntime.mockResolvedValue({});
  mockPushNotificationRuntime.mockReset();
  mockPushNotificationRuntime.mockResolvedValue({});
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
    getCloseShutdown: params.getCloseShutdown ?? (async () => mockCloseShutdownCapability),
    reconcileOrphanedDeviceClaim: async () => ({
      status: 'retained',
      reason: 'test-harness-has-no-exact-owner-recovery',
    }),
  });
}

function readinessFacts(device: DeviceInfo): RuntimeFacts<PlatformRuntimeOperations> {
  const normalAvailable = supportsReadiness(device);
  const headlessAvailable = device.platform === 'android' && device.kind === 'emulator';
  const shutdownAvailable = isShutdownDevice(device);
  const deployment = deploymentAvailability(device);
  return {
    device: { ...deviceShape(device), providerMode: 'local' },
    operations: {
      appLogInspect: unavailable,
      appLogDoctor: unavailable,
      appLogStart: unavailable,
      appLogReattach: unavailable,
      appLogCleanup: unavailable,
      deployApp: operationAvailability(deployment.deploy),
      materializeAppSource: operationAvailability(deployment.source),
      deployMaterializedApp: operationAvailability(deployment.source),
      sendPushNotification: operationAvailability(deployment.push),
      appState: operationAvailability(device.platform === 'android'),
      networkDump: unavailable,
      screenRecordingStart: unavailable,
      screenRecordingReattach: unavailable,
      screenRecordingCleanup: unavailable,
      ensureReady: operationAvailability(device.appleOs !== 'watchos'),
      bootTarget: operationAvailability(normalAvailable),
      bootTargetHeadless: operationAvailability(headlessAvailable),
      listApps: unavailable,
      shutdownTarget: shutdownAvailable ? available : unavailable,
    },
  };
}

function isShutdownDevice(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.appleOs !== 'watchos'
    ? device.kind === 'simulator'
    : device.platform === 'android' && device.kind === 'emulator';
}

function operationAvailability(supported: boolean): typeof available | typeof unavailable {
  return supported ? available : unavailable;
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
      ...(facts.operations.deployApp.available
        ? {
            deployApp: async (input) => await mockDeployAppRuntime(input),
          }
        : {}),
      ...(facts.operations.materializeAppSource.available
        ? {
            materializeAppSource: async (input) => await mockMaterializeAppSourceRuntime(input),
            deployMaterializedApp: async (input) => await mockDeployMaterializedAppRuntime(input),
          }
        : {}),
      ...(facts.operations.sendPushNotification.available
        ? {
            sendPushNotification: async (input) => await mockPushNotificationRuntime(input),
          }
        : {}),
    },
    [Symbol.asyncDispose]: async () => {},
  };
}

function supportsReadiness(device: DeviceInfo): boolean {
  return (
    (device.platform === 'apple' && device.appleOs !== 'macos' && device.appleOs !== 'watchos') ||
    device.platform === 'android'
  );
}

function deploymentAvailability(device: DeviceInfo) {
  const deploy = supportsDeployment(device);
  return {
    deploy,
    source: deploy && (device.platform === 'apple' || device.platform === 'android'),
    push:
      device.platform === 'android' || (device.platform === 'apple' && device.kind === 'simulator'),
  };
}

function supportsDeployment(device: DeviceInfo): boolean {
  if (device.platform === 'apple') {
    return (
      device.appleOs !== 'macos' &&
      device.appleOs !== 'watchos' &&
      !(device.kind === 'device' && device.iosPhysicalDeviceBackend === 'xctest')
    );
  }
  return device.platform === 'android' || device.platform === 'harmonyos';
}
