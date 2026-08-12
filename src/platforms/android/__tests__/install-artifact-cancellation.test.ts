import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { test, vi } from 'vitest';
import { mkdtempForTest } from '../../../__tests__/test-utils/tmp-dir.ts';
import { prepareAndroidInstallArtifact } from '../install-artifact.ts';
import * as manifest from '../manifest.ts';

test('aborts an in-flight Android artifact identity probe', async () => {
  const tempRoot = await mkdtempForTest('agent-device-android-artifact-abort-');
  const archivePath = path.join(tempRoot, 'app.apk');
  await fs.writeFile(archivePath, 'fixture');
  const controller = new AbortController();
  const probe = vi
    .spyOn(manifest, 'resolveAndroidArchivePackageName')
    .mockImplementation(async (_path, signal) => {
      assert.equal(signal, controller.signal);
      await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    });

  try {
    const pending = prepareAndroidInstallArtifact(
      { kind: 'path', path: archivePath },
      { signal: controller.signal },
    );
    await vi.waitFor(() => assert.equal(probe.mock.calls.length, 1));
    controller.abort(new DOMException('cancelled', 'AbortError'));
    await assert.rejects(pending, { name: 'AbortError' });
  } finally {
    probe.mockRestore();
  }
});
