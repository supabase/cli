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

const normalize = (sql: string) =>
  sql.replace(/"/gu, "").replace(/\s+/gu, " ").trim().toLowerCase();
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** `public.add` matches `public.add` and `add`; `add` matches `add` in any schema. */
const reference = (name: string) => {
  const [first, second] = name.split(".");
  return second === undefined
    ? `(?:[\\w$]+\\.)?${escape(name)}`
    : `(?:${escape(first ?? "")}\\.)?${escape(second)}`;
};

/** Line patterns, most specific first, that declare the object a refused statement creates. */
const declarationPatterns = (statement: string): ReadonlyArray<RegExp> => {
  const sql = normalize(statement);
  const pattern = (source: string) => new RegExp(`^${source}`, "u");
  let match = /^create (?:or replace )?(function|procedure) (?:if not exists )?([\w$.]+)/u.exec(
    sql,
  );
  if (match?.[1] !== undefined && match[2] !== undefined)
    return [pattern(`create (?:or replace )?${match[1]} ${reference(match[2])}\\b`)];
  match = /^create (?:or replace )?(?:constraint )?trigger ([\w$]+)/u.exec(sql);
  if (match?.[1] !== undefined)
    return [pattern(`create (?:or replace )?(?:constraint )?trigger ${escape(match[1])}\\b`)];
  match =
    /^create (?:or replace )?(?:(?:temp|temporary|recursive|materialized) )*view ([\w$.]+)/u.exec(
      sql,
    );
  if (match?.[1] !== undefined)
    return [
      pattern(
        `create (?:or replace )?(?:(?:temp|temporary|recursive|materialized) )*view (?:if not exists )?${reference(match[1])}\\b`,
      ),
    ];
  match = /^create (type|domain) ([\w$.]+)/u.exec(sql);
  if (match?.[1] !== undefined && match[2] !== undefined)
    return [pattern(`create ${match[1]} ${reference(match[2])}\\b`)];
  match = /^create policy (.+?) on ([\w$.]+)/u.exec(sql);
  if (match?.[1] !== undefined && match[2] !== undefined)
    return [
      pattern(`create policy ${escape(match[1])} on ${reference(match[2])}\\b`),
      pattern(`create policy ${escape(match[1])}\\b`),
    ];
  match = /^create extension (?:if not exists )?([\w$-]+)/u.exec(sql);
  if (match?.[1] !== undefined)
    return [pattern(`create extension (?:if not exists )?${escape(match[1])}\\b`)];
  match = /^(?:grant|revoke) .* on schema ([\w$]+)/u.exec(sql);
  if (match?.[1] !== undefined)
    return [pattern(`(?:grant|revoke) .* on schema ${escape(match[1])}\\b`)];
  return [];
};

/** The first schema file and line that declares the object a refused statement creates. */
export const findDeclaration = (
  statement: string,
  files: ReadonlyArray<SqlFile>,
): { readonly file: string; readonly line: number } | undefined => {
  const patterns = declarationPatterns(statement);
  const lines = files.map((file) => ({
    file: file.name,
    lines: file.sql.split("\n").map(normalize),
  }));
  for (const pattern of patterns)
    for (const { file, lines: text } of lines) {
      const index = text.findIndex((line) => pattern.test(line));
      if (index >= 0) return { file, line: index + 1 };
    }
  return undefined;
};

interface StatusLike {
  readonly index: number;
  readonly status: string;
  readonly statement: string;
  readonly message?: string | null | undefined;
}

/**
 * Maps the statuses of one dry run over all pending files back to their files. The server reports
 * statements in order and whitespace-collapsed, so each status goes to the first file at or after
 * the previous status's match that contains it; identical statements in different files stay apart.
 * `refused` also holds a fold of an `ALTER TABLE ... ADD` into a table another, earlier file
 * creates, which Spark refuses once the files are applied one by one. `silent` lists the files
 * that got no status at all.
 */
export const attributeDryRunStatuses = <S extends StatusLike>(
  statuses: ReadonlyArray<S>,
  files: ReadonlyArray<{ readonly file: string; readonly query: string }>,
) => {
  const collapsed = files.map((f) => f.query.replace(/\s+/gu, " "));
  const seen = new Set<number>();
  const refused: Array<{ readonly file: string | undefined; readonly status: S }> = [];
  let cursor = { file: 0, offset: 0 };
  for (const status of [...statuses].sort((a, b) => a.index - b.index)) {
    let at = -1;
    for (let i = cursor.file; i < collapsed.length && at < 0; i += 1) {
      const found = (collapsed[i] ?? "").indexOf(
        status.statement,
        i === cursor.file ? cursor.offset : 0,
      );
      if (found >= 0) {
        at = i;
        cursor = { file: i, offset: found + status.statement.length };
        seen.add(i);
      }
    }
    const file = at >= 0 ? files[at]?.file : undefined;
    if (status.status === "unsupported" || status.status === "error") {
      refused.push({ file, status });
      continue;
    }
    if (status.status !== "rewritten" || at < 0) continue;
    const target = /^alter table (?:only )?(?:if exists )?([\w$.]+)/u.exec(
      normalize(status.statement),
    )?.[1];
    if (target === undefined) continue;
    const creates = new RegExp(`create table (?:if not exists )?${reference(target)}\\b`, "u");
    const declares = (i: number) => creates.test(normalize(files[i]?.query ?? ""));
    const creator = declares(at) ? -1 : files.findIndex((_, i) => i < at && declares(i));
    if (creator >= 0)
      refused.push({
        file,
        status: {
          ...status,
          status: "error",
          message: `folds into a table created in ${files[creator]?.file}; applied on its own, Spark refuses ALTER TABLE ... ADD on an existing table`,
        },
      });
  }
  const silent = files.flatMap((f, i) => (seen.has(i) ? [] : [f.file]));
  return { refused, silent };
};
