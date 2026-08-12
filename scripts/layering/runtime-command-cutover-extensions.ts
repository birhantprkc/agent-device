import { parseSync } from 'oxc-parser';
import { propertyName, visitAst, type ProductionSource } from './cutover-policy-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

type AstNode = Record<string, unknown>;

const DEVICES_HANDLER_FILE = 'src/daemon/handlers/session-inventory.ts';
const DEVICES_INVENTORY_IMPORT_SOURCES = new Set([
  '../../core/device-inventory-context.ts',
  '../../core/dispatch-resolve.ts',
]);
const DEVICES_GATEWAY_BINDING = 'listDeviceInventory';
const APP_LOG_SESSION_STATE_OWNERS = new Set([
  'src/daemon/app-log-session-resource.ts',
  'src/daemon/types.ts',
]);
const APP_STATE_HANDLER_FILE = 'src/daemon/handlers/session-state.ts';
const APP_STATE_LEGACY_IMPORT_SOURCES = new Set([
  '../../platforms/android/app-lifecycle.ts',
  '../../platforms/harmonyos/app-lifecycle.ts',
]);
const APP_STATE_LEGACY_CALLS = new Set(['getAndroidAppState', 'getHarmonyAppState']);

/**
 * `admitRuntimeUse` performs the facts inspection and the bind itself; `admitRuntimeOperations`
 * performs the inspection and hands back the bind for a route that selects among exactly-typed
 * uses. Both live in the one admission module, which this file gates separately.
 */
const RUNTIME_ADMISSION_MODULE = 'src/daemon/runtime-admission.ts';
const APPLICATION_RESOURCES_FILE = 'src/platform-runtime-application-resources.ts';
const RUNTIME_ADMISSION_HELPERS = ['admitRuntimeUse', 'admitRuntimeOperations'];

type LifecycleAdmissionRule = Readonly<{ functionName: string }>;

type LifecycleHandlerRule = Readonly<{
  command: 'open' | 'prepare' | 'close' | 'runtime';
  file: string;
  admissions: readonly LifecycleAdmissionRule[];
  forbiddenCalls: readonly string[];
}>;

// A handler that calls its injected gateway directly would bypass the shared admission seam, so
// the raw ports are forbidden call names in every lifecycle route.
const RAW_RUNTIME_GATEWAY_CALLS = ['inspectFacts', 'bindDevice'];

const LIFECYCLE_HANDLER_RULES = {
  open: {
    command: 'open',
    file: 'src/daemon/handlers/session-open.ts',
    admissions: [{ functionName: 'admitOpenRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'resolveSoleForegroundIosApp',
      'runAndroidAdb',
      'runXcrun',
      'shutdownDeviceTarget',
    ],
  },
  prepare: {
    command: 'prepare',
    file: 'src/daemon/handlers/session-prepare.ts',
    admissions: [{ functionName: 'admitPrepareRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'prepareIosRunner',
      'runXcrun',
      'shutdownDeviceTarget',
    ],
  },
  close: {
    command: 'close',
    file: 'src/daemon/handlers/session-close-runtime-admission.ts',
    admissions: [{ functionName: 'admitCloseRuntime' }],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'shutdownDeviceTarget',
      'runAndroidAdb',
      'runXcrun',
    ],
  },
  runtime: {
    command: 'runtime',
    file: 'src/daemon/handlers/session-runtime-command.ts',
    admissions: [
      { functionName: 'admitClearRuntime' },
      { functionName: 'admitPortReverseRuntime' },
    ],
    forbiddenCalls: [
      ...RAW_RUNTIME_GATEWAY_CALLS,
      'dispatchCommand',
      'shutdownDeviceTarget',
      'runAndroidAdb',
      'runXcrun',
    ],
  },
} satisfies Record<'open' | 'prepare' | 'close' | 'runtime', LifecycleHandlerRule>;

/**
 * Lifecycle command routes own exactly one side-effect-free facts admission and one binding
 * gateway per native plan. The `runtime` descriptor has two disjoint native plans (clear and
 * provider port-reverse); each is checked independently so session-only set/show policy stays out
 * of the platform-runtime denominator.
 */
export const openLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.open);
export const prepareLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.prepare);
export const closeLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.close);
export const runtimeLifecycleRouteBindingViolations = (sources: ReadonlyMap<string, string>) =>
  lifecycleHandlerRouteBindingViolations(sources, LIFECYCLE_HANDLER_RULES.runtime);

function lifecycleHandlerRouteBindingViolations(
  sources: ReadonlyMap<string, string>,
  rule: LifecycleHandlerRule,
): UnruledViolation[] {
  const source = sources.get(rule.file);
  if (source === undefined) {
    return [
      {
        file: rule.file,
        line: 1,
        message: `${rule.command} lifecycle handler module is missing`,
      },
    ];
  }
  const program = parseSync(rule.file, source).program as AstNode;
  const violations: UnruledViolation[] = [];
  for (const admission of rule.admissions) {
    const functionNode = namedFunction(program, admission.functionName);
    if (functionNode === undefined) {
      violations.push({
        file: rule.file,
        line: 1,
        message: `${rule.command} must retain its ${admission.functionName} admission seam`,
      });
      continue;
    }
    const admissionCalls = RUNTIME_ADMISSION_HELPERS.reduce(
      (total, helper) => total + countNamedCalls(functionNode, helper),
      0,
    );
    if (admissionCalls !== 1) {
      violations.push({
        file: rule.file,
        line: lineOf(source, functionNode),
        message: `${rule.command} ${admission.functionName} must make one shared runtime admission call (found ${admissionCalls})`,
      });
    }
  }
  visitAst(program, (node) => {
    const call = callName(node);
    if (call === undefined || !rule.forbiddenCalls.includes(call)) return;
    violations.push({
      file: rule.file,
      line: lineOf(source, node),
      message: `${rule.command} handler reaches legacy or local platform call ${call} outside its bound runtime`,
    });
  });
  violations.push(...sharedRuntimeAdmissionViolations(sources));
  return violations;
}

/**
 * Every lifecycle row delegates its "one side-effect-free inspection, one bind" promise to the
 * shared module, so the promise is proven once at that module rather than re-detected per handler.
 */
function sharedRuntimeAdmissionViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(RUNTIME_ADMISSION_MODULE);
  if (source === undefined) {
    return [
      {
        file: RUNTIME_ADMISSION_MODULE,
        line: 1,
        message: 'shared runtime admission module is missing',
      },
    ];
  }
  const program = parseSync(RUNTIME_ADMISSION_MODULE, source).program as AstNode;
  const admit = namedFunction(program, 'admitRuntimeOperations');
  if (admit === undefined) {
    return [
      {
        file: RUNTIME_ADMISSION_MODULE,
        line: 1,
        message: 'shared runtime admission must expose admitRuntimeOperations',
      },
    ];
  }
  const violations: UnruledViolation[] = [];
  for (const [helper, role] of [
    ['requireFactsInspection', 'facts inspection'],
    ['requireDeviceBinding', 'binding'],
  ] as const) {
    const calls = countNamedCalls(admit, helper);
    if (calls !== 1) {
      violations.push({
        file: RUNTIME_ADMISSION_MODULE,
        line: lineOf(source, admit),
        message: `shared runtime admission must make one ${role} call (found ${calls})`,
      });
    }
  }
  return violations;
}

/** Durable lifecycle evidence that remains shared by the four descriptor rows. */
export function applicationLifecycleDurableResourceViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  // The neutral gateway registers the fence; the host composition names the durable owners. Both
  // halves are required, and neither may absorb the other's role.
  const gateway = sources.get('src/platform-runtime-gateway.ts');
  if (
    gateway === undefined ||
    !gateway.includes('runStartupRecoveryFence') ||
    gateway.includes('androidApplications') ||
    gateway.includes('appleApplications')
  ) {
    violations.push({
      file: 'src/platform-runtime-gateway.ts',
      line: 1,
      message:
        'the composed runtime gateway must register the startup fence and name no platform-specific durable owner',
    });
  }
  const resources = sources.get(APPLICATION_RESOURCES_FILE);
  if (
    resources === undefined ||
    resources.indexOf('hasTestImeRecoveryEvidence') < 0 ||
    resources.indexOf('hasTestImeRecoveryEvidence') > resources.indexOf('recoverTestImeStartup')
  ) {
    violations.push({
      file: APPLICATION_RESOURCES_FILE,
      line: 1,
      message:
        'durable startup recovery must gate lazy Android test-IME recovery behind its marker evidence',
    });
  }
  const ime = sources.get('src/platforms/android/ime-lifecycle.ts');
  if (
    ime === undefined ||
    ime.indexOf('await waitForStartupRecoveryFence') < 0 ||
    ime.indexOf('await waitForStartupRecoveryFence') >
      ime.indexOf('const adb = resolveAndroidAdbExecutor')
  ) {
    violations.push({
      file: 'src/platforms/android/ime-lifecycle.ts',
      line: 1,
      message:
        'Android test-IME mutation must wait for startup recovery before loading ADB mechanics',
    });
  }
  const captureKitUnavailable = sources.get(
    'packages/capture-kit/src/platform-runtime-unavailable.ts',
  );
  const captureKitIndex = sources.get('packages/capture-kit/src/index.ts');
  if (
    captureKitUnavailable !== undefined ||
    captureKitIndex?.includes('createUnavailablePlatformRuntime') === true
  ) {
    violations.push({
      file: 'packages/capture-kit/src/index.ts',
      line: 1,
      message: 'capture-kit must not own a generic platform-runtime lifecycle role',
    });
  }
  return violations;
}

/**
 * `devices` proves its single inventory route by binding identity, not by name: the
 * handler must import the neutral gateway, must not shadow the binding it imported, and
 * must actually call it. No other migrated command routes through a named gateway
 * binding, so this stays a row extension rather than a table column.
 */
export function devicesGatewayBindingViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(DEVICES_HANDLER_FILE);
  if (source === undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: 'devices gateway-owned handler module is missing',
      },
    ];
  }
  const program = parseSync(DEVICES_HANDLER_FILE, source).program as AstNode;
  const binding = importedGatewayBinding(program);
  if (binding === undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: `devices handler must import ${DEVICES_GATEWAY_BINDING} from the neutral inventory owner`,
      },
    ];
  }
  const shadow = shadowingBindingSite(program, binding);
  if (shadow !== undefined) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: lineOf(source, shadow),
        message: `devices handler shadows its imported ${DEVICES_GATEWAY_BINDING} binding`,
      },
    ];
  }
  if (!callsBinding(program, binding)) {
    return [
      {
        file: DEVICES_HANDLER_FILE,
        line: 1,
        message: `devices handler must call its imported ${DEVICES_GATEWAY_BINDING} binding`,
      },
    ];
  }
  return [];
}

/**
 * The app-log session record has one whole-record replacement owner (ADR 0019 §4-5).
 * `logs` is the durable-resource pilot; request-scoped rows own no session record, so
 * this stays a row extension.
 */
export function appLogSessionStateOwnershipViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  for (const file of productionSources(sources)) {
    if (!file.path.startsWith('src/daemon/') || APP_LOG_SESSION_STATE_OWNERS.has(file.path)) {
      continue;
    }
    const program = parseSync(file.path, file.source).program as AstNode;
    visitAst(program, (node) => {
      if (node['type'] !== 'Property' || node['kind'] !== 'init' || node['computed'] === true) {
        return;
      }
      const field = propertyName(node['key']);
      if (
        (field === 'appLog' || field === 'appLogFailure') &&
        !isAppLogTeardownDiscriminant(field, node['value'])
      ) {
        violations.push({
          file: file.path,
          line: lineOf(file.source, node),
          message: `session ${field} record constructed outside its owner`,
        });
      }
    });
  }
  return violations;
}

/**
 * Source-executed TypeScript must stay parseable by the Node 22 type-stripping runtime.
 * Not command-specific: it is declared on the logs row so its violations carry R14, the
 * id the layering report groups them under.
 */
export function sourceExecutedUsingDeclarationViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const violations: UnruledViolation[] = [];
  for (const file of productionSources(sources)) {
    const program = parseSync(file.path, file.source).program as AstNode;
    visitAst(program, (node) => {
      if (
        node['type'] === 'VariableDeclaration' &&
        (node['kind'] === 'using' || node['kind'] === 'await using')
      ) {
        violations.push({
          file: file.path,
          line: lineOf(file.source, node),
          message: `source-executed TypeScript uses unsupported ${String(node['kind'])} declaration`,
        });
      }
    });
  }
  return violations;
}

/**
 * `appstate` retires the handler's direct Android/Harmony lifecycle dispatch. Other
 * daemon commands still use those helpers, so the proof is deliberately scoped to the
 * appstate handler instead of claiming a repository-wide symbol deletion.
 */
export function appStateLegacySessionHandlerViolations(
  sources: ReadonlyMap<string, string>,
): UnruledViolation[] {
  const source = sources.get(APP_STATE_HANDLER_FILE);
  if (source === undefined) {
    return [
      {
        file: APP_STATE_HANDLER_FILE,
        line: 1,
        message: 'appstate handler module is missing',
      },
    ];
  }
  const violations: UnruledViolation[] = [];
  const program = parseSync(APP_STATE_HANDLER_FILE, source).program as AstNode;
  visitAst(program, (node) => {
    if (node['type'] === 'ImportDeclaration') {
      const importSource = (node['source'] as AstNode | undefined)?.['value'];
      if (typeof importSource === 'string' && APP_STATE_LEGACY_IMPORT_SOURCES.has(importSource)) {
        violations.push({
          file: APP_STATE_HANDLER_FILE,
          line: lineOf(source, node),
          message: 'appstate handler imports a legacy platform app-state module',
        });
      }
      return;
    }
    if (
      node['type'] === 'CallExpression' &&
      APP_STATE_LEGACY_CALLS.has(identifierName(node['callee']) ?? '')
    ) {
      violations.push({
        file: APP_STATE_HANDLER_FILE,
        line: lineOf(source, node),
        message: 'appstate handler calls a legacy platform app-state backend',
      });
    }
  });
  return violations;
}

function productionSources(sources: ReadonlyMap<string, string>): ProductionSource[] {
  return [...sources].map(([path, source]) => ({ path, source }));
}

function isAppLogTeardownDiscriminant(field: string, valueNode: unknown): boolean {
  if (field !== 'appLog' || valueNode === null || typeof valueNode !== 'object') return false;
  const value = valueNode as AstNode;
  return (
    value['type'] === 'Literal' &&
    (value['value'] === 'run' || value['value'] === 'already-settled')
  );
}

function importedGatewayBinding(program: AstNode): string | undefined {
  const body = program['body'];
  if (!Array.isArray(body)) return undefined;
  for (const statement of body as AstNode[]) {
    if (statement['type'] !== 'ImportDeclaration') continue;
    const source = statement['source'] as AstNode | undefined;
    const specifier = source === undefined ? undefined : source['value'];
    if (typeof specifier !== 'string' || !DEVICES_INVENTORY_IMPORT_SOURCES.has(specifier)) continue;
    const specifiers = statement['specifiers'];
    if (!Array.isArray(specifiers)) continue;
    for (const imported of specifiers as AstNode[]) {
      if (
        imported['type'] === 'ImportSpecifier' &&
        identifierName(imported['imported']) === DEVICES_GATEWAY_BINDING
      ) {
        return identifierName(imported['local']);
      }
    }
  }
  return undefined;
}

function callsBinding(program: AstNode, binding: string): boolean {
  let called = false;
  visitAst(program, (node) => {
    if (node['type'] === 'CallExpression' && identifierName(node['callee']) === binding) {
      called = true;
    }
  });
  return called;
}

function shadowingBindingSite(program: AstNode, binding: string): AstNode | undefined {
  let found: AstNode | undefined;
  visitAst(program, (node) => {
    if (found !== undefined) return;
    if (
      node['type'] === 'VariableDeclarator' ||
      node['type'] === 'FunctionDeclaration' ||
      node['type'] === 'FunctionExpression' ||
      node['type'] === 'ClassDeclaration' ||
      node['type'] === 'ClassExpression'
    ) {
      if (patternBinds(node['id'], binding)) found = node;
      if (found === undefined && bindsInParams(node, binding)) found = node;
      return;
    }
    if (node['type'] === 'ArrowFunctionExpression' && bindsInParams(node, binding)) {
      found = node;
      return;
    }
    if (node['type'] === 'CatchClause' && patternBinds(node['param'], binding)) found = node;
  });
  return found;
}

function bindsInParams(node: AstNode, binding: string): boolean {
  const params = node['params'];
  return Array.isArray(params) && params.some((param) => patternBinds(param, binding));
}

function patternBinds(node: unknown, binding: string): boolean {
  if (node === null || typeof node !== 'object') return false;
  const record = node as AstNode;
  if (record['type'] === 'Identifier') return record['name'] === binding;
  if (record['type'] === 'RestElement') return patternBinds(record['argument'], binding);
  if (record['type'] === 'AssignmentPattern') return patternBinds(record['left'], binding);
  if (record['type'] === 'TSParameterProperty') return patternBinds(record['parameter'], binding);
  if (record['type'] === 'ArrayPattern') {
    const elements = record['elements'];
    return Array.isArray(elements) && elements.some((element) => patternBinds(element, binding));
  }
  if (record['type'] === 'ObjectPattern') {
    const properties = record['properties'];
    return (
      Array.isArray(properties) &&
      properties.some((property) => {
        if (property === null || typeof property !== 'object') return false;
        const entry = property as AstNode;
        return entry['type'] === 'Property'
          ? patternBinds(entry['value'], binding)
          : patternBinds(entry['argument'], binding);
      })
    );
  }
  return false;
}

function identifierName(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const record = node as AstNode;
  return record['type'] === 'Identifier' && typeof record['name'] === 'string'
    ? record['name']
    : undefined;
}

function namedFunction(program: AstNode, expected: string): AstNode | undefined {
  let found: AstNode | undefined;
  visitAst(program, (node) => {
    if (found !== undefined || node['type'] !== 'FunctionDeclaration') return;
    if (identifierName(node['id']) === expected) found = node;
  });
  return found;
}

function countNamedCalls(functionNode: AstNode, expected: string): number {
  let count = 0;
  visitAst(functionNode['body'], (node) => {
    if (callName(node) === expected) count += 1;
  });
  return count;
}

function callName(node: AstNode): string | undefined {
  if (node['type'] !== 'CallExpression') return undefined;
  const callee = node['callee'] as AstNode | undefined;
  if (callee?.['type'] === 'Identifier') return identifierName(callee);
  if (callee?.['type'] === 'MemberExpression') return propertyName(callee['property']);
  return undefined;
}

function lineOf(source: string, node: AstNode): number {
  return source.slice(0, (node['start'] as number | undefined) ?? 0).split('\n').length;
}
