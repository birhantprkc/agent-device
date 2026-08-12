import type { AndroidToolHost } from '@agent-device/contracts/platform';

/** Provider-aware Android transport. Command semantics and arguments stay package-owned. */
export function createAndroidToolHost(): AndroidToolHost {
  return Object.freeze({
    runAdb: async (device, args, options, signal) => {
      const { runAndroidAdb } = await import('./platforms/android/adb.ts');
      const result = await runAndroidAdb(device, [...args], {
        allowFailure: options.allowFailure,
        timeoutMs: options.timeoutMs,
        signal,
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    installPackage: async (device, packagePath, options, signal) => {
      const { resolveAndroidAdbProvider } = await import('./platforms/android/adb-executor.ts');
      const provider = resolveAndroidAdbProvider(device);
      const result = provider.install
        ? await provider.install(packagePath, { replace: options.replace, signal })
        : await provider.exec(['install', ...(options.replace ? ['-r'] : []), packagePath], {
            signal,
          });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    installBundle: async (device, bundlePath, mode, signal) => {
      const { resolveAndroidAdbProvider } = await import('./platforms/android/adb-executor.ts');
      const installer = resolveAndroidAdbProvider(device).installBundle;
      if (!installer) return false;
      await installer(bundlePath, { mode, signal });
      return true;
    },
  });
}
