import type { DeviceReadinessRuntimeHost } from '@agent-device/contracts/platform';

export function createAppleAutomationKeepHotHost(): DeviceReadinessRuntimeHost['appleAutomation'] {
  return Object.freeze({
    keepHot: (device) => {
      void import('./platforms/apple/core/runner/runner-client.ts')
        .then(({ prewarmAppleRunnerCache }) => prewarmAppleRunnerCache(device, {}))
        .catch(() => {});
    },
    markBooted: (device) => {
      void import('./platforms/apple/core/simulator.ts')
        .then(({ markSimulatorBooted }) => markSimulatorBooted(device))
        .catch(() => {});
    },
  });
}
