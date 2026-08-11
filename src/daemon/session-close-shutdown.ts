import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  canShutdownLocalDeviceTarget,
  shutdownLocalDeviceTarget,
} from '../platform-runtime-device-shutdown-host.ts';

export function canShutdownSessionTarget(device: DeviceInfo): boolean {
  return canShutdownLocalDeviceTarget(device);
}

export async function shutdownSessionTarget(device: DeviceInfo) {
  return await shutdownLocalDeviceTarget(device);
}
