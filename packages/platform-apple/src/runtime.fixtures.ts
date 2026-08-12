import type { PlatformRuntimeHost } from '@agent-device/contracts/platform';
import { hostFixture } from './logs/runtime.fixtures.ts';

export function platformRuntimeHostFixture(): PlatformRuntimeHost {
  return {
    ...hostFixture().host,
    appLogs: {
      readRecent: async () => ({
        path: '/sessions/one/app.log',
        exists: false,
        text: '',
        skippedLines: 0,
      }),
      readProcessMarker: async () => ({ status: 'missing' }),
    },
    networkTransports: { resolve: async () => ({ mode: 'local' }) },
    appInventory: {
      apple: { listApps: async () => [] },
      android: { listApps: async () => [] },
      harmonyos: { listApps: async () => [] },
    },
    appState: {
      android: { run: async () => ({ stdout: '' }) },
      harmonyos: { run: async () => ({ stdout: '' }) },
    },
    appleDeployment: {
      prepareArtifact: async () => {
        throw new Error('unused');
      },
      install: async () => {
        throw new Error('unused');
      },
      uninstall: async () => {
        throw new Error('unused');
      },
      push: async () => {
        throw new Error('unused');
      },
    },
    deviceReadiness: {
      applePhysical: { ensureConnected: async () => {} },
      appleAutomation: { keepHot: () => {} },
      androidEmulator: {
        discover: async () => [],
        launch: () => 1,
        terminate: async () => {},
      },
    },
    deviceShutdown: {
      apple: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
      android: {
        shutdownTarget: async () => ({ success: true, exitCode: 0, stdout: '', stderr: '' }),
      },
    },
    screenRecording: {
      apple: {
        availability: async () => ({ available: true }),
        runRunner: async () => ({}),
        startSimulator: async () => {
          throw new Error('unused');
        },
        inspectProcess: async () => 'missing',
        terminateProcess: async () => 'already-missing',
        inspectRunner: async () => 'missing',
        retrieveRunnerRecording: async () => {},
        captureClockAnchor: async () => undefined,
        isRunnerBundleId: async () => false,
      },
      android: {
        resolve: async () => {
          throw new Error('unused');
        },
      },
      harmony: {
        start: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        stop: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        findMedia: async () => undefined,
        stageMedia: async () => false,
        stagedFileSize: async () => undefined,
        pull: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
        remove: async () => true,
        removeMedia: async () => true,
      },
      web: { resolve: async () => undefined },
      outputs: { prepare: async () => {} },
      finalize: { complete: async () => ({}) },
    },
  } as unknown as PlatformRuntimeHost;
}
