import { deviceShape, type DeviceInfo, type Platform } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import {
  applicationLifecycleOperationFacts,
  type ApplicationLifecycleOperationFacts,
} from './application-lifecycle-runtime.ts';
import type {
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
} from './platform-runtime-operations.ts';
import type {
  DeviceBinding,
  RuntimeFacts,
  RuntimeOperationUnavailability,
  RuntimeOwnerRef,
} from './platform-runtime.ts';
import { localRuntimeOwner, sameRuntimeOwner } from './platform-runtime.ts';

/**
 * A runtime-contract helper for provider ownership gaps. It never assigns lifecycle semantics:
 * the selected package/provider must classify every lifecycle operation for its exact cell.
 */
export type UnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps?: RuntimeOperationUnavailability;
  appDeployment?: RuntimeOperationUnavailability;
  appState?: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording?: RuntimeOperationUnavailability;
  readiness?: RuntimeOperationUnavailability;
  shutdown?: RuntimeOperationUnavailability;
  lifecycle: ApplicationLifecycleOperationFacts;
}>;

type FrozenUnavailablePlatformRuntimeFacts = Readonly<{
  appLog: RuntimeOperationUnavailability;
  apps: RuntimeOperationUnavailability;
  appDeployment: RuntimeOperationUnavailability;
  appState: RuntimeOperationUnavailability;
  network: RuntimeOperationUnavailability;
  screenRecording: RuntimeOperationUnavailability;
  readiness: RuntimeOperationUnavailability;
  shutdown: RuntimeOperationUnavailability;
  lifecycle: ApplicationLifecycleOperationFacts;
}>;

/** Builds one honest combined owner for a family with no platform operations. */
export function createUnavailablePlatformRuntimeOwner(
  family: Platform,
  unavailable: UnavailablePlatformRuntimeFacts,
): PlatformRuntimeOwner {
  const owner = localRuntimeOwner(family);
  const facts = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    owner,
    ownsDevice: (device) => device.platform === family,
    inspectFacts: async (device) => createUnavailablePlatformRuntimeFacts(device, owner, facts),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError(
          'UNSUPPORTED_OPERATION',
          family + ' platform runtime owner identity does not match',
        );
      }
      if (request.device.platform !== family) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          family + ' platform runtime cannot bind ' + request.device.platform,
        );
      }
      return createUnavailablePlatformRuntimeBinding(request.device, owner, facts);
    },
    shutdown: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeBinding(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): DeviceBinding<PlatformRuntimeOperations> {
  return Object.freeze({
    device,
    owner,
    facts: createUnavailablePlatformRuntimeFacts(device, owner, unavailable),
    operations: Object.freeze({}),
    [Symbol.asyncDispose]: async () => undefined,
  });
}

export function createUnavailablePlatformRuntimeFacts(
  device: DeviceInfo,
  owner: RuntimeOwnerRef,
  unavailable: UnavailablePlatformRuntimeFacts,
): RuntimeFacts<PlatformRuntimeOperations> {
  const {
    appLog,
    apps,
    appDeployment,
    appState,
    network,
    screenRecording,
    readiness,
    shutdown,
    lifecycle,
  } = freezeUnavailableFacts(unavailable);
  return Object.freeze({
    device: {
      ...deviceShape(device),
      providerMode: owner.kind === 'local-family' ? 'local' : 'provider-runtime',
    },
    operations: {
      appLogInspect: appLog,
      appLogDoctor: appLog,
      appLogStart: appLog,
      appLogReattach: appLog,
      appLogCleanup: appLog,
      listApps: apps,
      deployApp: appDeployment,
      materializeAppSource: appDeployment,
      deployMaterializedApp: appDeployment,
      sendPushNotification: appDeployment,
      appState,
      networkDump: network,
      screenRecordingStart: screenRecording,
      screenRecordingReattach: screenRecording,
      screenRecordingCleanup: screenRecording,
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: readiness,
      shutdownTarget: shutdown,
      ...lifecycle,
    },
  });
}

function freezeUnavailableFacts(
  unavailable: UnavailablePlatformRuntimeFacts,
): FrozenUnavailablePlatformRuntimeFacts {
  return Object.freeze({
    appLog: Object.freeze({ ...unavailable.appLog }),
    apps: Object.freeze({ ...(unavailable.apps ?? unavailable.network) }),
    appDeployment: Object.freeze({ ...(unavailable.appDeployment ?? unavailable.network) }),
    appState: Object.freeze({ ...(unavailable.appState ?? unavailable.network) }),
    network: Object.freeze({ ...unavailable.network }),
    screenRecording: Object.freeze({
      ...(unavailable.screenRecording ?? unavailable.network),
    }),
    readiness: Object.freeze({ ...(unavailable.readiness ?? unavailable.network) }),
    shutdown: Object.freeze({ ...(unavailable.shutdown ?? unavailable.network) }),
    lifecycle: applicationLifecycleOperationFacts(unavailable.lifecycle),
  });
}
