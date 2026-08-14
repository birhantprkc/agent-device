import { parseSync } from 'oxc-parser';
import { propertyName, visitAst } from './cutover-policy-ast.ts';
import { lineOf, type CutoverAstNode } from './runtime-command-cutover-ast.ts';
import type { UnruledViolation } from './runtime-command-cutover-model.ts';

const COMMAND_DESCRIPTOR_MODULE = 'src/core/command-descriptor/registry.ts';

/** A device-runtime cutover must remove the command from the legacy dispatch projection. */
export function retiredDispatchProjectionViolations(
  sources: ReadonlyMap<string, string>,
  command: string,
): UnruledViolation[] {
  const source = sources.get(COMMAND_DESCRIPTOR_MODULE);
  if (source === undefined) {
    return [
      {
        file: COMMAND_DESCRIPTOR_MODULE,
        line: 1,
        message: `${command} command descriptor module is missing`,
      },
    ];
  }
  const program = parseSync(COMMAND_DESCRIPTOR_MODULE, source).program as CutoverAstNode;
  let descriptor: CutoverAstNode | undefined;
  visitAst(program, (node) => {
    if (node.type !== 'ObjectExpression') return;
    const properties = objectProperties(node);
    const name = properties.find((property) => propertyName(property.key) === 'name');
    if (literalString(name?.value) !== command) return;
    if (!properties.some((property) => propertyName(property.key) === 'platformExecution')) return;
    descriptor = node;
  });
  if (descriptor === undefined) {
    return [
      {
        file: COMMAND_DESCRIPTOR_MODULE,
        line: 1,
        message: `${command} command descriptor is missing`,
      },
    ];
  }
  const dispatch = objectProperties(descriptor).find(
    (property) => propertyName(property.key) === 'dispatch',
  );
  return dispatch === undefined
    ? []
    : [
        {
          file: COMMAND_DESCRIPTOR_MODULE,
          line: lineOf(source, dispatch),
          message: `${command} command still projects into the retired legacy dispatcher`,
        },
      ];
}

function objectProperties(node: CutoverAstNode): CutoverAstNode[] {
  return Array.isArray(node.properties) ? (node.properties as CutoverAstNode[]) : [];
}

function literalString(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const candidate = node as CutoverAstNode;
  return candidate.type === 'Literal' && typeof candidate.value === 'string'
    ? candidate.value
    : undefined;
}
