import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

vi.mock('./platforms/apple/core/simulator.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./platforms/apple/core/simulator.ts')>();
  return {
    ...actual,
    getSimulatorState: vi.fn(),
    shutdownSimulator: vi.fn(),
  };
});

vi.mock('./utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

import { createDeviceShutdownRuntimeHost } from './platform-runtime-device-shutdown-host.ts';
import { getSimulatorState, shutdownSimulator } from './platforms/apple/core/simulator.ts';
import { runCmd } from './utils/exec.ts';

const mockGetSimulatorState = vi.mocked(getSimulatorState);
const mockShutdownSimulator = vi.mocked(shutdownSimulator);
const mockRunCmd = vi.mocked(runCmd);

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSimulatorState.mockResolvedValue(null);
  mockShutdownSimulator.mockResolvedValue({ success: true, exitCode: 0, stdout: '', stderr: '' });
  mockRunCmd.mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
});

test('shutdown runtime treats an already-stopped target as success without native calls', async () => {
  const device = appleDevice({ booted: false });

  await expect(shutdownHost().apple.shutdownTarget(device, signal())).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  expect(mockShutdownSimulator).not.toHaveBeenCalled();
  expect(mockRunCmd).not.toHaveBeenCalled();
});

test('shutdown runtime preserves iOS Shutdown final-state parity', async () => {
  const device = appleDevice();
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'Unable to shutdown device in current state: Shutdown',
  });
  mockGetSimulatorState.mockResolvedValue('Shutdown');

  await expect(shutdownHost().apple.shutdownTarget(device, signal())).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: 'Unable to shutdown device in current state: Shutdown',
  });
  expect(mockGetSimulatorState).toHaveBeenCalledWith(device);
});

test('shutdown runtime preserves iOS failure when final-state inspection fails', async () => {
  const device = appleDevice();
  mockShutdownSimulator.mockResolvedValue({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });
  mockGetSimulatorState.mockRejectedValue(new Error('simctl list failed'));

  await expect(shutdownHost().apple.shutdownTarget(device, signal())).resolves.toEqual({
    success: false,
    exitCode: 149,
    stdout: '',
    stderr: 'simctl shutdown failed',
  });
});

test('shutdown runtime delegates Android emulator shutdown through the scoped adb executor', async () => {
  const device: DeviceInfo = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel',
    kind: 'emulator',
    booted: true,
  };

  await expect(shutdownHost().android.shutdownTarget(device, signal())).resolves.toEqual({
    success: true,
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  expect(mockRunCmd).toHaveBeenCalledWith(
    'adb',
    ['-s', 'emulator-5554', 'emu', 'kill'],
    expect.objectContaining({ allowFailure: true, timeoutMs: 15_000 }),
  );
});

function shutdownHost() {
  return createDeviceShutdownRuntimeHost();
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function appleDevice(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: 'apple',
    appleOs: 'ios',
    id: 'sim-1',
    name: 'iPhone',
    kind: 'simulator',
    booted: true,
    ...overrides,
  };
}
