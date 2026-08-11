import type { DeviceInfo } from '@agent-device/kernel/device';
import type { TargetShutdownResult } from './target-shutdown-contract.ts';

export type DeviceShutdownRuntimeOperations = Readonly<{
  shutdownTarget(): Promise<TargetShutdownResult>;
}>;

export type DeviceShutdownRuntimeHost = Readonly<{
  apple: Readonly<{
    shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
  }>;
  android: Readonly<{
    shutdownTarget(device: DeviceInfo, signal: AbortSignal): Promise<TargetShutdownResult>;
  }>;
}>;
