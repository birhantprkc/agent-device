import { isIosFamily, type DeviceInfo } from '@agent-device/kernel/device';
import { normalizeError } from '@agent-device/kernel/errors';
import type { TargetShutdownResult } from '@agent-device/contracts/device';
import type { DeviceShutdownRuntimeHost } from '@agent-device/contracts/platform';

const SHUTDOWN_TIMEOUT_MS = 15_000;

function isIosSimulator(device: DeviceInfo): boolean {
  return isIosFamily(device) && device.kind === 'simulator';
}

function isAndroidEmulator(device: DeviceInfo): boolean {
  return device.platform === 'android' && device.kind === 'emulator';
}

export function createDeviceShutdownRuntimeHost(): DeviceShutdownRuntimeHost {
  return Object.freeze({
    apple: Object.freeze({
      shutdownTarget: async (device: DeviceInfo, signal: AbortSignal) =>
        await shutdownLocalTarget(device, signal),
    }),
    android: Object.freeze({
      shutdownTarget: async (device: DeviceInfo, signal: AbortSignal) =>
        await shutdownLocalTarget(device, signal),
    }),
  });
}

/** Close retains this isolated legacy teardown until the close unit migrates. */
export function canShutdownLocalDeviceTarget(device: DeviceInfo): boolean {
  return isIosSimulator(device) || isAndroidEmulator(device);
}

/** Close-only compatibility seam; the canonical `shutdown` command uses the bound operation. */
export async function shutdownLocalDeviceTarget(device: DeviceInfo): Promise<TargetShutdownResult> {
  return await shutdownLocalTarget(device, new AbortController().signal);
}

async function shutdownLocalTarget(
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<TargetShutdownResult> {
  if (device.booted === false) {
    return {
      success: true,
      exitCode: 0,
      stdout: '',
      stderr: '',
    };
  }

  signal.throwIfAborted();
  try {
    if (isIosSimulator(device)) return await shutdownIosSimulator(device, signal);
    if (isAndroidEmulator(device)) return await shutdownAndroidEmulator(device, signal);
    throw new Error(`Cannot shut down unsupported device ${device.platform}/${device.kind}`);
  } catch (error) {
    const normalized = normalizeError(error);
    return {
      success: false,
      exitCode: -1,
      stdout: '',
      stderr: normalized.message,
      error: normalized,
    };
  }
}

async function shutdownIosSimulator(
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<TargetShutdownResult> {
  const { getSimulatorState, shutdownSimulator } =
    await import('./platforms/apple/core/simulator.ts');
  const result = await shutdownSimulator(device);
  signal.throwIfAborted();
  if (result.success) return result;

  const state = await getFinalSimulatorState(device, getSimulatorState);
  if (state === 'Shutdown') {
    return {
      ...result,
      success: true,
      exitCode: 0,
    };
  }

  return result;
}

async function getFinalSimulatorState(
  device: DeviceInfo,
  getSimulatorState: (device: DeviceInfo) => Promise<string | null>,
): Promise<string | null> {
  try {
    return await getSimulatorState(device);
  } catch {
    return null;
  }
}

async function shutdownAndroidEmulator(
  device: DeviceInfo,
  signal: AbortSignal,
): Promise<TargetShutdownResult> {
  const { runAndroidAdb } = await import('./platforms/android/adb.ts');
  const result = await runAndroidAdb(device, ['emu', 'kill'], {
    allowFailure: true,
    timeoutMs: SHUTDOWN_TIMEOUT_MS,
    signal,
  });
  return {
    success: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
