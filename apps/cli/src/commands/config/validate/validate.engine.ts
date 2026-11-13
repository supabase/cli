import type { CliConfig } from "@supabase/config";
import {
  cliConfigStandIn,
  collectCliConfigEnvReferences,
  ENV_CAPTURE_REGEX,
  mergeParsedCliConfig,
  PROVIDER_SIGNUP_ALIASES,
  scanCliConfigDocument,
  type CliConfigDocumentScan,
  type CliConfigLocation,
  type ParsedCliConfigDocument,
} from "@supabase/config/internal";
import { Effect, Exit, Option, Path } from "effect";

import {
  cloneDocumentRecord,
  getDocumentValue,
  isDocumentRecord,
  setDocumentValue,
} from "../../../config/cli-config-document.ts";
import type { CliConfigEnvLookup } from "../../../config/cli-config-env-lookup.ts";
import type { CliConfigSources } from "../../../config/cli-config-key.ts";
import { isEncryptedSecret } from "../../../shared/config/vault-decrypt.ts";
import {
  runCliConfigRegistryPass,
  enumerateCliConfigKeys,
} from "../../../config/cli-config-registry-pass.ts";
import { decodeCliConfigWithoutTableRules } from "../../../config/cli-config-validation.ts";
import {
  makeCliConfigUnitIo,
  splitFieldEntry,
  untrackedCliConfigView,
  type CliConfigUnitFinding,
  type CliConfigUnitIo,
  type CountingCliConfigView,
  type Segments,
} from "../../../command-internal/config-check-core.ts";
import {
  authDurationUnits,
  authSignedKeys,
} from "../../../command-internal/config-check-auth-units.ts";
import { LOCAL_CHECK_ORDER } from "../../../command-internal/config-check-units.ts";
import { VALIDATE_ONLY_UNITS } from "./validate.units.ts";
import type { ConfigValidationIssueCode } from "../../../command-internal/config-validate.ts";

type ProblemCode = ConfigValidationIssueCode | "env_unset" | "env_empty";

/** Where an `env()` reference is written. */
export interface EnvReferenceUse {
  readonly name: string;
  /** `unresolved` when no lookup ran. */
  readonly state: "set" | "unset" | "empty" | "unresolved";
  readonly remote?: string;
  /** The key as the file spells it, without any `remotes.<name>.` prefix. */
  readonly path: Segments;
  readonly location?: CliConfigLocation;
}

/** A problem about one key, never carrying a configured value. */
export interface EngineProblem {
  readonly code: ProblemCode;
  readonly severity: "error" | "warning";
  readonly path: Segments;
  readonly remote?: string;
  /** True when `remote` is the context and the key is written in the base block. */
  readonly inBase?: true;
  readonly reason: string;
  readonly help?: string;
  readonly location?: CliConfigLocation;
  /** Set on `env_unset` and `env_empty`: the variable and every place it is used. */
  readonly env?: { readonly name: string; readonly uses: ReadonlyArray<EnvReferenceUse> };
}

/** `env` when an `env()` reference is among the values the check waits on; `invalid` when only invalid, missing or unusable values are. */
export type DeferralReason = "env" | "invalid";

/** A check that read an unknown value and so was not run. */
export interface DeferredCheck {
  readonly check: string;
  readonly remote?: string;
  readonly reason: DeferralReason;
  readonly waitsOn: ReadonlyArray<string>;
}

export interface ValidateRun {
  readonly problems: ReadonlyArray<EngineProblem>;
  readonly deferred: ReadonlyArray<DeferredCheck>;
  readonly unknownValues: number;
  /** False when a whole table had to be treated as unknown. */
  readonly complete: boolean;
  readonly envRefs: ReadonlyArray<EnvReferenceUse>;
}

/** Puts a probe value where an unknown env value would be, in the decoded copy and the as-written view. */
export type StandIn = (name: string) => unknown;

const keyOf = (path: Segments): string => JSON.stringify(path);
const isPrefix = (prefix: Segments, path: Segments): boolean =>
  prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
const related = (left: Segments, right: Segments): boolean =>
  isPrefix(left, right) || isPrefix(right, left);

type UnknownState = "env" | "invalid" | "missing" | "table";

interface UnknownEntry {
  readonly path: Segments;
  readonly state: UnknownState;
  readonly envNames: ReadonlyArray<string>;
}

export type StatusTable = Map<string, UnknownEntry>;

export const markUnknown = (
  status: StatusTable,
  path: Segments,
  state: UnknownState,
  envNames: ReadonlyArray<string> = [],
): void => {
  status.set(keyOf(path), { path, state, envNames });
};

const blockers = (
  status: StatusTable,
  path: Segments,
  includeDescendants: boolean,
): ReadonlyArray<UnknownEntry> =>
  [...status.values()].filter(
    (entry) => isPrefix(entry.path, path) || (includeDescendants && isPrefix(path, entry.path)),
  );

const blockedByMark = (status: StatusTable, path: Segments): boolean =>
  blockers(status, path, false).length > 0;

const walk = (root: unknown, path: Segments): unknown => {
  let node = root;
  for (const segment of path) {
    if (typeof node !== "object" || node === null || !Object.hasOwn(node, segment)) {
      return undefined;
    }
    node = Reflect.get(node, segment);
  }
  return node;
};

const deleteKey = (document: Record<string, unknown>, path: Segments): void => {
  const leaf = path.at(-1);
  const parent = walk(document, path.slice(0, -1));
  if (leaf !== undefined && isDocumentRecord(parent)) delete parent[leaf];
};

const nearestPresent = (document: unknown, path: Segments): Segments => {
  for (let length = path.length; length > 0; length--) {
    if (walk(document, path.slice(0, length)) !== undefined) return path.slice(0, length);
  }
  return [];
};

/** The shortest prefix of `path` that is an array in `document`, which an edit must replace whole. */
const markable = (document: unknown, path: Segments): Segments => {
  let node = document;
  for (let index = 0; index < path.length; index++) {
    const segment = path[index];
    if (segment === undefined || typeof node !== "object" || node === null) return path;
    node = Reflect.get(node, segment);
    if (Array.isArray(node)) return path.slice(0, index + 1);
  }
  return path;
};

const leafPaths = (value: unknown, prefix: Segments = []): Array<Segments> =>
  isDocumentRecord(value) && Object.keys(value).length > 0
    ? Object.entries(value).flatMap(([key, child]) => leafPaths(child, [...prefix, key]))
    : [prefix];

const tablePaths = (value: unknown, prefix: Segments = []): Array<Segments> =>
  isDocumentRecord(value)
    ? [
        prefix,
        ...Object.entries(value).flatMap(([key, child]) => tablePaths(child, [...prefix, key])),
      ]
    : [];

const changedKeys = (
  base: Record<string, unknown>,
  merged: Record<string, unknown>,
): ReadonlyArray<Segments> => {
  const before = new Map(leafPaths(base).map((path) => [keyOf(path), path]));
  const after = new Map(leafPaths(merged).map((path) => [keyOf(path), path]));
  const baseTables = new Set(tablePaths(base).map(keyOf));
  const mergedTables = new Set(tablePaths(merged).map(keyOf));
  const changed: Array<Segments> = [];
  for (const [key, path] of after) {
    if (
      !before.has(key) ||
      JSON.stringify(walk(base, path)) !== JSON.stringify(walk(merged, path))
    ) {
      changed.push(path);
    }
  }
  for (const [key, path] of before) {
    if (!after.has(key) && !mergedTables.has(key)) changed.push(path);
  }
  for (const path of [...tablePaths(base), ...tablePaths(merged)]) {
    if (baseTables.has(keyOf(path)) !== mergedTables.has(keyOf(path))) changed.push(path);
  }
  return changed;
};

interface EnvGroup {
  readonly path: Segments;
  readonly names: ReadonlyArray<string>;
}

const envGroups = (document: unknown, prefix: Segments): ReadonlyArray<EnvGroup> => {
  const groups = new Map<string, { path: Segments; names: Array<string> }>();
  for (const reference of collectCliConfigEnvReferences(document)) {
    const path = [...prefix, ...reference.path];
    const group = groups.get(keyOf(path)) ?? { path, names: [] };
    if (!group.names.includes(reference.name)) group.names.push(reference.name);
    groups.set(keyOf(path), group);
  }
  return [...groups.values()];
};

const substituteReferences = (
  document: Record<string, unknown>,
  path: Segments,
  valueOf: (name: string) => string,
): void => {
  const current = getDocumentValue(document, path);
  const resolve = (item: unknown): unknown => {
    const name = typeof item === "string" ? ENV_CAPTURE_REGEX.exec(item)?.[1] : undefined;
    return name === undefined ? item : valueOf(name);
  };
  setDocumentValue(
    document,
    path,
    Array.isArray(current) ? current.map(resolve) : resolve(current),
  );
};

interface SourceMaps {
  readonly base: ReadonlyMap<string, Segments>;
  readonly remotes: ReadonlyMap<string, ReadonlyMap<string, Segments>>;
}

const blockMap = (
  document: unknown,
  respell: (path: Segments) => Segments | undefined,
): ReadonlyMap<string, Segments> => {
  const map = new Map<string, Segments>();
  const visit = (node: unknown, path: Segments) => {
    if (path.length > 0) map.set(keyOf(path), respell(path) ?? path);
    if (isDocumentRecord(node)) {
      for (const [key, child] of Object.entries(node)) visit(child, [...path, key]);
    }
  };
  visit(document, []);
  return map;
};

const buildSourceMaps = (
  scan: CliConfigDocumentScan,
  base: Record<string, unknown>,
  remotes: ReadonlyArray<readonly [string, unknown]>,
): SourceMaps => {
  const spelling = (prefix: Segments) => (path: Segments) => {
    const alias = PROVIDER_SIGNUP_ALIASES.find(
      (candidate) =>
        path.length === candidate.path.length + 1 &&
        isPrefix(candidate.path, path) &&
        path.at(-1) === candidate.legacy,
    );
    return alias !== undefined &&
      scan.locate([...prefix, ...alias.path, alias.preferred], "key")?.exact === true
      ? [...alias.path, alias.preferred]
      : undefined;
  };
  return {
    base: blockMap(base, spelling([])),
    remotes: new Map(
      remotes.map(([name, subtree]) => [name, blockMap(subtree, spelling(["remotes", name]))]),
    ),
  };
};

interface Spelled {
  readonly block: string | undefined;
  readonly path: Segments;
  readonly remote: string | undefined;
}

const spellPath = (
  maps: SourceMaps,
  contextRemote: string | undefined,
  path: Segments,
): Spelled => {
  const [head, name] = path;
  if (head === "remotes" && name !== undefined) {
    return { block: name, path: path.slice(2), remote: name };
  }
  const longest = (map: ReadonlyMap<string, Segments> | undefined) => {
    for (let length = path.length; length > 0; length--) {
      const found = map?.get(keyOf(path.slice(0, length)));
      if (found !== undefined) return { length, spelled: [...found, ...path.slice(length)] };
    }
    return undefined;
  };
  const own = contextRemote === undefined ? undefined : longest(maps.remotes.get(contextRemote));
  const inherited = longest(maps.base);
  if (own !== undefined && (inherited === undefined || own.length >= inherited.length)) {
    return { block: contextRemote, path: own.spelled, remote: contextRemote };
  }
  if (inherited !== undefined) {
    return { block: undefined, path: inherited.spelled, remote: contextRemote };
  }
  return { block: contextRemote, path, remote: contextRemote };
};

const waitLabel = (spelled: Spelled, contextRemote: string | undefined): string =>
  spelled.remote !== undefined && contextRemote === undefined
    ? `remotes.${spelled.remote}.${spelled.path.join(".")}`
    : spelled.path.join(".");

const withLocation = (location: CliConfigLocation | undefined) =>
  location === undefined ? {} : { location };

interface DecodeProblem {
  readonly path: Segments;
  readonly code: ProblemCode;
  readonly reason: string;
  readonly help?: string;
}

type Report = (path: Segments, absent: boolean, problem: Omit<DecodeProblem, "path">) => void;

export interface ContextResult {
  readonly document: Record<string, unknown>;
  readonly config: CliConfig | undefined;
  readonly status: StatusTable;
  readonly changed: ReadonlyArray<Segments> | undefined;
  readonly complete: boolean;
  readonly decodeProblems: ReadonlyArray<DecodeProblem>;
}

const unquoteChoices = (text: string): string =>
  text.replace(/"([^",]*)"/g, (quoted, choice: string) => (choice === "" ? quoted : choice));

const codecProblem = (failure: {
  readonly expected?: string;
  readonly kind?: "type" | "enum" | "value";
}) => ({
  code:
    failure.kind === "type"
      ? ("invalid_type" as const)
      : failure.kind === "enum"
        ? ("invalid_enum" as const)
        : ("invalid_value" as const),
  reason:
    failure.expected === undefined
      ? "invalid value"
      : `expected ${failure.kind === "enum" ? unquoteChoices(failure.expected) : failure.expected}`,
  ...(failure.kind === "enum" && failure.expected !== undefined
    ? { help: `use ${unquoteChoices(failure.expected)}` }
    : {}),
});

interface AnalyzeInput {
  readonly merged: Record<string, unknown>;
  readonly base: Record<string, unknown>;
  readonly groups: ReadonlyArray<EnvGroup>;
  readonly changed: ReadonlyArray<Segments> | undefined;
  readonly env: CliConfigEnvLookup | undefined;
  readonly standIn: StandIn | undefined;
  readonly workdir: string;
  readonly pathService: Path.Path;
}

const prepareContext = (input: AnalyzeInput) => {
  const { merged, env, standIn } = input;
  const document = cloneDocumentRecord(merged);
  const copy = cloneDocumentRecord(merged);
  delete copy["remotes"];
  const status: StatusTable = new Map();

  for (const group of input.groups) {
    const inCopy = group.path[0] !== "remotes";
    const lookup = (name: string) => env?.lookup(name);
    const settled = env !== undefined && group.names.every((name) => lookup(name)?.state === "set");
    if (settled) {
      const valueOf = (name: string) => {
        const found = lookup(name);
        return found?.state === "set" ? found.value : "";
      };
      substituteReferences(document, group.path, valueOf);
      if (inCopy) substituteReferences(copy, group.path, valueOf);
      continue;
    }
    markUnknown(status, group.path, "env", group.names);
    const probe = standIn?.(group.names[0] ?? "");
    if (probe !== undefined) {
      setDocumentValue(document, group.path, probe);
      if (inCopy) setDocumentValue(copy, group.path, probe);
    } else if (inCopy) {
      deleteKey(copy, group.path);
    }
  }

  if (env === undefined) {
    for (const key of enumerateCliConfigKeys(copy).values()) {
      if (key.secret !== true) continue;
      const raw = getDocumentValue(copy, key.segments);
      if (typeof raw !== "string" || !isEncryptedSecret(raw) || status.has(keyOf(key.segments))) {
        continue;
      }
      markUnknown(status, key.segments, "env");
      const probe = standIn?.("");
      if (probe === undefined) deleteKey(copy, key.segments);
      else setDocumentValue(copy, key.segments, probe);
    }
  }

  return { document, copy, status };
};

const makeReport = (input: AnalyzeInput, into: Array<DecodeProblem>): Report => {
  const owned = (path: Segments, absent: boolean): boolean => {
    if (input.changed === undefined) return true;
    if (absent) {
      const anchor = nearestPresent(input.merged, path);
      return (
        anchor.length > 0 &&
        (walk(input.base, anchor) === undefined ||
          input.changed.some((key) => isPrefix(key, anchor)))
      );
    }
    return input.changed.some((key) => isPrefix(key, path) || isPrefix(path, key));
  };
  return (path, absent, problem) => {
    if (owned(path, absent)) into.push({ path, ...problem });
  };
};

/** Reports each value that fails its own check, marks it unknown and drops it, until the registry pass is clean. */
const dropFailingValues = (
  copy: Record<string, unknown>,
  status: StatusTable,
  input: AnalyzeInput,
  report: Report,
) => {
  const sources = (): CliConfigSources => ({
    flags: () => undefined,
    shell: () => undefined,
    projectEnv: () => undefined,
    config: (segments) => {
      const value = getDocumentValue(copy, segments);
      return value === undefined
        ? undefined
        : { value, origin: { path: segments, source: "local" } };
    },
    dotenvPrivateKeys: input.env?.dotenvPrivateKeys ?? [],
    context: {
      workdir: input.workdir,
      projectRef: Option.none(),
      path: input.pathService,
      configAt: (path) => getDocumentValue(copy, path.split(".")),
    },
  });

  let pass = runCliConfigRegistryPass(copy, sources(), { configOnly: true });
  for (;;) {
    const fresh = pass.failures.filter(
      (failure) => failure.segments !== undefined && !blockedByMark(status, failure.segments),
    );
    if (fresh.length === 0) return pass;
    for (const failure of fresh) {
      const { segments } = failure;
      if (segments === undefined) continue;
      report(segments, false, codecProblem(failure));
      markUnknown(status, segments, "invalid");
      deleteKey(copy, segments);
    }
    pass = runCliConfigRegistryPass(copy, sources(), { configOnly: true });
  }
};

/** The smallest table enclosing `issuePath` that is not already unknown, which a stuck decode marks whole. */
export const enclosingTableToMark = (
  status: StatusTable,
  issuePath: Segments,
): Segments | undefined => {
  for (let length = issuePath.length - 1; length >= 0; length--) {
    const candidate = issuePath.slice(0, length);
    if (!status.has(keyOf(candidate))) return candidate;
  }
  return undefined;
};

/**
 * Decodes `decoding` until it succeeds, reporting each remaining issue and putting a stand-in
 * where a required key is unknown. A round that makes no progress marks the enclosing table
 * unknown and the result incomplete.
 */
export const decodeWithStandIns = (
  decoding: Record<string, unknown>,
  status: StatusTable,
  report: Report,
): { readonly config: CliConfig | undefined; readonly complete: boolean } => {
  let complete = true;
  for (;;) {
    const result = decodeCliConfigWithoutTableRules(decoding);
    if (result._tag === "Success") return { config: result.value, complete };
    let progressed = false;
    for (const issue of result.issues) {
      const target = markable(decoding, issue.path);
      if (blockedByMark(status, target)) {
        const state = status.get(keyOf(issue.path))?.state;
        const standIn =
          issue.code === "missing_required" && (state === "env" || state === "invalid")
            ? cliConfigStandIn(issue.path)
            : undefined;
        if (standIn !== undefined) {
          setDocumentValue(decoding, issue.path, standIn);
          progressed = true;
        }
        continue;
      }
      progressed = true;
      report(issue.path, issue.code === "missing_required", {
        code: issue.code,
        reason: issue.reason,
        ...(issue.help === undefined ? {} : { help: issue.help }),
      });
      if (issue.code === "missing_required" && target.length === issue.path.length) {
        markUnknown(status, issue.path, "missing");
        setDocumentValue(decoding, issue.path, cliConfigStandIn(issue.path) ?? {});
      } else {
        markUnknown(status, target, issue.code === "missing_required" ? "missing" : "invalid");
        deleteKey(decoding, target);
      }
    }
    if (progressed) continue;
    complete = false;
    const enclosing = enclosingTableToMark(status, result.issues[0]?.path ?? []);
    if (enclosing === undefined) return { config: undefined, complete };
    markUnknown(status, enclosing, "table");
    if (enclosing.length === 0) return { config: undefined, complete };
    setDocumentValue(decoding, enclosing, {});
  }
};

/** Builds one context's stand-in copy and status table, then decodes it until it succeeds. */
export const analyzeContext = (input: AnalyzeInput): ContextResult => {
  const { document, copy, status } = prepareContext(input);
  const decodeProblems: Array<DecodeProblem> = [];
  const report = makeReport(input, decodeProblems);
  const pass = dropFailingValues(copy, status, input, report);

  const units = cloneDocumentRecord(document);
  for (const path of pass.resolved.declared) {
    const coerced = getDocumentValue(pass.declared, path);
    if (coerced !== undefined) setDocumentValue(units, path, coerced);
  }

  const { config, complete } = decodeWithStandIns(pass.materialized, status, report);
  return { document: units, config, status, changed: input.changed, complete, decodeProblems };
};

interface Reads {
  readonly paths: Array<Segments>;
  readonly waits: Map<string, UnknownEntry>;
}

const trackedView = (
  context: ContextResult,
  config: CliConfig,
  reads: Reads,
  workdir: string,
  configPath: string,
): CountingCliConfigView => {
  const inner = untrackedCliConfigView({
    config,
    document: context.document,
    workdir,
    configPath,
  });
  const record = (path: Segments, includeDescendants: boolean) => {
    reads.paths.push(path);
    for (const entry of blockers(context.status, path, includeDescendants)) {
      reads.waits.set(keyOf(entry.path), entry);
    }
  };
  return {
    ...inner,
    get: (path) => {
      record(path, true);
      return inner.get(path);
    },
    written: (path) => {
      record(path, true);
      return inner.written(path);
    },
    has: (path) => {
      record(path, false);
      return inner.has(path);
    },
    hasTable: (path) => {
      record(path, false);
      return inner.hasTable(path);
    },
    keys: (path) => {
      record(path, false);
      return inner.keys(path);
    },
    defer: (path) => {
      reads.paths.push(path);
      reads.waits.set(keyOf(path), { path, state: "invalid", envNames: [] });
    },
    isKnown: (path) => blockers(context.status, path, true).length === 0,
  };
};

const UNIT_GROUPS = [
  { units: [...LOCAL_CHECK_ORDER, authSignedKeys, ...authDurationUnits], rank: 0 },
  { units: VALIDATE_ONLY_UNITS, rank: 1 },
] as const;

/** One unit run for one entry: its findings, or the unknown values it waited on. */
interface UnitRun {
  readonly unit: string;
  /** The check a deferral is counted under: the id of the unit's twin when it has one. */
  readonly check: string;
  readonly rank: number;
  readonly findings: ReadonlyArray<CliConfigUnitFinding>;
  readonly waits: ReadonlyArray<UnknownEntry>;
}

/** Runs every unit whose scope the context changed, deferring those that read an unknown value. */
export const runUnitsInContext = Effect.fnUntraced(function* (input: {
  readonly context: ContextResult;
  readonly config: CliConfig;
  readonly io: CliConfigUnitIo;
  readonly workdir: string;
  readonly configPath: string;
}) {
  const { context, config, io, workdir, configPath } = input;
  const runs: Array<UnitRun> = [];
  for (const { units, rank } of UNIT_GROUPS) {
    for (const unit of units) {
      const entryReads: Reads = { paths: [], waits: new Map() };
      const entries =
        unit.entries === undefined
          ? [undefined]
          : unit.entries(trackedView(context, config, entryReads, workdir, configPath));
      for (const entry of entries) {
        const scope = typeof unit.scope === "function" ? unit.scope(entry ?? "") : unit.scope;
        if (context.changed?.some((key) => related(key, scope)) === false) continue;
        const memberships =
          entry === undefined
            ? []
            : entryReads.paths.map((table) => [...table, splitFieldEntry(entry)[0]]);
        const reads: Reads = {
          paths: [],
          waits: new Map(entryReads.waits),
        };
        const guarded: CliConfigUnitIo = {
          ...io,
          filesAllowed: () => reads.waits.size === 0,
          readText: (absPath) =>
            reads.waits.size === 0 ? io.readText(absPath) : Effect.succeed(Exit.succeed("")),
        };
        const findings = yield* unit.run(
          trackedView(context, config, reads, workdir, configPath),
          guarded,
          entry,
        );
        const readChanged =
          context.changed === undefined ||
          reads.paths.some((path) => context.changed?.some((key) => related(key, path))) ||
          memberships.some((path) => context.changed?.some((key) => isPrefix(key, path)));
        if (!readChanged) continue;
        runs.push({
          unit: unit.id,
          check: unit.twin ?? unit.id,
          rank,
          findings: reads.waits.size > 0 ? [] : findings,
          waits: [...reads.waits.values()],
        });
      }
    }
  }
  return runs;
});

/** A problem before its key is respelled and located in the file. */
export interface RawProblem {
  readonly remote: string | undefined;
  readonly path: Segments;
  readonly rank: number;
  readonly code: ProblemCode;
  readonly reason: string;
  readonly help?: string;
}

const contextKey = (remote: string | undefined): string =>
  remote === undefined ? "base" : `remote:${remote}`;

/** Keeps one problem per context, key and code; the lowest rank wins and ties keep the first. */
export const collapseProblems = (raw: ReadonlyArray<RawProblem>): ReadonlyArray<RawProblem> => {
  const kept = new Map<string, RawProblem>();
  for (const problem of raw) {
    const key = `${contextKey(problem.remote)}\0${keyOf(problem.path)}\0${problem.code}`;
    const existing = kept.get(key);
    if (existing === undefined || problem.rank < existing.rank) kept.set(key, problem);
  }
  return [...kept.values()];
};

interface BlockEnvGroup {
  readonly remote: string | undefined;
  readonly group: EnvGroup;
}

/** One problem per `env()` variable that is unset or empty; an error when a check needed it or the literal would be rejected. */
export const classifyEnvProblems = (input: {
  readonly envRefs: ReadonlyArray<EnvReferenceUse>;
  readonly groups: ReadonlyArray<BlockEnvGroup>;
  readonly keys: ReturnType<typeof enumerateCliConfigKeys> | undefined;
  readonly neededEnv: ReadonlySet<string>;
}): ReadonlyArray<EngineProblem> => {
  const problems: Array<EngineProblem> = [];
  const unresolved = new Set(
    input.envRefs
      .filter((use) => use.state === "unset" || use.state === "empty")
      .map((use) => use.name),
  );
  for (const name of unresolved) {
    const uses = input.envRefs.filter((use) => use.name === name);
    const [first] = uses;
    if (first === undefined) continue;
    const rejectsLiteral = input.groups.some(({ group }) => {
      const schemaPath = group.path[0] === "remotes" ? group.path.slice(2) : group.path;
      if (!group.names.includes(name)) return false;
      const key = input.keys?.get(schemaPath.join("."));
      if (key !== undefined) return key.codec.parse(`env(${name})`) === undefined;
      const standIn = cliConfigStandIn(schemaPath);
      return typeof standIn === "boolean" || typeof standIn === "number";
    });
    const unset = first.state === "unset";
    problems.push({
      code: unset ? "env_unset" : "env_empty",
      severity: input.neededEnv.has(name) || rejectsLiteral ? "error" : "warning",
      path: first.path,
      ...(first.remote === undefined ? {} : { remote: first.remote }),
      reason: unset
        ? `environment variable ${name} is not set`
        : `environment variable ${name} is set but empty`,
      help: unset
        ? `set ${name} in the shell or in a supabase/.env file`
        : `give ${name} a value in the shell or in a supabase/.env file`,
      ...withLocation(first.location),
      env: { name, uses },
    });
  }
  return problems;
};

/** The entry that takes a probe in place of unknown env values; the public entry is {@link runConfigValidation}. */
export const runConfigValidationWithStandIn = Effect.fn("ConfigValidate.run")(function* (
  parsed: ParsedCliConfigDocument,
  workdir: string,
  env: CliConfigEnvLookup | undefined,
  standIn: StandIn | undefined,
) {
  const rawDocument = parsed.rawDocument;
  if (rawDocument === undefined) {
    return {
      problems: [],
      deferred: [],
      unknownValues: 0,
      complete: true,
      envRefs: [],
    } satisfies ValidateRun;
  }
  const pathService = yield* Path.Path;
  const scan = scanCliConfigDocument(parsed.rawText, parsed.format);

  const baseOnly = cloneDocumentRecord(rawDocument);
  delete baseOnly["remotes"];
  const remoteBlocks = isDocumentRecord(rawDocument["remotes"])
    ? Object.entries(rawDocument["remotes"]).filter(([, block]) => isDocumentRecord(block))
    : [];
  const maps = buildSourceMaps(scan, baseOnly, remoteBlocks);

  const blockGroups: ReadonlyArray<BlockEnvGroup> = [
    ...envGroups(baseOnly, []).map((group) => ({ remote: undefined, group })),
    ...remoteBlocks.flatMap(([name, block]) =>
      envGroups(block, ["remotes", name]).map((group) => ({ remote: name, group })),
    ),
  ];

  const merge = (selected: string | undefined) =>
    mergeParsedCliConfig(parsed, { selectRemote: () => selected }).pipe(
      Effect.map((merged) => cloneDocumentRecord(merged.document)),
      Effect.orDie,
    );

  const contexts = yield* Effect.gen(function* () {
    const baseMerged = yield* merge(undefined);
    const results: Array<{ readonly remote: string | undefined; readonly result: ContextResult }> =
      [
        {
          remote: undefined,
          result: analyzeContext({
            merged: baseMerged,
            base: baseOnly,
            groups: blockGroups.map(({ group }) => group),
            changed: undefined,
            env,
            standIn,
            workdir,
            pathService,
          }),
        },
      ];
    for (const [name] of remoteBlocks) {
      const merged = yield* merge(name);
      results.push({
        remote: name,
        result: analyzeContext({
          merged,
          base: baseOnly,
          groups: envGroups(merged, []),
          changed: changedKeys(baseOnly, merged),
          env,
          standIn,
          workdir,
          pathService,
        }),
      });
    }
    return results;
  }).pipe(Effect.withSpan("ConfigValidate.contexts"));

  const locate = (spelled: Spelled): CliConfigLocation | undefined =>
    scan.locate(
      spelled.block === undefined ? spelled.path : ["remotes", spelled.block, ...spelled.path],
      "value",
    );

  const raw: Array<RawProblem> = [];
  const deferred = new Map<
    string,
    { check: string; remote?: string; reason: DeferralReason; waitsOn: Set<string> }
  >();
  const neededEnv = new Set<string>();

  yield* Effect.gen(function* () {
    const io = yield* makeCliConfigUnitIo("local");
    for (const { remote, result } of contexts) {
      for (const decoded of result.decodeProblems) {
        raw.push({ remote, rank: 2, ...decoded });
      }
      const { config } = result;
      if (config === undefined) continue;
      const runs = yield* runUnitsInContext({
        context: result,
        config,
        io,
        workdir,
        configPath: parsed.path,
      });
      for (const run of runs) {
        if (run.waits.length > 0) {
          const id = `${contextKey(remote)}\0${run.check}`;
          const record = deferred.get(id) ?? {
            check: run.check,
            ...(remote === undefined ? {} : { remote }),
            reason: "invalid" as DeferralReason,
            waitsOn: new Set<string>(),
          };
          for (const waiting of run.waits) {
            if (waiting.state === "env") record.reason = "env";
            for (const name of waiting.envNames) neededEnv.add(name);
            record.waitsOn.add(waitLabel(spellPath(maps, remote, waiting.path), remote));
          }
          deferred.set(id, record);
          continue;
        }
        for (const found of run.findings) {
          raw.push({
            remote,
            path: found.path,
            rank: run.rank,
            code: found.code,
            reason: found.reason,
            ...(found.help === undefined ? {} : { help: found.help }),
          });
        }
      }
    }
  }).pipe(Effect.withSpan("ConfigValidate.units"));

  const envRefs: Array<EnvReferenceUse> = blockGroups.flatMap(({ remote, group }) =>
    group.names.map((name) => {
      const spelled = spellPath(maps, remote, group.path);
      const state = env?.lookup(name);
      return {
        name,
        state: state === undefined ? ("unresolved" as const) : state.state,
        ...(remote === undefined ? {} : { remote }),
        path: spelled.path,
        ...withLocation(locate(spelled)),
      };
    }),
  );

  const problems: Array<EngineProblem> = collapseProblems(raw).map((problem) => {
    const spelled = spellPath(maps, problem.remote, problem.path);
    return {
      severity: "error",
      code: problem.code,
      path: spelled.path,
      ...(spelled.remote === undefined ? {} : { remote: spelled.remote }),
      ...(spelled.remote !== undefined && spelled.block === undefined
        ? { inBase: true as const }
        : {}),
      reason: problem.reason,
      ...(problem.help === undefined ? {} : { help: problem.help }),
      ...withLocation(locate(spelled)),
    };
  });

  if (env !== undefined) {
    const baseResult = contexts[0]?.result;
    problems.push(
      ...classifyEnvProblems({
        envRefs,
        groups: blockGroups,
        keys: baseResult === undefined ? undefined : enumerateCliConfigKeys(baseResult.document),
        neededEnv,
      }),
    );
  }

  const unknownValues = blockGroups.filter(
    ({ group }) =>
      env === undefined || group.names.some((name) => env.lookup(name).state !== "set"),
  ).length;

  return {
    problems,
    deferred: [...deferred.values()].map((record) => ({
      check: record.check,
      ...(record.remote === undefined ? {} : { remote: record.remote }),
      reason: record.reason,
      waitsOn: [...record.waitsOn],
    })),
    unknownValues,
    complete: contexts.every(({ result }) => result.complete),
    envRefs,
  } satisfies ValidateRun;
});

/**
 * Validates the parsed config as committed: unknown values (`env()` references, and values that
 * failed their own check) never cause or hide a problem, and checks that read one are deferred.
 */
export const runConfigValidation = (
  parsed: ParsedCliConfigDocument,
  workdir: string,
  env: CliConfigEnvLookup | undefined,
) => runConfigValidationWithStandIn(parsed, workdir, env, undefined);
