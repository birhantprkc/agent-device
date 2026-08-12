import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '@agent-device/kernel/errors';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { resolveFileOverridePath, runCmd, whichCmd } from '../../utils/exec.ts';
import { waitForAndroidBoot } from './emulator-lifecycle.ts';
import { runAndroidAdb } from './adb.ts';
import {
  androidAdbResultError,
  installAndroidAdbPackage,
  resolveAndroidAdbProvider,
} from './adb-executor.ts';
import {
  resolveAndroidApp,
  withAndroidAppResolutionCacheInvalidated,
} from './app-deployment-resolution.ts';

type AndroidDeploymentSignalOptions = Readonly<{ signal?: AbortSignal }>;

/** Removes an installed package after resolving aliases and fuzzy application names. */
export async function uninstallAndroidApp(
  device: DeviceInfo,
  app: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<{ package: string }> {
  const resolved = await resolveAndroidApp(device, app);
  if (resolved.type === 'intent') {
    throw new AppError('INVALID_ARGS', 'App uninstall requires a package name, not an intent');
  }
  const result = await runAndroidAdb(device, ['uninstall', resolved.value], {
    allowFailure: true,
    signal: options.signal,
  });
  if (result.exitCode !== 0) {
    const output = `${result.stdout}\n${result.stderr}`.toLowerCase();
    if (!output.includes('unknown package') && !output.includes('not installed')) {
      throw androidAdbResultError(`adb uninstall failed for ${resolved.value}`, result);
    }
  }
  return { package: resolved.value };
}

type BundletoolInvocation =
  | { cmd: 'bundletool'; prefixArgs: readonly string[] }
  | { cmd: 'java'; prefixArgs: readonly string[] };

let cachedBundletoolInvocation: { key: string; invocation: BundletoolInvocation } | null = null;

function bundletoolInvocationCacheKey(): string {
  return `${process.env.PATH ?? ''}::${process.env.AGENT_DEVICE_BUNDLETOOL_JAR ?? ''}`;
}

async function resolveBundletoolInvocation(): Promise<BundletoolInvocation> {
  const cacheKey = bundletoolInvocationCacheKey();
  if (cachedBundletoolInvocation?.key === cacheKey) {
    return cachedBundletoolInvocation.invocation;
  }

  if (await whichCmd('bundletool')) {
    const invocation = { cmd: 'bundletool', prefixArgs: [] } as const;
    cachedBundletoolInvocation = { key: cacheKey, invocation };
    return invocation;
  }

  const bundletoolJar = await resolveFileOverridePath(
    process.env.AGENT_DEVICE_BUNDLETOOL_JAR,
    'AGENT_DEVICE_BUNDLETOOL_JAR',
  );
  if (!bundletoolJar) {
    throw new AppError(
      'TOOL_MISSING',
      'bundletool not found in PATH. Install bundletool or set AGENT_DEVICE_BUNDLETOOL_JAR to a bundletool-all.jar path.',
    );
  }
  const invocation = { cmd: 'java', prefixArgs: ['-jar', bundletoolJar] } as const;
  cachedBundletoolInvocation = { key: cacheKey, invocation };
  return invocation;
}

async function runBundletool(args: string[], signal?: AbortSignal): Promise<void> {
  const invocation = await resolveBundletoolInvocation();
  await runCmd(invocation.cmd, [...invocation.prefixArgs, ...args], { signal });
}

function isAndroidAppBundlePath(appPath: string): boolean {
  return path.extname(appPath).toLowerCase() === '.aab';
}

async function installAndroidAppBundle(
  device: DeviceInfo,
  appPath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  const provider = resolveAndroidAdbProvider(device);
  const mode = 'universal';
  if (provider.installBundle) {
    await provider.installBundle(appPath, { mode, signal: options.signal });
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-device-aab-'));
  const apksPath = path.join(tempDir, 'bundle.apks');
  try {
    await runBundletool(
      ['build-apks', '--bundle', appPath, '--output', apksPath, '--mode', mode],
      options.signal,
    );
    await runBundletool(
      ['install-apks', '--apks', apksPath, '--device-id', device.id],
      options.signal,
    );
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

async function installAndroidAppFiles(
  device: DeviceInfo,
  appPath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  if (isAndroidAppBundlePath(appPath)) {
    await installAndroidAppBundle(device, appPath, options);
    return;
  }
  await installAndroidAdbPackage(appPath, {
    device,
    replace: true,
    signal: options.signal,
  });
}

async function listInstalledAndroidPackages(
  device: DeviceInfo,
  options: AndroidDeploymentSignalOptions = {},
): Promise<Set<string>> {
  const result = await runAndroidAdb(device, ['shell', 'pm', 'list', 'packages'], {
    signal: options.signal,
  });
  return new Set(
    result.stdout
      .split('\n')
      .map((line: string) => line.replace('package:', '').trim())
      .filter(Boolean),
  );
}

async function resolveInstalledAndroidPackageName(
  device: DeviceInfo,
  beforePackages: Set<string>,
  options: AndroidDeploymentSignalOptions = {},
): Promise<string | undefined> {
  const afterPackages = await listInstalledAndroidPackages(device, options);
  const installedNow = Array.from(afterPackages).filter((pkg) => !beforePackages.has(pkg));
  if (installedNow.length === 1) return installedNow[0];
  return undefined;
}

/** Installs an APK/AAB behind one cache invalidation transaction. */
export async function installAndroidInstallablePath(
  device: DeviceInfo,
  installablePath: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<void> {
  await withAndroidAppResolutionCacheInvalidated(device, async () => {
    if (!device.booted) {
      await waitForAndroidBoot(device.id, undefined, options.signal);
    }
    await installAndroidAppFiles(device, installablePath, options);
  });
}

/** Installs an artifact and returns the new package identity when it can be observed. */
export async function installAndroidInstallablePathAndResolvePackageName(
  device: DeviceInfo,
  installablePath: string,
  packageNameHint?: string,
  options: AndroidDeploymentSignalOptions = {},
): Promise<string | undefined> {
  const beforePackages = packageNameHint
    ? undefined
    : await listInstalledAndroidPackages(device, options);
  await installAndroidInstallablePath(device, installablePath, options);
  return (
    packageNameHint ??
    (beforePackages
      ? await resolveInstalledAndroidPackageName(device, beforePackages, options)
      : undefined)
  );
}
