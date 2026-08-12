import type { DeviceInfo } from '@agent-device/kernel/device';
import type { AppsFilter } from '@agent-device/contracts/device';
import { AppError } from '@agent-device/kernel/errors';
import { parseLimrunDeviceId } from './device.ts';
import type {
  AppStateRuntimeResult,
  DeviceBinding,
  PlatformRuntimeOperations,
  PlatformRuntimeOwner,
  RuntimeFacts,
} from '@agent-device/contracts/platform';
import {
  appLogSessionArtifactsMatch,
  assertAppLogSessionArtifacts,
  createAppLogRecoveryOperations,
  createAppLogStartResult,
  readRecentNetworkTrafficFromText,
} from '@agent-device/capture-kit';
import { providerRuntimeOwner, sameRuntimeOwner } from '@agent-device/contracts/platform';
import {
  createLimrunAppLogEnvelope,
  limrunAppLogDescriptorCodec,
  type LimrunAppLogDescriptor,
} from './app-log-descriptor.ts';
import { startLimrunAppLogPoller, type LimrunAppLogReader } from './app-log-poller.ts';
import {
  createLimrunAppDeploymentOperations,
  isActiveLimrunRuntimeSession,
  limrunAppDeploymentFacts,
  type LimrunAppDeploymentRuntimeOptions,
} from './deployment-runtime.ts';
import { createLimrunRequestOperationDrain } from './request-cancellation.ts';
import { isSupportedLimrunRuntimeDevice } from './runtime-device.ts';

export type LimrunAppLogReconnectOutcome =
  | Readonly<{ status: 'opened'; reader: LimrunAppLogReader }>
  | Readonly<{ status: 'missing' }>
  | Readonly<{ status: 'ownership-lost' }>;

export type LimrunPlatformRuntimeOwnerOptions = LimrunAppDeploymentRuntimeOptions &
  Readonly<{
    runtimeInstance: string;
    openCurrent(device: DeviceInfo): Promise<LimrunAppLogReader | undefined>;
    reconnect(
      descriptor: LimrunAppLogDescriptor,
      signal?: AbortSignal,
    ): Promise<LimrunAppLogReconnectOutcome>;
    listApps(
      device: DeviceInfo,
      filter: AppsFilter,
      signal: AbortSignal,
    ): Promise<readonly { id: string; name: string }[]>;
    getAppState(device: DeviceInfo, signal: AbortSignal): Promise<AppStateRuntimeResult>;
  }>;

const available = Object.freeze({ available: true } as const);
const recordingUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Limrun does not expose an exact-owner screen-recording runtime.',
} as const);
const headlessUnavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
  hint: 'Headless boot is unavailable for provider-owned devices.',
} as const);
const inactiveSession = Object.freeze({
  available: false,
  reason: 'owner-capability-missing',
  hint: 'The Limrun provider session is no longer active for this device.',
} as const);

export function createLimrunPlatformRuntimeOwner(
  options: LimrunPlatformRuntimeOwnerOptions,
): PlatformRuntimeOwner {
  const owner = providerRuntimeOwner('limrun', options.runtimeInstance);
  return Object.freeze({
    owner,
    ownsDevice: (device) => isSupportedLimrunRuntimeDevice(device) && options.ownsDevice(device),
    inspectFacts: async (device) => facts(options, device),
    bind: async (request) => {
      if (request.intent.kind === 'exact-owner' && !sameRuntimeOwner(request.intent.owner, owner)) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Limrun app-log owner identity does not match');
      }
      if (!isSupportedLimrunRuntimeDevice(request.device)) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          'Limrun app logs require an iOS simulator or Android emulator device identity',
        );
      }
      if (
        request.intent.kind !== 'exact-owner' &&
        !isActiveLimrunRuntimeSession(options, request.device)
      ) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Limrun provider session is unavailable', {
          reason: 'provider-session-unavailable',
        });
      }
      return bindLimrunAppLogs(
        options,
        owner,
        request.device,
        request.scope.signal,
        request.intent.kind === 'exact-owner' &&
          !isActiveLimrunRuntimeSession(options, request.device),
      );
    },
    shutdown: async () => undefined,
  });
}

function bindLimrunAppLogs(
  options: LimrunPlatformRuntimeOwnerOptions,
  owner: ReturnType<typeof providerRuntimeOwner>,
  device: DeviceInfo,
  signal: AbortSignal,
  recoveryOnly: boolean,
): DeviceBinding<PlatformRuntimeOperations> {
  // Limrun's WebSocket deployment calls cannot be aborted individually. Keep their completion
  // request-bound so a cancelled caller cannot release the provider session mid-mutation.
  const deploymentOperationDrain = createLimrunRequestOperationDrain();
  const recovery = createAppLogRecoveryOperations({
    codec: limrunAppLogDescriptorCodec,
    reattach: async (descriptor, context) => {
      if (
        !descriptorMatchesDevice(descriptor, device) ||
        !appLogSessionArtifactsMatch(options.host, context.sessionId, descriptor)
      ) {
        return {
          status: 'unreattachable',
          reason: 'descriptor-invalid',
          message: 'Limrun app-log descriptor does not match the bound device or owning session',
        };
      }
      const reconnected = await options.reconnect(descriptor, signal);
      if (reconnected.status === 'missing') return { status: 'missing' };
      if (reconnected.status === 'ownership-lost') {
        return { status: 'unreattachable', reason: 'ownership-fence-lost' };
      }
      return {
        status: 'active',
        handle: await startLimrunAppLogPoller({
          host: options.host,
          reader: reconnected.reader,
          appBundleId: descriptor.appBundleId,
          outputPath: descriptor.outputPath,
        }),
      };
    },
    cleanup: async (descriptor, context) =>
      descriptorMatchesDevice(descriptor, device) &&
      appLogSessionArtifactsMatch(options.host, context.sessionId, descriptor)
        ? { status: 'cleaned' }
        : {
            status: 'cleanup-pending',
            reason: 'ownership-fence-lost',
            message: 'Limrun app-log descriptor does not match the bound device or owning session',
          },
  });
  const operations = {
    appLogInspect: async () => ({ backend: backendForDevice(device) }),
    appLogDoctor: async () => ({
      backend: backendForDevice(device),
      checks: { limrunSessionAvailable: await currentSessionAvailable(options, device, signal) },
      notes: [],
    }),
    appLogStart: async (input) => {
      assertAppLogSessionArtifacts(options.host, input);
      signal.throwIfAborted();
      const reader = await options.openCurrent(device);
      if (!reader) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Limrun app logs require an active instance');
      }
      const descriptor: LimrunAppLogDescriptor = {
        transport: 'limrun-log-poller',
        platform: reader.platform,
        leaseId: reader.leaseId,
        instanceId: reader.instanceId,
        appBundleId: input.appBundleId,
        outputPath: input.outputPath,
      };
      let pollerOwnsReader = false;
      try {
        signal.throwIfAborted();
        const envelope = createLimrunAppLogEnvelope({
          sessionId: input.sessionId,
          device,
          owner,
          fence: input.fence,
          descriptor,
        });
        pollerOwnsReader = true;
        const handle = await startLimrunAppLogPoller({
          host: options.host,
          reader,
          appBundleId: input.appBundleId,
          outputPath: input.outputPath,
        });
        return createAppLogStartResult(handle, envelope);
      } catch (error) {
        if (!pollerOwnsReader) await reader[Symbol.asyncDispose]();
        throw error;
      }
    },
    ...recovery,
    networkDump: async (input) => {
      const recent = await options.host.appLogs.readRecent(input.sessionId, input.maxScanLines);
      const backend = backendForDevice(device);
      const dump = readRecentNetworkTrafficFromText(recent.text, {
        ...input,
        path: recent.path,
        exists: recent.exists,
        lineNumberOffset: recent.skippedLines,
        backend,
      });
      const notes =
        dump.entries.length === 0
          ? ['No HTTP(s) entries were found in recent session app logs.']
          : [];
      return Object.freeze({ source: 'app-log' as const, backend, dump, notes });
    },
    ...(recoveryOnly
      ? {}
      : {
          ensureReady: async () => ({ ...device, booted: true }),
          bootTarget: async () => ({ ...device, booted: true }),
          listApps: async (input) => await options.listApps(input.device, input.filter, signal),
          ...(device.platform === 'android'
            ? { appState: async () => await options.getAppState(device, signal) }
            : {}),
          ...createLimrunAppDeploymentOperations(options, device, signal, deploymentOperationDrain),
        }),
  } satisfies DeviceBinding<PlatformRuntimeOperations>['operations'];
  return Object.freeze({
    device,
    owner,
    facts: recoveryOnly ? recoveryFacts(options, device) : facts(options, device),
    operations: Object.freeze(operations),
    [Symbol.asyncDispose]: async () => await deploymentOperationDrain[Symbol.asyncDispose](),
  });
}

function recoveryFacts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  const normal = facts(options, device);
  return Object.freeze({
    device: normal.device,
    operations: {
      ...normal.operations,
      appLogInspect: inactiveSession,
      appLogDoctor: inactiveSession,
      appLogStart: inactiveSession,
      appLogReattach: available,
      appLogCleanup: available,
      appState: inactiveSession,
      networkDump: inactiveSession,
      ensureReady: inactiveSession,
      bootTarget: inactiveSession,
      bootTargetHeadless: inactiveSession,
      listApps: inactiveSession,
    },
  });
}

async function currentSessionAvailable(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted();
  const reader = await options.openCurrent(device);
  if (!reader) return false;
  try {
    signal.throwIfAborted();
  } finally {
    await reader[Symbol.asyncDispose]();
  }
  return true;
}

function facts(
  options: LimrunPlatformRuntimeOwnerOptions,
  device: DeviceInfo,
): RuntimeFacts<PlatformRuntimeOperations> {
  // Deployment/readiness require an in-memory live device session. Durable app-log recovery and
  // historical network inspection retain their own fenced reconnection/read paths and therefore
  // remain independently admitted after a daemon loses its live session cache.
  const readiness = isActiveLimrunRuntimeSession(options, device) ? available : inactiveSession;
  const deployment = limrunAppDeploymentFacts(options, device);
  return Object.freeze({
    device: {
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      providerMode: 'provider-runtime',
    },
    operations: {
      appLogInspect: available,
      appLogDoctor: available,
      appLogStart: readiness,
      appLogReattach: available,
      appLogCleanup: available,
      ...deployment,
      appState:
        device.platform === 'android'
          ? readiness
          : {
              available: false,
              reason: 'unsupported-provider-mode',
              hint: 'Limrun iOS does not expose a foreground app-state operation.',
            },
      networkDump: available,
      screenRecordingStart: recordingUnavailable,
      screenRecordingReattach: recordingUnavailable,
      screenRecordingCleanup: recordingUnavailable,
      ensureReady: readiness,
      bootTarget: readiness,
      bootTargetHeadless: headlessUnavailable,
      listApps: available,
      shutdownTarget: {
        available: false,
        reason: 'unsupported-provider-mode',
        hint: 'Limrun owns the target lifecycle for provider-owned devices.',
      },
    },
  });
}

function backendForDevice(device: DeviceInfo): 'ios-simulator' | 'android' {
  return device.platform === 'apple' ? 'ios-simulator' : 'android';
}

function descriptorMatchesDevice(descriptor: LimrunAppLogDescriptor, device: DeviceInfo): boolean {
  if (!isSupportedLimrunRuntimeDevice(device)) return false;
  const parsed = parseLimrunDeviceId(device.id);
  return (
    parsed !== undefined &&
    parsed.leaseId === descriptor.leaseId &&
    parsed.platform === descriptor.platform &&
    (device.platform === 'apple'
      ? descriptor.platform === 'ios'
      : descriptor.platform === 'android')
  );
}
