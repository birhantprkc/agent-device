import type { HarmonyAppDeploymentExecutor } from '@agent-device/contracts/platform';
import { setTimeout as sleep } from 'node:timers/promises';

/** Native HarmonyOS executor port; package-owned deployment logic chooses when to invoke it. */
export function createHarmonyAppDeploymentExecutor(): HarmonyAppDeploymentExecutor {
  return Object.freeze({
    resolveBundleName: async (archivePath, signal) => {
      const { resolveHarmonyArchiveBundleName } =
        await import('./platforms/harmonyos/app-lifecycle.ts');
      return await resolveHarmonyArchiveBundleName(archivePath, signal);
    },
    install: async (device, archivePath, signal) => {
      const { runHarmonyHdc } = await import('./platforms/harmonyos/hdc.ts');
      await runHarmonyHdc(device, ['install', '-r', archivePath], { signal, timeoutMs: 180_000 });
    },
    open: async (device, bundleId, signal) => {
      const { openHarmonyApp } = await import('./platforms/harmonyos/app-lifecycle.ts');
      await openHarmonyApp(device, bundleId, { signal });
    },
    sleep: async (milliseconds, signal) => {
      await sleep(milliseconds, undefined, { signal });
    },
  });
}
