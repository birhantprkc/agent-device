import type { DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceShutdownCloseCapability } from '@agent-device/contracts/platform';

export async function canShutdownSessionTarget(
  capability: DeviceShutdownCloseCapability | undefined,
  device: DeviceInfo,
): Promise<boolean> {
  return capability ? await capability.canShutdownTarget(device) : false;
}

export async function shutdownSessionTarget(
  capability: DeviceShutdownCloseCapability,
  device: DeviceInfo,
) {
  return await capability.shutdownTarget(device);
}
