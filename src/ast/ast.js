// AST node shapes — see docs/SPECIFICATION.md §12.
// Every node is intent-bearing, not syntax-bearing: it carries `kind`,
// its semantic fields, and `span` (a SourceSpan) for diagnostics.

const node = (kind, fields, span) => ({ kind, ...fields, span });

export const Program = (statements, span) => node("Program", { statements }, span);

export const ShowStatement = (value, span) => node("ShowStatement", { value }, span);
export const SetStatement = (name, value, span) => node("SetStatement", { name, value }, span);
// ADR-009 — `indexPath` is Expression[]; empty for a plain CHANGE x = ...,
// non-empty for indexed mutation (CHANGE list[i] = ..., possibly chained).
export const ChangeStatement = (name, indexPath, value, span) =>
  node("ChangeStatement", { name, indexPath, value }, span);
export const IfStatement = (branches, elseBranch, span) =>
  node("IfStatement", { branches, elseBranch }, span);
export const ForEachStatement = (loopVariable, iterable, body, span) =>
  node("ForEachStatement", { loopVariable, iterable, body }, span);
export const RepeatStatement = (count, body, span) => node("RepeatStatement", { count, body }, span);
// ADR-004 — `parameters` is [{ name: Identifier, type: string|null }];
// `returnType` is string|null (an unannotated procedure has both null).
export const ProcedureDeclaration = (name, parameters, returnType, body, span) =>
  node("ProcedureDeclaration", { name, parameters, returnType, body }, span);
export const ReturnStatement = (value, span) => node("ReturnStatement", { value }, span);
export const ExpressionStatement = (expression, span) =>
  node("ExpressionStatement", { expression }, span);

// ADR-005 — `fields` is [{ name: string, type: string, nameSpan }].
export const DataDeclaration = (name, fields, span) =>
  node("DataDeclaration", { name, fields }, span);

// ADR-010
export const TryStatement = (tryBody, errorVar, catchBody, span) =>
  node("TryStatement", { tryBody, errorVar, catchBody }, span);

export const IntegerLiteral = (value, span) => node("IntegerLiteral", { value }, span);
export const DecimalLiteral = (value, span) => node("DecimalLiteral", { value }, span);
export const StringLiteral = (parts, span) => node("StringLiteral", { parts }, span);
export const BooleanLiteral = (value, span) => node("BooleanLiteral", { value }, span);
export const Identifier = (name, span) => node("Identifier", { name }, span);
export const FieldAccess = (target, field, span) => node("FieldAccess", { target, field }, span);
export const UnaryOp = (operator, operand, span) => node("UnaryOp", { operator, operand }, span);
export const BinaryOp = (operator, left, right, span) =>
  node("BinaryOp", { operator, left, right }, span);
export const CallExpression = (callee, args, span) =>
  node("CallExpression", { callee, arguments: args }, span);

// ADR-003 — `fields` is an array of { name: string, value: Expression, nameSpan }.
export const ListLiteral = (elements, span) => node("ListLiteral", { elements }, span);
export const RecordLiteral = (fields, span) => node("RecordLiteral", { fields }, span);

// ADR-006 — `dataTypeName` on SaveExpression is set by the analyzer (not
// the parser): the resolved DATA type to save into, read by the
// interpreter instead of re-deriving it at runtime.
export const SaveExpression = (value, span) => node("SaveExpression", { value, dataTypeName: null }, span);
export const GetExpression = (typeName, typeNameSpan, span) =>
  node("GetExpression", { typeName, typeNameSpan }, span);
export const DeleteStatement = (typeName, typeNameSpan, idExpression, span) =>
  node("DeleteStatement", { typeName, typeNameSpan, idExpression }, span);

// ADR-008
export const AskExpression = (prompt, span) => node("AskExpression", { prompt }, span);

// ADR-009
export const IndexAccess = (target, index, span) => node("IndexAccess", { target, index }, span);
