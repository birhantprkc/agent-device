import type { DaemonRequest, DaemonResponse } from '../types.ts';
import { publicPlatformString } from '@agent-device/kernel/device';
import {
  clearRuntimeHintsRuntimeUse,
  configureProviderPortReverseRuntimeUse,
} from '@agent-device/contracts/platform';
import type { ProviderPortReverseOptions } from '@agent-device/contracts/device';
import { SessionStore } from '../session-store.ts';
import { errorResponse } from './response.ts';
import { expireRefFrame } from '../ref-frame.ts';
import { admitRuntimeUse } from '../runtime-admission.ts';
import {
  buildRuntimeHints,
  countConfiguredRuntimeHints,
  hasRuntimeTransportHints,
  mergeRuntimeHints,
  runtimeHintValues,
  toRuntimePlatform,
} from './session-runtime.ts';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';

type RuntimeAction = 'set' | 'show' | 'clear';
type PortReverseParseResult =
  | { ok: true; options: ProviderPortReverseOptions }
  | { ok: false; response: DaemonResponse };
type PortReverseRequiredFields =
  | { ok: true; leaseId: string; provider: string }
  | { ok: false; response: DaemonResponse };
type PortReversePorts =
  | { ok: true; devicePort: number; hostPort: number }
  | { ok: false; response: DaemonResponse };

type RuntimeCommandDevice = NonNullable<ReturnType<SessionStore['get']>>['device'];

type RuntimeCommandAdmission = Readonly<{
  device: RuntimeCommandDevice;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}>;

// `runtime set` and `show` are daemon session policy; this is the sole facts admission and
// implementation binding for the one native effect, clearing applied runtime hints.
async function admitClearRuntime(params: RuntimeCommandAdmission) {
  return await admitRuntimeUse({
    ...params,
    command: 'runtime clear',
    use: clearRuntimeHintsRuntimeUse,
  });
}

// The provider owner is selected by the same facts/bind path as every other runtime operation.
// This deliberately replaces the old provider-name lookup: no ambient request scope or local
// fallback can turn an unsupported provider cell into a host-device tunnel.
async function admitPortReverseRuntime(params: RuntimeCommandAdmission) {
  return await admitRuntimeUse({
    ...params,
    command: 'runtime port-reverse',
    use: configureProviderPortReverseRuntimeUse,
  });
}

export async function handleRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, sessionName, sessionStore } = params;
  const action = (req.positionals?.[0] ?? 'show').toLowerCase();
  if (action === 'port-reverse') {
    return await handlePortReverseCommand({
      req,
      session: sessionStore.get(sessionName),
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }
  if (!isRuntimeAction(action)) {
    return errorResponse('INVALID_ARGS', 'runtime requires set, show, clear, or port-reverse');
  }
  const session = sessionStore.get(sessionName);
  const current = sessionStore.getRuntimeHints(sessionName);
  if (action === 'clear') {
    return await clearRuntimeCommand({
      sessionName,
      sessionStore,
      session,
      current,
      inspectFacts: params.inspectFacts,
      bindDevice: params.bindDevice,
    });
  }
  if (action === 'show') {
    return showRuntimeCommand(sessionName, current);
  }

  return setRuntimeCommand({ req, sessionName, sessionStore, session, current });
}

function isRuntimeAction(action: string): action is RuntimeAction {
  return action === 'set' || action === 'show' || action === 'clear';
}

async function clearRuntimeCommand(params: {
  sessionName: string;
  sessionStore: SessionStore;
  session: ReturnType<SessionStore['get']>;
  current: ReturnType<SessionStore['getRuntimeHints']>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { sessionName, sessionStore, session, current, inspectFacts, bindDevice } = params;
  if (hasRuntimeTransportHints(current) && session?.appBundleId) {
    const admission = await admitClearRuntime({
      device: session.device,
      inspectFacts,
      bindDevice,
    });
    if (admission.type === 'response') return admission.response;
    // Native hint removal can change the app's reachable surface. Expire the existing frame at
    // the mutation boundary, after admission and immediately before the bound package effect.
    expireRefFrame(session);
    await admission.runtime.operations.clearRuntimeHints({
      appId: session.appBundleId,
      values: runtimeHintValues(current),
    });
  }
  const cleared = sessionStore.clearRuntimeHints(sessionName);
  return { ok: true, data: { session: sessionName, cleared } };
}

function showRuntimeCommand(
  sessionName: string,
  current: ReturnType<SessionStore['getRuntimeHints']>,
): DaemonResponse {
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: Boolean(current),
      runtime: current,
    },
  };
}

function sessionLeafPlatform(
  session: ReturnType<SessionStore['get']>,
): ReturnType<typeof publicPlatformString> | undefined {
  return session ? publicPlatformString(session.device) : undefined;
}

function setRuntimeCommand(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  session: ReturnType<SessionStore['get']>;
  current: ReturnType<SessionStore['getRuntimeHints']>;
}): DaemonResponse {
  const { req, sessionName, sessionStore, session, current } = params;
  // approach (b): resolve the session's PUBLIC leaf platform (ios/macos), never the
  // internal `apple`, so the legacy `--platform ios` selector still matches.
  const sessionLeaf = sessionLeafPlatform(session);
  const platform = toRuntimePlatform(req.flags?.platform ?? current?.platform ?? sessionLeaf);
  if (!platform) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set only supports iOS and Android sessions. Pass --platform ios|android or open an iOS/Android session first.',
    );
  }
  if (sessionLeaf !== undefined && sessionLeaf !== platform) {
    return errorResponse(
      'INVALID_ARGS',
      `runtime set targets ${platform}, but session "${sessionName}" is already bound to ${sessionLeaf}.`,
    );
  }
  const nextRuntime = mergeRuntimeHints(current, buildRuntimeHints(req.flags, platform));
  if (countConfiguredRuntimeHints(nextRuntime) === 0) {
    return errorResponse(
      'INVALID_ARGS',
      'runtime set requires at least one hint such as --metro-host, --metro-port, --bundle-url, or --launch-url.',
    );
  }
  sessionStore.setRuntimeHints(sessionName, nextRuntime);
  return {
    ok: true,
    data: {
      session: sessionName,
      configured: true,
      runtime: nextRuntime,
    },
  };
}

async function handlePortReverseCommand(params: {
  req: DaemonRequest;
  session: ReturnType<SessionStore['get']>;
  inspectFacts?: InspectDeviceRuntimeFacts;
  bindDevice?: BindDeviceRuntime;
}): Promise<DaemonResponse> {
  const { req, session, inspectFacts, bindDevice } = params;
  const parsed = readPortReverseOptions(req);
  if (!parsed.ok) return parsed.response;
  if (!session) {
    return errorResponse(
      'SESSION_NOT_FOUND',
      'runtime port-reverse requires an active provider-owned session.',
    );
  }
  const admission = await admitPortReverseRuntime({
    device: session.device,
    inspectFacts,
    bindDevice,
  });
  if (admission.type === 'response') return admission.response;
  if (
    admission.runtime.owner.kind !== 'provider-runtime' ||
    admission.runtime.owner.provider !== parsed.options.provider
  ) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'The active session is not owned by the requested port-reverse provider.',
      { provider: parsed.options.provider },
    );
  }
  const result = await admission.runtime.operations.configureProviderPortReverse(parsed.options);
  if (!result) {
    return errorResponse(
      'UNSUPPORTED_OPERATION',
      'No active provider device runtime supports port reverse for this lease.',
    );
  }
  return {
    ok: true,
    data: {
      action: 'port-reverse',
      ...result,
    },
  };
}

function readPortReverseOptions(req: DaemonRequest): PortReverseParseResult {
  const required = readRequiredPortReverseFields(req);
  if (!required.ok) return required;
  const ports = readPortReversePorts(req);
  if (!ports.ok) return ports;
  const name = req.flags?.portReverseName?.trim() || 'runtime';
  return {
    ok: true,
    options: {
      leaseId: required.leaseId,
      provider: required.provider,
      devicePort: ports.devicePort,
      hostPort: ports.hostPort,
      name,
    },
  };
}

function readRequiredPortReverseFields(req: DaemonRequest): PortReverseRequiredFields {
  const leaseId = req.flags?.leaseId;
  const provider = req.flags?.leaseProvider;
  if (!leaseId) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires a resolved remote lease.',
      ),
    };
  }
  if (!provider) {
    return {
      ok: false,
      response: errorResponse('INVALID_ARGS', 'runtime port-reverse requires a lease provider.'),
    };
  }
  return { ok: true, leaseId, provider };
}

function readPortReversePorts(req: DaemonRequest): PortReversePorts {
  const devicePort = readTcpPort(req.flags?.devicePort);
  const hostPort = readTcpPort(req.flags?.hostPort ?? req.flags?.devicePort);
  if (!devicePort || !hostPort) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        'runtime port-reverse requires numeric devicePort and hostPort values from 1 to 65535.',
      ),
    };
  }
  return { ok: true, devicePort, hostPort };
}

function readTcpPort(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 65_535) {
    return undefined;
  }
  return value;
}
