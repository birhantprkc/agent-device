import type {
  DeviceInventoryProvider,
  DeviceLease,
  LeaseLifecycleProvider,
  ProviderDeviceRuntime,
  ProviderPortReverseOptions,
} from '@agent-device/contracts/device';
import type { Interactor, SnapshotResult } from '@agent-device/contracts/interaction';
import {
  providerRuntimeOwner,
  createUnavailablePlatformRuntimeFacts,
  sameRuntimeOwner,
  type AppDeploymentInput,
  type AppDeploymentResult,
  type DeviceBinding,
  type PlatformRuntimeOperations,
  type PlatformRuntimeOwner,
  type PlatformRuntimeProviderModule,
} from '@agent-device/contracts/platform';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { createProviderDeviceRuntimeRequestProviders } from '../../../src/provider-device-runtime.ts';
import { createProviderScenarioHarness } from './harness.ts';

export const FAKE_PROVIDER = 'fake-provider';
export const DEVTOOLS_PORT_REVERSE = {
  devicePort: 8097,
  hostPort: 8097,
  portReverseName: 'devtools',
};

const ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES = new Set([
  'then',
  'tapElementSelector',
  'fillElementSelector',
  'setViewport',
]);

export type FakeProviderCall = {
  type:
    | 'lease.allocate'
    | 'lease.heartbeat'
    | 'lease.release'
    | 'inventory'
    | 'install'
    | 'open'
    | 'close'
    | 'tap'
    | 'snapshot'
    | 'portReverse.ensure';
  [key: string]: unknown;
};

type FakeProviderSession = {
  device: DeviceInfo;
  interactor: Interactor;
};

export async function createFakeProviderWorld(platform: 'android' | 'ios' = 'android') {
  const runtime = new FakeProviderDeviceRuntime(platform);
  const providerRuntimeProviders = createProviderDeviceRuntimeRequestProviders([runtime]);
  const daemon = await createProviderScenarioHarness({
    ...providerRuntimeProviders,
    deviceInventorySource: providerRuntimeProviders.deviceInventorySource!,
    platformRuntime: true,
    providerRuntimes: [runtime],
    providerModules: [Object.freeze({ runtime, module: runtime.platformRuntimeModule })],
  });
  return {
    daemon,
    runtime,
    close: async () => {
      await runtime.shutdown();
      await daemon.close();
    },
  };
}

export class FakeProviderDeviceRuntime implements ProviderDeviceRuntime {
  readonly provider = FAKE_PROVIDER;
  readonly calls: FakeProviderCall[] = [];
  readonly platformRuntimeModule: PlatformRuntimeProviderModule;
  private readonly sessionsByLeaseId = new Map<string, FakeProviderSession>();
  private readonly platform: 'android' | 'ios';

  constructor(platform: 'android' | 'ios' = 'android') {
    this.platform = platform;
    this.platformRuntimeModule = createFakeProviderPlatformRuntimeModule(this);
  }

  readonly leaseLifecycle: LeaseLifecycleProvider = {
    allocate: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      const device = this.createDevice(lease);
      const interactor = createFakeProviderInteractor(device, this.calls);
      this.sessionsByLeaseId.set(lease.leaseId, { device, interactor });
      this.calls.push({
        type: 'lease.allocate',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
        deviceId: device.id,
      });
      return { provider: this.provider, deviceId: device.id };
    },
    heartbeat: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.calls.push({
        type: 'lease.heartbeat',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
    release: async (lease) => {
      if (lease.leaseProvider !== this.provider) return undefined;
      this.sessionsByLeaseId.delete(lease.leaseId);
      this.calls.push({
        type: 'lease.release',
        leaseId: lease.leaseId,
        provider: lease.leaseProvider,
      });
      return { provider: this.provider };
    },
  };

  readonly deviceInventoryProvider: DeviceInventoryProvider = async (request) => {
    if (request.leaseProvider !== this.provider) return null;
    const leaseId = request.leaseId;
    if (!leaseId) return [];
    const session = this.sessionsByLeaseId.get(leaseId);
    if (!session) return [];
    this.calls.push({
      type: 'inventory',
      leaseId,
      platform: request.platform,
    });
    return [session.device];
  };

  ownsDevice(device: DeviceInfo): boolean {
    return device.id.startsWith(`fake-provider:${this.platform}:`);
  }

  getInteractor(device: DeviceInfo): Interactor | undefined {
    return [...this.sessionsByLeaseId.values()].find((session) => session.device.id === device.id)
      ?.interactor;
  }

  async installApp(
    device: DeviceInfo,
    app: string,
    appPath: string,
  ): Promise<{ packageName: string; appName: string; launchTarget: string } | undefined> {
    if (!this.ownsDevice(device)) return undefined;
    this.calls.push({ type: 'install', deviceId: device.id, app, appPath });
    return {
      packageName: 'com.example.installed',
      appName: 'Installed Demo',
      launchTarget: 'com.example.installed',
    };
  }

  async configurePortReverse(
    options: ProviderPortReverseOptions,
  ): Promise<Record<string, unknown> | undefined> {
    if (options.provider !== this.provider) return undefined;
    this.calls.push({ type: 'portReverse.ensure', options });
    return { provider: this.provider, ...options };
  }

  async shutdown(): Promise<void> {
    this.sessionsByLeaseId.clear();
  }

  deviceIdForLease(leaseId: string): string {
    return `fake-provider:${this.platform}:${leaseId}`;
  }

  private createDevice(lease: DeviceLease): DeviceInfo {
    if (this.platform === 'ios') {
      return {
        platform: 'apple',
        appleOs: 'ios',
        id: this.deviceIdForLease(lease.leaseId),
        name: 'Fake Provider iOS Simulator',
        kind: 'simulator',
        target: 'mobile',
        booted: true,
      };
    }
    return {
      platform: 'android',
      id: this.deviceIdForLease(lease.leaseId),
      name: 'Fake Provider Android',
      kind: 'device',
      target: 'mobile',
      booted: true,
    };
  }
}

const fakeProviderRuntimeOwner = providerRuntimeOwner(FAKE_PROVIDER, 'default');
const available = Object.freeze({ available: true } as const);
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-provider-mode',
} as const);

function createFakeProviderPlatformRuntimeModule(
  runtime: FakeProviderDeviceRuntime,
): PlatformRuntimeProviderModule {
  return Object.freeze({
    owner: fakeProviderRuntimeOwner,
    loadRuntime: async () => createFakeProviderPlatformRuntimeOwner(runtime),
  });
}

function createFakeProviderPlatformRuntimeOwner(
  runtime: FakeProviderDeviceRuntime,
): PlatformRuntimeOwner {
  const factsFor = (device: DeviceInfo) => {
    const unavailableFacts = createUnavailablePlatformRuntimeFacts(
      device,
      fakeProviderRuntimeOwner,
      {
        appLog: unavailable,
        appDeployment: unavailable,
        network: unavailable,
        readiness: unavailable,
      },
    );
    const ownsDevice = runtime.ownsDevice(device);
    return Object.freeze({
      ...unavailableFacts,
      operations: Object.freeze({
        ...unavailableFacts.operations,
        deployApp: ownsDevice ? available : unavailable,
        ensureReady: ownsDevice ? available : unavailable,
      }),
    });
  };
  return Object.freeze({
    owner: fakeProviderRuntimeOwner,
    ownsDevice: (device) => runtime.ownsDevice(device),
    inspectFacts: async (device) => factsFor(device),
    bind: async (request) => {
      if (
        request.intent.kind === 'exact-owner' &&
        !sameRuntimeOwner(request.intent.owner, fakeProviderRuntimeOwner)
      ) {
        throw new AppError('UNSUPPORTED_OPERATION', 'Fake provider runtime owner does not match');
      }
      if (!runtime.ownsDevice(request.device)) {
        throw new AppError(
          'UNSUPPORTED_PLATFORM',
          'Fake provider runtime does not own this device',
        );
      }
      return Object.freeze({
        device: request.device,
        owner: fakeProviderRuntimeOwner,
        facts: factsFor(request.device),
        operations: Object.freeze({
          ensureReady: async () => ({ ...request.device, booted: true }),
          deployApp: async (input: AppDeploymentInput): Promise<AppDeploymentResult> => {
            const result = await runtime.installApp(request.device, input.app, input.appPath);
            if (result) return result;
            throw new AppError('UNSUPPORTED_OPERATION', 'Fake provider install is unavailable');
          },
        }),
        [Symbol.asyncDispose]: async () => undefined,
      }) satisfies DeviceBinding<PlatformRuntimeOperations>;
    },
    shutdown: async () => undefined,
  });
}

function createFakeProviderInteractor(device: DeviceInfo, calls: FakeProviderCall[]): Interactor {
  return new Proxy<Partial<Interactor>>(
    {
      open: async (app, options) => {
        calls.push({ type: 'open', deviceId: device.id, app, url: options?.url });
      },
      close: async (app) => {
        calls.push({ type: 'close', deviceId: device.id, app });
      },
      tap: async (x, y) => {
        calls.push({ type: 'tap', deviceId: device.id, x, y });
        return { backend: 'fake-provider', x, y };
      },
      snapshot: async (options): Promise<SnapshotResult> => {
        calls.push({
          type: 'snapshot',
          deviceId: device.id,
          interactiveOnly: options?.interactiveOnly,
        });
        return {
          backend: 'android',
          nodes: [
            {
              index: 0,
              type: 'TextView',
              label: 'Provider Ready',
              rect: { x: 0, y: 0, width: 120, height: 40 },
              enabled: true,
              visibleToUser: true,
            },
          ],
        };
      },
    },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        if (
          typeof property === 'string' &&
          ABSENT_FAKE_PROVIDER_INTERACTOR_PROPERTIES.has(property)
        ) {
          return undefined;
        }
        if (typeof property === 'string') {
          return () => throwUnexpectedProviderInteraction(property);
        }
        return undefined;
      },
    },
  ) as Interactor;
}

function throwUnexpectedProviderInteraction(method: string): never {
  throw new Error(`Unexpected fake provider interactor call: ${method}`);
}
