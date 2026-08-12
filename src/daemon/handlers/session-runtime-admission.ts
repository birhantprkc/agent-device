import type { RuntimeOperationFact } from '@agent-device/contracts/platform';
import { AppError } from '@agent-device/kernel/errors';
import type { BindDeviceRuntime, InspectDeviceRuntimeFacts } from '../request-runtime-binding.ts';
import type { DaemonResponse } from '../types.ts';
import { errorResponse } from './response.ts';

/** Shared facts-first admission for request-scoped runtime command handlers. */
export function unavailableRuntimeOperationResponse(
  command: string,
  fact: RuntimeOperationFact,
): DaemonResponse | undefined {
  if (fact.available) return undefined;
  return errorResponse(
    'UNSUPPORTED_OPERATION',
    `${command} is not supported on this device`,
    { reason: fact.reason },
    fact.hint ? { hint: fact.hint } : undefined,
  );
}

export function requireRuntimeFacts(
  inspectFacts: InspectDeviceRuntimeFacts | undefined,
): InspectDeviceRuntimeFacts {
  if (inspectFacts) return inspectFacts;
  throw new AppError('COMMAND_FAILED', 'Device runtime facts inspection is unavailable.');
}

export function requireRuntimeBinding(
  bindDevice: BindDeviceRuntime | undefined,
): BindDeviceRuntime {
  if (bindDevice) return bindDevice;
  throw new AppError('COMMAND_FAILED', 'Device runtime binding is unavailable.');
}
