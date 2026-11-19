import { analyzeAndSort, type ObjectRef, type StatementNode } from "@supabase/pg-topo";
import { Effect } from "effect";

import { SparkBackendError } from "./spark-project.ts";

interface SqlFile {
  readonly name: string;
  readonly sql: string;
}

interface Export {
  readonly files: ReadonlyArray<SqlFile>;
  readonly manifest: {
    readonly files?: ReadonlyArray<string>;
    readonly loadOrder?: ReadonlyArray<string>;
  };
}

/** Drops the files whose content a baseline export of the shadow image also contains. */
export const withoutBaselineFiles = <E extends Export>(exported: E, baseline: Export): E => {
  const same = new Set(
    exported.files
      .filter((file) => baseline.files.some((b) => b.name === file.name && b.sql === file.sql))
      .map((file) => file.name),
  );
  const drop = (names: ReadonlyArray<string>) => names.filter((name) => !same.has(name));
  const { files, loadOrder } = exported.manifest;
  return {
    ...exported,
    files: exported.files.filter((file) => !same.has(file.name)),
    manifest: {
      ...exported.manifest,
      ...(files === undefined ? {} : { files: drop(files) }),
      ...(loadOrder === undefined ? {} : { loadOrder: drop(loadOrder) }),
    },
  };
};

const WHITESPACE = new Set([" ", "\t", "\n", "\r", "\f", "\v"]);

/** The offset of the first token at or after `offset`, past whitespace, `--` and nested block comments. */
const firstToken = (sql: string, offset: number) => {
  let i = offset;
  while (i < sql.length) {
    if (WHITESPACE.has(sql[i] ?? "")) i += 1;
    else if (sql.startsWith("--", i)) {
      const end = sql.indexOf("\n", i);
      i = end < 0 ? sql.length : end + 1;
    } else if (sql.startsWith("/*", i)) {
      let depth = 0;
      do {
        if (sql.startsWith("/*", i)) {
          depth += 1;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth -= 1;
          i += 2;
        } else i += 1;
      } while (depth > 0 && i < sql.length);
    } else break;
  }
  return i;
};

const lineAt = (sql: string, offset: number) => {
  let line = 1;
  for (let i = 0; i < offset && i < sql.length; i += 1) if (sql[i] === "\n") line += 1;
  return line;
};

interface Located {
  readonly node: StatementNode;
  readonly source: number;
  readonly line: number;
}

/** pg-topo's statements of `sources` in source order, each with the line of its first token. */
const analyze = (sources: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () => analyzeAndSort([...sources]),
    catch: (cause) => new SparkBackendError({ message: "could not parse the SQL files", cause }),
  }).pipe(Effect.map(({ ordered }) => located(sources, ordered)));

const located = (
  sources: ReadonlyArray<string>,
  ordered: ReadonlyArray<StatementNode>,
): ReadonlyArray<Located> => {
  // pg-topo names in-memory input i `<input:i>`; its own analyzeAndSortFromFiles maps them back this way.
  const index = new Map(sources.map((_, i) => [`<input:${i}>`, i]));
  return ordered
    .flatMap((node) => {
      const source = index.get(node.id.filePath);
      if (source === undefined) return [];
      const sql = sources[source] ?? "";
      return [{ node, source, line: lineAt(sql, firstToken(sql, node.id.sourceOffset ?? 0)) }];
    })
    .sort((a, b) => a.source - b.source || a.node.id.statementIndex - b.node.id.statementIndex);
};

/** Overloads aside, kind, schema and name identify an object; signatures differ in spelling. */
const sameObject = (a: ObjectRef, b: ObjectRef) =>
  a.kind === b.kind && (a.schema ?? "") === (b.schema ?? "") && a.name === b.name;

/** The objects a statement creates, its table before that table's constraints. */
const provided = (node: StatementNode) =>
  [...node.provides].sort(
    (a, b) => Number(a.kind === "constraint") - Number(b.kind === "constraint"),
  );

/** The user object a statement acts on: a grant's or an index's table, not its roles, schema or built-in types. */
const target = (node: StatementNode): ObjectRef | undefined =>
  node.requires.find(
    (ref) => ref.kind !== "role" && ref.kind !== "schema" && ref.schema !== "pg_catalog",
  );

const providerOf = (statements: ReadonlyArray<Located>, ref: ObjectRef) =>
  statements.find((s) => s.node.provides.some((p) => sameObject(p, ref)));

/**
 * The statement in `statements` that `refused` comes from, by the objects pg-topo says it creates or
 * acts on: the statement that creates the same object; for a statement that creates nothing (an
 * `ALTER TABLE`, a `GRANT`), one of the same kind acting on the same object; else the statement that
 * creates the object it acts on (a generated grant or a new index points at its table).
 */
const sourceOf = (refused: StatementNode, statements: ReadonlyArray<Located>) => {
  for (const ref of provided(refused)) {
    const declared = providerOf(statements, ref);
    if (declared !== undefined) return declared;
  }
  if (refused.provides.length > 0) {
    const acted = target(refused);
    return acted === undefined ? undefined : providerOf(statements, acted);
  }
  // A schema grant acts on its schema, which `target` leaves out.
  const acted = target(refused) ?? refused.requires.find((ref) => ref.kind !== "role");
  if (acted === undefined) return undefined;
  return (
    statements.find(
      (s) =>
        s.node.statementClass === refused.statementClass &&
        s.node.requires.some((ref) => sameObject(ref, acted)),
    ) ?? providerOf(statements, acted)
  );
};

export interface SourceLocation {
  readonly file: string;
  readonly line: number;
}

/** Where in the schema files each refused statement comes from; pg-delta generated them, so by identity. */
export const locateInSchemaFiles = Effect.fn("Spark.locateInSchemaFiles")(function* (
  statements: ReadonlyArray<string>,
  files: ReadonlyArray<SqlFile>,
) {
  if (statements.length === 0) return [];
  const sources = yield* analyze(files.map((file) => file.sql));
  return yield* Effect.forEach(statements, (statement) =>
    Effect.map(analyze([statement]), ([first]): SourceLocation | undefined => {
      const source = first === undefined ? undefined : sourceOf(first.node, sources);
      return source === undefined
        ? undefined
        : { file: files[source.source]?.name ?? "", line: source.line };
    }),
  );
});

interface StatusLike {
  readonly index: number;
  readonly status: string;
  readonly statement: string;
  readonly message?: string | null | undefined;
}

/** Spark reports a statement as its source text with whitespace collapsed and no final `;`. */
const asSparkReportsIt = (sql: string) => {
  const collapsed = sql.replace(/\s+/gu, " ").trim();
  return collapsed.endsWith(";") ? collapsed.slice(0, -1).trimEnd() : collapsed;
};

/**
 * Maps the statuses of one dry run over all pending files back to their files and lines. Each status
 * takes the next statement, in file order, with the same text, so identical statements in different
 * files stay apart; a statement Spark rewrote (a fold of `ALTER TABLE ... ADD` into its `CREATE
 * TABLE`) has no such text and is found by identity. `refused` also holds a fold into a table an
 * earlier file creates, which Spark refuses once the files are applied one by one. `silent` lists
 * the files that got no status at all.
 */
export const attributeDryRunStatuses = Effect.fn("Spark.attributeDryRunStatuses")(function* <
  S extends StatusLike,
>(
  statuses: ReadonlyArray<S>,
  files: ReadonlyArray<{ readonly file: string; readonly query: string }>,
) {
  const statements = yield* analyze(files.map((f) => f.query));
  const texts = statements.map((s) => asSparkReportsIt(s.node.sql));
  const seen = new Set<number>();
  const refused: Array<{
    readonly file: string | undefined;
    readonly line: number | undefined;
    readonly status: S;
  }> = [];
  let cursor = 0;
  for (const status of [...statuses].sort((a, b) => a.index - b.index)) {
    const next = texts.indexOf(status.statement, cursor);
    let at: Located | undefined;
    if (next >= 0) {
      at = statements[next];
      cursor = next + 1;
    } else if (status.status !== "ok") {
      const node = (yield* analyze([status.statement]))[0]?.node;
      at = node === undefined ? undefined : sourceOf(node, statements);
    }
    if (at !== undefined) seen.add(at.source);
    const file = at === undefined ? undefined : files[at.source]?.file;
    if (status.status === "unsupported" || status.status === "error") {
      refused.push({ file, line: at?.line, status });
      continue;
    }
    if (status.status !== "rewritten" || at === undefined) continue;
    const table = target(at.node);
    const creator = table === undefined ? undefined : providerOf(statements, table);
    if (creator !== undefined && creator.source < at.source)
      refused.push({
        file,
        line: at.line,
        status: {
          ...status,
          status: "error",
          message: `folds into a table created in ${files[creator.source]?.file}; applied on its own, Spark refuses ALTER TABLE ... ADD on an existing table`,
        },
      });
  }
  const silent = files.flatMap((f, i) => (seen.has(i) ? [] : [f.file]));
  return { refused, silent };
});
