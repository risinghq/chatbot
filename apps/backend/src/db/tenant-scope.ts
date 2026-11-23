import type {
  AliasNode,
  BinaryOperationNode,
  DeleteQueryNode,
  IdentifierNode,
  JoinNode,
  KyselyPlugin,
  OperationNode,
  PluginTransformQueryArgs,
  PluginTransformResultArgs,
  QueryResult,
  ReferenceNode,
  RootOperationNode,
  SelectQueryNode,
  TableNode,
  UnknownRow,
  UpdateQueryNode,
} from "kysely";
import { TENANT_TABLES } from "./schema.ts";

/**
 * A SELECT, UPDATE or DELETE reached a tenant-owned table without a tenant
 * predicate. It is a programming error, raised before the query runs.
 */
export class UnscopedQueryError extends Error {
  constructor(readonly tables: string[]) {
    super(
      `Query reads ${tables.join(", ")} with no tenant predicate. Add ` +
        `.where("tenant_id", "=", tenantId), use inOpenTenants() for a ` +
        `cross-tenant read, or withoutTenantScope(reason) for a read keyed ` +
        `by something globally unique.`,
    );
    this.name = "UnscopedQueryError";
  }
}

type Source = { name: string; alias: string };

/** One `x.tenant_id = <other>` conjunct: `other` is an alias, or null for a value. */
type Anchor = { alias: string | null; other: string | null };

const TENANT_COLUMN = "tenant_id";
const ANCHORING_OPERATORS = new Set(["=", "==", "in"]);

function identifier(node: OperationNode | undefined): string | undefined {
  return node?.kind === "IdentifierNode"
    ? (node as IdentifierNode).name
    : undefined;
}

function sourceOf(node: OperationNode): Source | undefined {
  if (node.kind === "TableNode") {
    const name = (node as TableNode).table.identifier.name;
    return { name, alias: name };
  }
  if (node.kind === "AliasNode") {
    const aliased = node as AliasNode;
    const inner = sourceOf(aliased.node);
    const alias = identifier(aliased.alias);
    return inner && alias ? { name: inner.name, alias } : undefined;
  }
  return undefined;
}

/** The terms of a chain of ANDs, through parentheses. An OR is one term. */
function conjuncts(node: OperationNode | undefined): OperationNode[] {
  if (!node) return [];
  if (node.kind === "AndNode") {
    const and = node as unknown as {
      left: OperationNode;
      right: OperationNode;
    };
    return [...conjuncts(and.left), ...conjuncts(and.right)];
  }
  if (node.kind === "ParensNode") {
    return conjuncts((node as unknown as { node: OperationNode }).node);
  }
  return [node];
}

/** The table alias of a `tenant_id` reference, `""` when unqualified. */
function tenantReference(node: OperationNode): string | undefined {
  if (node.kind !== "ReferenceNode") return undefined;
  const ref = node as ReferenceNode;
  if (ref.column.kind !== "ColumnNode") return undefined;
  if (ref.column.column.name !== TENANT_COLUMN) return undefined;
  return ref.table ? ref.table.table.identifier.name : "";
}

function anchorOf(node: OperationNode): Anchor | undefined {
  if (node.kind !== "BinaryOperationNode") return undefined;
  const op = node as BinaryOperationNode;
  const operator = (op.operator as unknown as { operator?: string }).operator;
  if (!operator || !ANCHORING_OPERATORS.has(operator.toLowerCase())) {
    return undefined;
  }
  const left = tenantReference(op.leftOperand);
  const right = tenantReference(op.rightOperand);
  if (left !== undefined) return { alias: left, other: right ?? null };
  if (right !== undefined) return { alias: right, other: null };
  return undefined;
}

/**
 * The tenant tables in one query level that no predicate ties to a tenant.
 * An unqualified `tenant_id` belongs to the first FROM table. An alias this
 * level does not define is an outer query's, judged at its own level.
 */
function unanchored(
  sources: Source[],
  joins: readonly JoinNode[],
  where: OperationNode | undefined,
): string[] {
  const owned = sources.filter((s) => TENANT_TABLES.has(s.name));
  if (owned.length === 0) return [];

  const local = new Set(sources.map((s) => s.alias));
  const resolve = (alias: string | null) =>
    alias === "" ? (sources[0]?.alias ?? "") : alias;
  const anchors = [
    ...conjuncts(where),
    ...joins.flatMap((join) => conjuncts(join.on?.on)),
  ]
    .map(anchorOf)
    .filter((a): a is Anchor => a !== undefined)
    .map((a) => ({ alias: resolve(a.alias), other: resolve(a.other) }));

  const anchored = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const { alias, other } of anchors) {
      const tied = other === null || !local.has(other) || anchored.has(other);
      if (alias && tied && !anchored.has(alias)) {
        anchored.add(alias);
        grew = true;
      }
      // An equality between two tenant columns ties both ways.
      if (other && local.has(other) && anchored.has(alias ?? "")) {
        if (!anchored.has(other)) {
          anchored.add(other);
          grew = true;
        }
      }
    }
  }
  return owned.filter((s) => !anchored.has(s.alias)).map((s) => s.name);
}

function levelSources(node: OperationNode): {
  sources: Source[];
  joins: readonly JoinNode[];
  where?: OperationNode;
} | null {
  switch (node.kind) {
    case "SelectQueryNode": {
      const q = node as SelectQueryNode;
      const joins = q.joins ?? [];
      return {
        sources: [
          ...(q.from?.froms ?? []),
          ...joins.map((j) => j.table),
        ].flatMap((n) => sourceOf(n) ?? []),
        joins,
        where: q.where?.where,
      };
    }
    case "UpdateQueryNode": {
      const q = node as UpdateQueryNode;
      const joins = q.joins ?? [];
      return {
        sources: [
          ...(q.table ? [q.table] : []),
          ...(q.from?.froms ?? []),
          ...joins.map((j) => j.table),
        ].flatMap((n) => sourceOf(n) ?? []),
        joins,
        where: q.where?.where,
      };
    }
    case "DeleteQueryNode": {
      const q = node as DeleteQueryNode;
      const joins = q.joins ?? [];
      return {
        sources: [...q.from.froms, ...joins.map((j) => j.table)].flatMap(
          (n) => sourceOf(n) ?? [],
        ),
        joins,
        where: q.where?.where,
      };
    }
    default:
      return null;
  }
}

/** Every query level in the tree: the root, subqueries, CTEs, INSERT ... SELECT. */
function unscopedTables(node: OperationNode, found: Set<string>): void {
  const level = levelSources(node);
  if (level) {
    for (const table of unanchored(level.sources, level.joins, level.where)) {
      found.add(table);
    }
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isNode(item)) unscopedTables(item, found);
      }
    } else if (isNode(value)) {
      unscopedTables(value, found);
    }
  }
}

function isNode(value: unknown): value is OperationNode {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string"
  );
}

/** Throws UnscopedQueryError for a query that reads tenant rows unscoped. */
export function assertTenantScoped(node: RootOperationNode): void {
  const found = new Set<string>();
  unscopedTables(node, found);
  if (found.size > 0) throw new UnscopedQueryError([...found].sort());
}

/**
 * Checks each query as Kysely compiles it, so an unscoped read fails in every
 * test that runs it and in production, before it reaches D1.
 */
export class TenantScopePlugin implements KyselyPlugin {
  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    assertTenantScoped(args.node);
    return args.node;
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
