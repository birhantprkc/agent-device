import type { DeviceInfo } from '@agent-device/kernel/device';
import { AppError } from '@agent-device/kernel/errors';
import { execFailureDetails } from '../../../utils/exec.ts';
import { ensureBootedSimulator } from './simulator.ts';
import { invalidateIosAppResolutionCache, resolveIosApp } from './app-resolution.ts';
import { isMissingAppErrorOutput, runSimctl } from './apps-simctl.ts';
import { resolveIosPhysicalDeviceControl } from './physical-device-control.ts';

type IosInstallSignalOptions = {
  signal?: AbortSignal;
};

export async function uninstallIosApp(
  device: DeviceInfo,
  app: string,
  options: IosInstallSignalOptions = {},
): Promise<{ bundleId: string }> {
  return await invalidateIosAppResolutionCache(device, async () => {
    options.signal?.throwIfAborted();
    const bundleId = await resolveIosApp(device, app);
    if (device.kind !== 'simulator') {
      await resolveIosPhysicalDeviceControl(device).uninstallApp(device, bundleId, options.signal);
      return { bundleId };
    }

    await ensureBootedSimulator(device, { signal: options.signal });

    const result = await runSimctl(device, ['uninstall', device.id, bundleId], {
      allowFailure: true,
      signal: options.signal,
    });
    if (result.exitCode !== 0) {
      const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
      if (!isMissingAppErrorOutput(output)) {
        throw new AppError(
          'COMMAND_FAILED',
          `simctl uninstall failed for ${bundleId}`,
          execFailureDetails(result),
        );
      }
    }

    return { bundleId };
  });
}

export async function installIosInstallablePath(
  device: DeviceInfo,
  installablePath: string,
  options: IosInstallSignalOptions = {},
): Promise<void> {
  await invalidateIosAppResolutionCache(device, async () => {
    options.signal?.throwIfAborted();
    if (device.kind !== 'simulator') {
      await resolveIosPhysicalDeviceControl(device).installApp(
        device,
        installablePath,
        options.signal,
      );
      return;
    }

    await ensureBootedSimulator(device, { signal: options.signal });
    await runSimctl(device, ['install', device.id, installablePath], { signal: options.signal });
  });
}
