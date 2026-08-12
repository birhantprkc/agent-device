import os from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { SnapshotQualityVerdict } from '@agent-device/kernel/snapshot';
import { makeIosSession } from '../../__tests__/test-utils/session-factories.ts';
import { SessionStore } from '../session-store.ts';
import { dispatchSnapshotViaRuntime } from '../snapshot-runtime.ts';

const dispatchCommandMock = vi.hoisted(() => vi.fn());

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: dispatchCommandMock,
  };
});

const SPARSE: SnapshotQualityVerdict = {
  state: 'sparse',
  backend: 'private-ax',
  reason: 'snapshot returned no semantic controls or content',
  reasonCode: 'sparse-tree',
};

function scenario() {
  const root = path.join(os.tmpdir(), `agent-device-sparse-fallback-${crypto.randomUUID()}`);
  const sessionStore = new SessionStore(path.join(root, 'sessions'));
  const sessionName = 'default';
  sessionStore.set(sessionName, makeIosSession(sessionName, { appBundleId: 'com.example.app' }));
  return { sessionStore, sessionName, logPath: path.join(root, 'daemon.log') };
}

/** Snapshot captures answer with the seeded verdict; screenshot captures answer per `screenshot`. */
function seed(
  verdict: SnapshotQualityVerdict,
  screenshot: () => Promise<Record<string, unknown>> = async () => ({ width: 390, height: 844 }),
) {
  dispatchCommandMock.mockReset();
  dispatchCommandMock.mockImplementation(async (_device: unknown, command: string) =>
    command === 'screenshot'
      ? await screenshot()
      : {
          backend: 'xctest',
          truncated: false,
          quality: verdict,
          nodes: [{ index: 0, depth: 0, type: 'Application', label: 'Demo' }],
        },
  );
}

async function dispatch(input: ReturnType<typeof scenario>, internalObservation = false) {
  const response = await dispatchSnapshotViaRuntime({
    req: {
      command: 'snapshot',
      positionals: [],
      token: 't',
      session: input.sessionName,
      ...(internalObservation ? { internal: { observationOnly: true } } : {}),
    },
    sessionName: input.sessionName,
    logPath: input.logPath,
    sessionStore: input.sessionStore,
  });
  if (!response.ok) throw new Error('expected ok response');
  return (response.data?.warnings ?? []) as string[];
}

function screenshotCalls() {
  return dispatchCommandMock.mock.calls.filter((call) => call[1] === 'screenshot');
}

function fallbackLine(warnings: string[]): string | undefined {
  return warnings.find((line) => line.startsWith('Captured a screenshot of this screen'));
}

test('a sparse snapshot captures the screenshot its own remedy asks for and links it', async () => {
  const input = scenario();
  seed(SPARSE);

  const warnings = await dispatch(input);

  expect(screenshotCalls()).toHaveLength(1);
  expect(fallbackLine(warnings)).toMatch(/\.png$/);
  // The verdict's own two lines still stand: the refs are invalid, and a screen that
  // publishes nothing is an app defect worth reporting.
  expect(warnings.some((line) => line.startsWith('No snapshot backend could read'))).toBe(true);
  expect(warnings.some((line) => line.includes('app accessibility bug'))).toBe(true);
});

test('a readable snapshot never pays for a screenshot', async () => {
  const input = scenario();
  seed({ state: 'healthy', backend: 'tree' });

  const warnings = await dispatch(input);

  expect(screenshotCalls()).toHaveLength(0);
  expect(fallbackLine(warnings)).toBeUndefined();
});

test('internal observations stay silent so a polling wait cannot shoot once per poll', async () => {
  const input = scenario();
  seed(SPARSE);

  const warnings = await dispatch(input, true);

  expect(screenshotCalls()).toHaveLength(0);
  expect(fallbackLine(warnings)).toBeUndefined();
});

test('a failed fallback screenshot does not fail the snapshot that was asked for', async () => {
  const input = scenario();
  seed(SPARSE, async () => {
    throw new Error('screenshot dispatch exploded');
  });

  const warnings = await dispatch(input);

  expect(screenshotCalls()).toHaveLength(1);
  expect(fallbackLine(warnings)).toBeUndefined();
  // The manual remedy is still on the response, so the caller is not left without one.
  expect(warnings.some((line) => line.includes('Use screenshot as visual truth'))).toBe(true);
});
