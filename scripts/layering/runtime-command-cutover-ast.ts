import { propertyName, visitAst } from './cutover-policy-ast.ts';

export type CutoverAstNode = Record<string, unknown>;

export function namedFunction(
  program: CutoverAstNode,
  expected: string,
): CutoverAstNode | undefined {
  let match: CutoverAstNode | undefined;
  visitAst(program, (node) => {
    if (node.type === 'FunctionDeclaration' && identifierName(node.id) === expected) match = node;
  });
  return match;
}

export function countNamedCalls(functionNode: CutoverAstNode, expected: string): number {
  let count = 0;
  visitAst(functionNode, (node) => {
    if (callName(node) === expected) count += 1;
  });
  return count;
}

export function callName(node: CutoverAstNode): string | undefined {
  if (node.type !== 'CallExpression') return undefined;
  const callee = node.callee as CutoverAstNode | undefined;
  if (callee?.type === 'MemberExpression') return propertyName(callee.property);
  return identifierName(callee);
}

export function lineOf(source: string, node: CutoverAstNode): number {
  const start = typeof node.start === 'number' ? node.start : 0;
  return source.slice(0, start).split('\n').length;
}

function identifierName(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const candidate = node as CutoverAstNode;
  return candidate.type === 'Identifier' && typeof candidate.name === 'string'
    ? candidate.name
    : undefined;
}
