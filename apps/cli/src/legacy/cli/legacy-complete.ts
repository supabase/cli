import { Option } from "effect";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param, Primitive } from "effect/unstable/cli";
import process from "node:process";
import { legacyUnwrapParam } from "../shared/legacy-param-introspection.ts";

/**
 * Native TypeScript reimplementation of cobra's dynamic-completion protocol
 * (`spf13/cobra@v1.10.2/completions.go`), replacing the old Go-binary
 * passthrough (`complete-passthrough.ts`, deleted by CLI-1965). Cobra-generated
 * completion scripts (`supabase completion {bash,zsh,fish,powershell}`) call
 * back into `supabase __complete <args>` on every tab press — or
 * `supabase __completeNoDesc <args>` when the script was generated with
 * `--no-descriptions` (cobra's alias for the same hidden command). This module
 * bypasses Effect's structured argv parser entirely for that path (the args may
 * include partial/malformed flag tokens, e.g. `--de` mid-completion, that the
 * parser would reject) and instead reflects directly over `legacyRoot` — the
 * live Effect CLI command tree — to compute candidates.
 *
 * Deliberate, documented simplifications relative to real cobra (verified
 * empirically against a real `apps/cli-go` build during CLI-1965 review — see
 * that PR for the differential-testing detail):
 * - No `--help`-style multi-paragraph usage error for zero completion args
 *   (`MinimumNArgs(1)` failure) — real generated shell scripts always pass at
 *   least one arg, so this path is realistically unreachable by real
 *   completion traffic.
 * - No "Completion ended with directive: ..." trailer or `[Debug] [Error] ...`
 *   diagnostics — both are cobra-side stderr-only text every real generated
 *   completion script discards (`2>/dev/null` or equivalent), so reproducing
 *   them has zero observable effect on any user.
 * - Mutually-exclusive flag-group hiding (cobra's `enforceFlagGroupsForCompletion`,
 *   ~45 `MarkFlagsMutuallyExclusive` call sites in `apps/cli-go/cmd/`) is not
 *   reproduced — there is no equivalent flag-group annotation anywhere in this
 *   TS tree to mirror, and hand-building a ~45-entry shadow table carries a
 *   materially higher transcription-error risk than the small, stable tables
 *   below. Accepted as a documented gap.
 * - Deprecated commands/flags (cobra's `IsAvailableCommand()`/`MarkDeprecated`)
 *   are not filtered out of candidates — this TS tree has no "deprecated"
 *   concept distinct from `hidden` today (deprecation is only reflected in
 *   description text), so filtering it out here would require tree-level
 *   metadata this port doesn't own. Accepted as a documented gap, expected to
 *   shrink as the tree's own deprecated-alias cleanup lands separately.
 */

/* ========================================================================== */
/* Types                                                                      */
/* ========================================================================== */

export interface LegacyCompletionCandidate {
  readonly name: string;
  readonly description: string | undefined;
}

export interface LegacyCompletionResult {
  readonly candidates: ReadonlyArray<LegacyCompletionCandidate>;
  readonly directive: number;
}

/**
 * The subset of cobra's `ShellCompDirective` bit flags this port ever emits.
 */
export const LegacyCompletionDirective = {
  Default: 0,
  NoFileComp: 4,
  FilterFileExt: 8,
} as const;

export interface LegacyFlagDescriptor {
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly hidden: boolean;
  readonly description: string | undefined;
  readonly isVariadic: boolean;
  readonly isBoolean: boolean;
  /** `Param.Single`'s underlying `Primitive<A>._tag` (`"Boolean"`, `"Choice"`, `"Integer"`, ...). */
  readonly primitiveTag: string;
  /** The valid value set for a `primitiveTag === "Choice"` flag; `undefined` for every other tag. */
  readonly choiceKeys: ReadonlyArray<string> | undefined;
}

export interface LegacyCommandPathResolution {
  readonly commandChain: ReadonlyArray<Command.Command.Any>;
  readonly matchedPath: ReadonlyArray<string>;
  readonly leftoverArgs: ReadonlyArray<string>;
}

export interface LegacyClassifyCompletionInput {
  readonly finalCommand: Command.Command.Any;
  readonly matchedPath: ReadonlyArray<string>;
  readonly leftoverArgs: ReadonlyArray<string>;
  readonly trimmedArgs: ReadonlyArray<string>;
  readonly toComplete: string;
  readonly inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>;
}

export interface LegacyCompleteDeps {
  readonly root: Command.Command.Any;
  readonly argv: ReadonlyArray<string>;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdoutWrite: (message: string) => void;
  readonly exit: (code: number) => void;
}

/* ========================================================================== */
/* Internal command field access (`legacy-param-introspection.ts` precedent) */
/* ========================================================================== */

/**
 * `.config.flags` (a command's own declared flags), `.contextConfig.flags`
 * (flags inherited via `Command.withSharedFlags`), and `.globalFlags` (a
 * command's own declared global flags) are genuinely absent from the public
 * `Command`/`Command.Any` TypeScript interface — only `name`, `description`,
 * `shortDescription`, `alias`, `examples`, `subcommands`, `annotations`, and
 * `hidden` are public — but they exist at runtime (`internal/command.ts`'s
 * `makeCommand`, via `Object.assign`; that internal module is not importable
 * — its package.json export map entry is `null` — so there is no type-safe
 * import to reach for instead).
 *
 * A bare `as unknown as` here would silently paper over that gap (forbidden
 * by this repo's typing rules — see `CLAUDE.md`), so this narrows through a
 * runtime type guard instead, the same `"<field>" in value` shape
 * `legacy-param-introspection.ts`'s `legacyIsWrappedParam` already
 * establishes for the identical problem (an internal-only field the public
 * `effect/unstable/cli` types don't declare). If a future `effect` version
 * ever drops one of these fields, this throws instead of silently completing
 * against `undefined`.
 */
interface LegacyCommandInternal {
  readonly config: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly globalFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>;
}

function legacyHasCommandInternals(
  command: Command.Command.Any,
): command is Command.Command.Any & LegacyCommandInternal {
  return "config" in command && "contextConfig" in command && "globalFlags" in command;
}

function legacyInternalCommand(command: Command.Command.Any): LegacyCommandInternal {
  if (!legacyHasCommandInternals(command)) {
    throw new Error(
      `legacy-complete.ts: command "${command.name}" is missing the internal config/contextConfig/globalFlags fields shell completion relies on — effect's Command implementation shape may have changed.`,
    );
  }
  return command;
}

function legacyFlattenSubcommands(
  command: Command.Command.Any,
): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

/* ========================================================================== */
/* Flag descriptors                                                          */
/* ========================================================================== */

/**
 * `Flag.choice`/`Flag.choiceWithValue`'s `choiceKeys` (the valid value set) is
 * attached to the `Choice`-tagged `Primitive<A>` via `Object.assign` at
 * runtime (`Primitive.choice`,
 * `.repos/effect/packages/effect/src/unstable/cli/Primitive.ts`) but carries
 * an `@internal` JSDoc tag and is absent from the public `Primitive<A>`
 * interface — the identical gap `LegacyCommandInternal` above already works
 * around for `Command`, so this reuses the same runtime type-guard idiom
 * instead of an `as` cast.
 */
interface LegacyChoicePrimitive {
  readonly choiceKeys: ReadonlyArray<string>;
}

function legacyHasChoiceKeys(
  primitive: Primitive.Primitive<unknown>,
): primitive is Primitive.Primitive<unknown> & LegacyChoicePrimitive {
  return "choiceKeys" in primitive;
}

function legacyChoiceKeysOf(
  primitive: Primitive.Primitive<unknown>,
): ReadonlyArray<string> | undefined {
  return legacyHasChoiceKeys(primitive) ? primitive.choiceKeys : undefined;
}

function legacyFlagDescriptorFromParam(param: Param.AnyFlag): LegacyFlagDescriptor | undefined {
  const unwrapped = legacyUnwrapParam(param);
  if (unwrapped === undefined) return undefined;
  const { single, isVariadic } = unwrapped;
  return {
    name: single.name,
    aliases: single.aliases,
    hidden: single.hidden,
    description: Option.getOrUndefined(single.description),
    isVariadic,
    isBoolean: single.primitiveType._tag === "Boolean",
    primitiveTag: single.primitiveType._tag,
    choiceKeys: legacyChoiceKeysOf(single.primitiveType),
  };
}

/**
 * The full in-scope flag list for `commandChain`'s last element (the resolved
 * command): every command in the chain's own declared global flags
 * (`Command.withGlobalFlags` — not just `root`'s, since a non-root command can
 * declare its own, e.g. `legacySeedCommand`'s `--linked`/`--local`), plus the
 * always-available `--help` and (root only) `--version`, every ancestor's
 * shared flags (`Command.withSharedFlags`), and the resolved command's own
 * local flags.
 *
 * Later entries win on a canonical-name collision — e.g. a command's own local
 * `--output` (`db diff`'s file-path flag) must shadow the global `--output`
 * choice flag declared at root, mirroring pflag's `InheritedFlags()`, which
 * skips any persistent flag shadowed by a same-named local one.
 */
export function legacyCollectInScopeFlags(
  root: Command.Command.Any,
  commandChain: ReadonlyArray<Command.Command.Any>,
): ReadonlyArray<LegacyFlagDescriptor> {
  const finalCommand = commandChain[commandChain.length - 1] ?? root;
  const ancestors = commandChain.slice(0, -1);

  const chainGlobalFlagParams = commandChain
    .flatMap((command) => legacyInternalCommand(command).globalFlags)
    // `GlobalFlag.Completions`/`GlobalFlag.LogLevel` are TS-only framework
    // additions with no Go/cobra equivalent. They are normally only injected
    // via `GlobalFlag.BuiltIns` at parse time (never stored on a command's own
    // `.globalFlags`), so this filter is a defensive guard rather than
    // something that changes today's output — kept explicit so it stays true
    // if that ever changes.
    .filter((entry) => entry !== GlobalFlag.Completions && entry !== GlobalFlag.LogLevel)
    .map((entry) => entry.flag);

  const params: Array<Param.AnyFlag> = [
    ...chainGlobalFlagParams,
    GlobalFlag.Help.flag,
    // Cobra's `InitDefaultVersionFlag` only registers `--version`, and only on
    // the root command (gated on `c.Version != ""`, and non-persistent) — it
    // is never inherited by subcommands the way `--help` is.
    ...(commandChain.length === 1 ? [GlobalFlag.Version.flag] : []),
    ...ancestors.flatMap((ancestor) => legacyInternalCommand(ancestor).contextConfig.flags),
    ...legacyInternalCommand(finalCommand).config.flags,
  ];

  const byName = new Map<string, LegacyFlagDescriptor>();
  for (const param of params) {
    const descriptor = legacyFlagDescriptorFromParam(param);
    if (descriptor !== undefined) byName.set(descriptor.name, descriptor);
  }
  return Array.from(byName.values());
}

/* ========================================================================== */
/* Flag-token resolution                                                     */
/* ========================================================================== */

/**
 * Resolves a bare flag token (`--project-ref`, `-p`, or a shorthand cluster
 * like `-po`, where cobra's rule is "the character immediately before the
 * value/`=`", i.e. the last character) to its owning in-scope flag. Mirrors
 * cobra's `checkIfFlagCompletion` heuristic (`completions.go:676-681,702-707`,
 * the documented `-asd` => `d` quirk from cobra issue #1257) for guessing
 * which flag the CURRENT or immediately PRECEDING token is mid-way through
 * value-completing — deliberately NOT the same algorithm as
 * `legacyResolveShortFlagCluster`, which mirrors the real, strict
 * `ParseFlags()` parser instead (first character owns the value, not last).
 * See that function's doc comment for why the two differ and where each is
 * used.
 */
function legacyResolveFlagFromToken(
  token: string,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): LegacyFlagDescriptor | undefined {
  if (token.startsWith("--")) {
    const name = token.slice(2);
    return inScopeFlags.find((flag) => flag.name === name);
  }
  if (token.startsWith("-") && token.length > 1) {
    const shorthand = token.charAt(token.length - 1);
    return inScopeFlags.find((flag) => flag.aliases.includes(shorthand));
  }
  return undefined;
}

/* ========================================================================== */
/* Command-path resolution                                                   */
/* ========================================================================== */

/**
 * Descends from `root` through `trimmedArgs`, matching each non-flag token
 * against the current command's subcommand names/aliases (exact,
 * case-sensitive — no prefix or fuzzy matching). Mirrors cobra's `Find()`,
 * which strips flags before matching positional command names
 * (`completions.go:340`) via its own heuristic `stripFlags`
 * (`pflag@v1.0.9/flag.go`) — a cruder, command-tree-only pre-pass distinct
 * from the real flag parser `legacyChangedFlagNames` mirrors:
 *
 * - A long flag (`--foo`) or a single-character short flag (`-f`) with no
 *   embedded `=` consumes the following token as its value UNLESS it's
 *   already known at this point in the descent to be boolean — this
 *   includes flags not yet in scope, e.g. a subcommand's own local flag
 *   typed before that subcommand is reached (`--db-url`, local to `db
 *   dump`, typed before `db`): `stripFlags`'s `hasNoOptDefVal` returns
 *   `false` for a name it can't find yet, so `!hasNoOptDefVal(...)` is
 *   `true` and it optimistically consumes a value anyway (verified
 *   empirically against a real `apps/cli-go` build: `__complete --db-url
 *   postgres:// db dump --s` still offers `db dump`'s `--schema`, which
 *   requires descending past `--db-url postgres://` to reach `db dump` at
 *   all).
 * - Anything else flag-shaped — a multi-character shorthand cluster
 *   (`-rj`), a flag containing `=`, or a bare `--` — is skipped without
 *   consuming a value. A bare `--` additionally stops the descent
 *   entirely: it's pflag's end-of-flags sentinel, so no token at or after
 *   it can ever match a subcommand (verified empirically: `__complete --
 *   db ""` returns zero candidates with the Default directive, not `db`'s
 *   subcommands).
 *
 * Descent stops at the first non-flag token that doesn't match a subcommand,
 * or at a `--` sentinel; that token and everything after it becomes
 * `leftoverArgs` — the *positional* leftover cobra's `finalArgs` represents
 * (`completions.go:397-399`), used to gate subcommand-name completion
 * (`len(finalArgs) == 0`). Flag tokens and their consumed values are never
 * part of `leftoverArgs`.
 */
export function legacyResolveCommandPath(
  root: Command.Command.Any,
  trimmedArgs: ReadonlyArray<string>,
): LegacyCommandPathResolution {
  const commandChain: Array<Command.Command.Any> = [root];
  const matchedPath: Array<string> = [];
  const consumedIndices = new Set<number>();

  let current = root;
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    if (token === undefined) {
      index++;
      continue;
    }

    if (token === "--") break; // pflag's end-of-flags sentinel: nothing at or after this can match a subcommand.

    if (token.startsWith("-")) {
      consumedIndices.add(index);
      const isLong = token.startsWith("--");
      const isSingleCharShort = !isLong && token.length === 2;
      if (!token.includes("=") && (isLong || isSingleCharShort)) {
        // The flags visible at this point of the descent are enough to tell
        // whether this token consumes the next one as its value.
        const inScopeSoFar = legacyCollectInScopeFlags(root, commandChain);
        const resolved = legacyResolveFlagFromToken(token, inScopeSoFar);
        // An unrecognized flag is optimistically assumed to take a value too
        // (see the doc comment above) — only a flag already known here to be
        // boolean is exempt.
        const takesValue = resolved === undefined || !resolved.isBoolean;
        if (takesValue && index + 1 < trimmedArgs.length) {
          consumedIndices.add(index + 1);
          index += 2;
          continue;
        }
      }
      index++;
      continue;
    }

    const match = legacyFlattenSubcommands(current).find(
      (candidate) => candidate.name === token || candidate.alias === token,
    );
    if (match === undefined) break; // stop descending; this and later tokens are leftover
    current = match;
    commandChain.push(match);
    matchedPath.push(match.name);
    consumedIndices.add(index);
    index++;
  }

  const leftoverArgs = trimmedArgs.filter((_, i) => !consumedIndices.has(i));
  return { commandChain, matchedPath, leftoverArgs };
}

/* ========================================================================== */
/* Classification                                                            */
/* ========================================================================== */

const LEGACY_HELP_TOKENS: ReadonlySet<string> = new Set(["--help", "-h"]);
/**
 * Only checked when the resolved command IS the root (`matchedPath.length ===
 * 0`) — cobra's `--version` flag lives on the root command only (see
 * `legacyCollectInScopeFlags`'s comment), so a `--version`/`-v` token typed
 * while completing a subcommand's own arguments (e.g. `migration squash
 * --version <N>`, a genuine local flag unrelated to cobra's built-in one)
 * must not be mistaken for it.
 */
const LEGACY_VERSION_TOKENS: ReadonlySet<string> = new Set(["--version", "-v"]);

/**
 * Mirrors cobra's `MarkFlagFilename` calls in `apps/cli-go/cmd/sso.go:166,167,181,182`
 * — 4 individually hardcoded lines in Go, not derived from anything generic,
 * so a small matching lookup table here is the right level of fidelity. Key =
 * `<space-joined resolved command path (excluding "supabase")>:<flag name>`.
 */
const LEGACY_COMPLETION_FLAG_FILE_EXTENSIONS: ReadonlyMap<string, ReadonlyArray<string>> = new Map([
  ["sso add:metadata-file", ["xml"]],
  ["sso add:attribute-mapping-file", ["json"]],
  ["sso update:metadata-file", ["xml"]],
  ["sso update:attribute-mapping-file", ["json"]],
]);

/**
 * Mirrors cobra's unconditional, `init()`-time `MarkFlagRequired` calls — the
 * ONLY ones active during `__complete`/`__completeNoDesc`, since cobra's
 * `getCompletions` never runs `PreRun`/`PersistentPreRunE`/`RunE`
 * (`completions.go` never calls `Execute()`). Several more `MarkFlagRequired`
 * calls exist in `apps/cli-go/cmd/` but are scoped inside those hooks
 * (conditional on other flags or TTY state) and therefore never apply to a
 * real completion request — deliberately excluded here: `db dump:data-only`
 * (`cmd/db.go:140`, inside `PreRun`), `init:experimental` (`cmd/init.go:34`,
 * inside `PreRun`), `projects create:{org-id,db-password,region}`
 * (`cmd/projects.go:64-66`, inside `PreRunE`), `link:project-ref`
 * (`cmd/link.go:25`, inside `PreRunE`).
 *
 * Deliberately a hardcoded table, not derived from whether the TS flag is
 * `Flag.optional`-wrapped: several of these TS flags are intentionally
 * `Flag.optional` at parse time for validation-ordering reasons unrelated to
 * completion (e.g. `vanity-subdomains activate --desired-subdomain` — see
 * that command's own file comment), so "is this flag `Optional`-wrapped in
 * TS" is not a faithful proxy for "does cobra mark it required." Key =
 * `<matched command path>:<flag name>`.
 */
const LEGACY_COMPLETION_REQUIRED_FLAGS: ReadonlySet<string> = new Set([
  "domains create:custom-hostname", // cmd/domains.go:100
  "migration repair:status", // cmd/migration.go:122
  "gen bearer-jwt:role", // cmd/gen.go:175
  "sso add:type", // cmd/sso.go:165
  "vanity-subdomains activate:desired-subdomain", // cmd/vanitySubdomains.go:67
  "vanity-subdomains check-availability:desired-subdomain", // cmd/vanitySubdomains.go:69
]);

function legacyIsRequiredCompletionFlag(
  matchedPath: ReadonlyArray<string>,
  flagName: string,
): boolean {
  return LEGACY_COMPLETION_REQUIRED_FLAGS.has(`${matchedPath.join(" ")}:${flagName}`);
}

/**
 * Mirrors cobra's `InitDefaultCompletionCmd` (`completions.go:769-928`),
 * which registers `ValidArgsFunction: NoFileCompletions` on the `completion`
 * group command itself and each of its `bash`/`zsh`/`fish`/`powershell`
 * leaves — the only `ValidArgsFunction`/`ValidArgs` usage anywhere relevant
 * to this tree (`apps/cli-go/cmd/`, `apps/cli-go/internal/` register none of
 * their own). `getCompletions` always calls a resolved command's own
 * `ValidArgsFunction` when one is registered, and that call OVERWRITES the
 * directive outright (`completions.go:564-579`) — for a leaf like
 * `completion bash`, which has no subcommands of its own to otherwise set
 * NoFileComp, this is the ONLY thing that sets it (verified empirically
 * against a real `apps/cli-go` build: `completion bash ""` returns the
 * NoFileComp directive with zero candidates, not Default — CLI-1965 review
 * finding). Key = space-joined `matchedPath` (excluding "supabase").
 */
const LEGACY_COMPLETION_NO_FILE_COMP_PATHS: ReadonlySet<string> = new Set([
  "completion",
  "completion bash",
  "completion zsh",
  "completion fish",
  "completion powershell",
]);

function legacyFlagNameCandidates(
  flag: LegacyFlagDescriptor,
  toComplete: string,
): ReadonlyArray<LegacyCompletionCandidate> {
  const candidates: Array<LegacyCompletionCandidate> = [];
  const long = `--${flag.name}`;
  if (long.startsWith(toComplete)) candidates.push({ name: long, description: flag.description });
  for (const alias of flag.aliases) {
    if (alias.length !== 1) continue;
    const short = `-${alias}`;
    if (short.startsWith(toComplete))
      candidates.push({ name: short, description: flag.description });
  }
  return candidates;
}

/**
 * A lightweight, string-only approximation of "which in-scope flags have
 * already been provided" (not a real flag parser, but close enough to mirror
 * pflag's actual `Set`-time behavior for the shapes real completion input
 * takes) — correct for the overwhelming majority of real completion inputs.
 *
 * Stops at a bare `--` the same way `legacyFindUnresolvedFlagToken` and
 * `legacyResolveCommandPath` do — pflag's end-of-flags sentinel means
 * nothing at or after it is ever parsed as a flag, so nothing past it can be
 * "changed" (verified empirically against a real `apps/cli-go` build: `sso
 * add -- --type --typ` still offers `--type`, since that token is
 * positional, past the terminator, and never reaches pflag's flag parser at
 * all — CLI-1965 review finding).
 *
 * A LONG flag with no `=` that resolves to a non-boolean in-scope flag
 * consumes the immediately following token as its value — that token is
 * skipped here entirely, exactly like pflag's `parseLongArg`
 * (`pflag@v1.0.10/flag.go:1013-1023`), so a value that happens to look like a
 * flag (e.g. `--domains --type foo`, where `--type` is `--domains`'s value)
 * is never itself marked changed (CLI-1965 review finding, verified
 * empirically against a real `apps/cli-go` build).
 *
 * A short-flag token walks its shorthand cluster exactly like
 * `pflag@v1.0.10`'s `parseSingleShortArg`: each character that resolves to a
 * boolean (`NoOptDefVal != ""`) flag is marked changed and the walk continues
 * to the next character in the SAME token; the first non-boolean character
 * (or a `=value` suffix) is also marked changed but ends the walk there,
 * since the rest of the token (or the next arg) is that flag's value, not
 * another shorthand (verified empirically against a real `apps/cli-go`
 * build: after `storage cp -rj 2`, both `-r`/`--recursive` and `-j`/`--jobs`
 * are "changed" — `--r<TAB>` offers nothing further — whereas this function
 * used to record only the cluster's last character).
 */
function legacyChangedFlagNames(
  trimmedArgs: ReadonlyArray<string>,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined) continue;
    if (token === "--") break; // pflag's end-of-flags sentinel: nothing at or after this is parsed as a flag.

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      const equalsIndex = rest.indexOf("=");
      const name = equalsIndex === -1 ? rest : rest.slice(0, equalsIndex);
      if (name.length > 0) changed.add(name);
      if (equalsIndex === -1 && index < trimmedArgs.length) {
        const owner = inScopeFlags.find((flag) => flag.name === name);
        if (owner !== undefined && !owner.isBoolean) index++; // consumes the next token as its value.
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const consumesNextToken = legacyMarkChangedShorthandCluster(token, inScopeFlags, changed);
      if (consumesNextToken && index < trimmedArgs.length) index++;
    }
  }
  return changed;
}

/**
 * Walks a short-flag token's shorthand cluster (e.g. `-rj`, `-o=json`),
 * marking every shorthand consumed before — and including — the
 * value-consuming one as changed. Returns `true` when the cluster ends on a
 * non-boolean shorthand with no attached value (`-f`, or `-rf` ending on
 * `f`) — the caller must then skip the immediately following token, since
 * pflag consumes it as that shorthand's value rather than parsing it as its
 * own flag. See `legacyChangedFlagNames`'s doc comment for the pflag
 * behavior this mirrors.
 */
function legacyMarkChangedShorthandCluster(
  token: string,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
  changed: Set<string>,
): boolean {
  let shorthands = token.slice(1);
  while (shorthands.length > 0) {
    const owner = inScopeFlags.find((flag) => flag.aliases.includes(shorthands.charAt(0)));
    if (owner === undefined) return false; // unresolved shorthand — defensive stop, already filtered upstream.
    changed.add(owner.name);
    if (shorthands.length > 1 && shorthands.charAt(1) === "=") return false; // "-f=value": cluster ends at the explicit value.
    if (!owner.isBoolean) return shorthands.length === 1; // non-boolean: the rest of the token (if any) is its value; otherwise the next arg is.
    shorthands = shorthands.slice(1); // boolean shorthand consumed no value — keep walking the cluster.
  }
  return false;
}

/**
 * Validates a flag's value the way pflag's typed `Value.Set` does inside
 * `finalCmd.ParseFlags()` — e.g. `-o not-a-format` (a `Choice`-typed
 * `--output`) or `--debug=maybe` (a `Boolean`-typed `--debug`) fail to parse
 * in real pflag, and cobra reports the parse error instead of generating any
 * completions (verified empirically against a real `apps/cli-go` build: both
 * return zero candidates with the Default directive, exactly like an
 * unresolved flag name). Only the primitive shapes pflag can actually reject
 * are checked; `String`/`Path`/`Date`/etc. flags accept any string in Go too,
 * so every other tag is unconditionally valid here.
 */
function legacyIsValidFlagValue(flag: LegacyFlagDescriptor, value: string): boolean {
  switch (flag.primitiveTag) {
    case "Boolean":
      return legacyParseGoBool(value) !== undefined;
    case "Choice":
      return flag.choiceKeys !== undefined && flag.choiceKeys.includes(value);
    case "Integer":
      return /^[+-]?\d+$/.test(value);
    case "Float":
      return value.trim().length > 0 && !Number.isNaN(Number(value));
    default:
      return true;
  }
}

/**
 * Walks a short-flag cluster (`-o`, `-ojson`, `-rj`, `-o=json`) the same way
 * pflag's `parseSingleShortArg` does (`pflag@v1.0.10/flag.go:1040-1114`) —
 * first character owns the value, not last. This is deliberately a
 * DIFFERENT algorithm from `legacyResolveFlagFromToken`'s last-character
 * resolution: that function mirrors cobra's OWN separate, narrower
 * `checkIfFlagCompletion` heuristic, used only to guess "is the CURRENT or
 * PRECEDING token mid-way through being value-completed" — not to strictly
 * parse a token that's already fully typed. This function mirrors the real
 * strict parser (`finalCmd.ParseFlags()`) instead, used by
 * `legacyFindUnresolvedFlagToken` (verified empirically against a real
 * `apps/cli-go` build: `functions deploy -j4 --p` still offers
 * `--profile`/`--project-ref`/`--prune` — `-j4` is a fully valid, already-
 * resolved `--jobs=4`, not an unknown flag — CLI-1965 review finding).
 *
 * Returns `undefined` if any character in the cluster doesn't resolve to an
 * in-scope flag shorthand. Otherwise returns the flag that ultimately owns
 * the cluster's (possibly absent) attached value — the first non-boolean
 * shorthand encountered, or the cluster's last shorthand if every character
 * in it is boolean — plus that attached value, which is `undefined` only
 * when there is nothing left in the token to attach (`-o` alone, or an
 * all-boolean cluster like `-rf`), meaning a following token supplies it
 * instead.
 */
function legacyResolveShortFlagCluster(
  token: string,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): { readonly flag: LegacyFlagDescriptor; readonly attachedValue: string | undefined } | undefined {
  let shorthands = token.slice(1);
  let lastResolved: LegacyFlagDescriptor | undefined;
  while (shorthands.length > 0) {
    const owner = inScopeFlags.find((flag) => flag.aliases.includes(shorthands.charAt(0)));
    if (owner === undefined) return undefined;
    lastResolved = owner;
    if (shorthands.length > 1 && shorthands.charAt(1) === "=") {
      return { flag: owner, attachedValue: shorthands.slice(2) };
    }
    if (!owner.isBoolean) {
      return {
        flag: owner,
        attachedValue: shorthands.length > 1 ? shorthands.slice(1) : undefined,
      };
    }
    shorthands = shorthands.slice(1); // boolean shorthand consumed no value — keep walking the cluster.
  }
  return lastResolved === undefined ? undefined : { flag: lastResolved, attachedValue: undefined };
}

/**
 * Finds the first token in `trimmedArgs` that either (a) looks like a flag
 * (starts with `-`, excluding the bare `-` positional pflag itself treats as
 * a non-flag argument) but does not resolve to anything in `inScopeFlags`,
 * (b) resolves to a real flag whose value `legacyIsValidFlagValue` rejects,
 * or (c) resolves to a real, non-boolean flag with NO value available at all
 * — no attached suffix and no following token — AND `toComplete` itself is a
 * bare flag-shaped token (starts with `-`, no `=`).
 *
 * That last condition mirrors a real two-part cobra/pflag interaction:
 * cobra's `checkIfFlagCompletion` only rescues a trailing incomplete flag
 * from `ParseFlags()` (treating it as "the flag currently being
 * value-completed" instead of a parse error) when `toComplete` is EMPTY or
 * otherwise not itself flag-shaped (`completions.go:666-687`); when
 * `toComplete` IS flag-shaped with no `=`, that rescue never happens and the
 * real `finalCmd.ParseFlags()` call (`completions.go:373-375`) fails
 * outright on the dangling flag (verified empirically against a real
 * `apps/cli-go` build: `__complete -o --d` returns zero candidates with the
 * Default directive — Go's `ParseFlags` error is "flag needs an argument:
 * 'o' in -o" — while `__complete -o ''` and `__complete -o pre` both instead
 * fall through to flag-VALUE completion for `--output`, per
 * `legacyClassifyCompletion`'s Case 2 — CLI-1965 review finding).
 *
 * Long flags (`--foo`, `--foo=bar`) resolve via `legacyResolveFlagFromToken`
 * (no first/last-character ambiguity for a `--name` token). Short flags
 * resolve via `legacyResolveShortFlagCluster` instead — see that function's
 * doc comment for why this deliberately does NOT reuse
 * `legacyResolveFlagFromToken`'s last-character heuristic here.
 *
 * Consumes a following token as a non-boolean flag's value the same way
 * `legacyResolveCommandPath` does. A bare `--` ends the scan entirely without
 * itself counting as unresolved — pflag's own end-of-flags sentinel, after
 * which everything is positional, not a flag to validate (`pflag@v1.0.9`'s
 * `parseArgs`: `if s[1] == '-' { if len(s) == 2 { ... terminates the flags`).
 * Returns the offending token, or `undefined` if every flag-shaped token
 * resolves to a real flag with a valid, available value.
 *
 * Mirrors cobra's real two-phase design: `Find()` tolerantly skips flags it
 * doesn't recognize while walking for a subcommand name (see
 * `legacyResolveCommandPath`, which only needs to know "does this consume a
 * value", not "is this real"), but the later `finalCmd.ParseFlags()` strictly
 * validates every remaining flag token — both that it resolves AND that its
 * value parses — against the fully-resolved command's complete flag set, and
 * fails outright on the first one that doesn't (`completions.go:373-375`) — a
 * failure so early it wins even over the `--help`/`--version` short-circuit
 * below (verified empirically against a real `apps/cli-go` build: both
 * `__complete --bogus --help ""` and `__complete --help --bogus ""` report
 * the unknown flag, not help; a bare `__complete --bogus ""` returns zero
 * candidates with the Default directive, not the root subcommand list;
 * `__complete -- ""` is unaffected and still lists every root subcommand).
 */
function legacyFindUnresolvedFlagToken(
  trimmedArgs: ReadonlyArray<string>,
  toComplete: string,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): string | undefined {
  // See this function's doc comment: only a `toComplete` that's itself a
  // bare flag-shaped token (no `=`) blocks cobra's "rescue" of a trailing,
  // value-less flag — every other shape of `toComplete` leaves it for
  // flag-VALUE completion instead, so a missing value at the end of
  // `trimmedArgs` is not, by itself, unresolved in that case.
  const trailingMissingValueIsFatal = toComplete.startsWith("-") && !toComplete.includes("=");

  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined || token === "-" || !token.startsWith("-")) continue;
    if (token === "--") break;

    if (token.startsWith("--")) {
      const equalsIndex = token.indexOf("=");
      const bareToken = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
      const resolved = legacyResolveFlagFromToken(bareToken, inScopeFlags);
      if (resolved === undefined) return token;

      if (equalsIndex !== -1) {
        if (!legacyIsValidFlagValue(resolved, token.slice(equalsIndex + 1))) return token;
        continue;
      }
      if (resolved.isBoolean) continue;
      if (index >= trimmedArgs.length) {
        if (trailingMissingValueIsFatal) return token;
        continue;
      }
      const value = trimmedArgs[index];
      index++; // skip the consumed value token
      if (value !== undefined && !legacyIsValidFlagValue(resolved, value)) return value;
      continue;
    }

    const cluster = legacyResolveShortFlagCluster(token, inScopeFlags);
    if (cluster === undefined) return token;
    if (cluster.flag.isBoolean) continue;
    if (cluster.attachedValue !== undefined) {
      if (!legacyIsValidFlagValue(cluster.flag, cluster.attachedValue)) return token;
      continue;
    }
    if (index >= trimmedArgs.length) {
      if (trailingMissingValueIsFatal) return token;
      continue;
    }
    const value = trimmedArgs[index];
    index++; // skip the consumed value token
    if (value !== undefined && !legacyIsValidFlagValue(cluster.flag, value)) return value;
  }
  return undefined;
}

function legacyFlagValueCompletion(
  matchedPath: ReadonlyArray<string>,
  flagName: string | undefined,
): LegacyCompletionResult {
  const key = flagName === undefined ? undefined : `${matchedPath.join(" ")}:${flagName}`;
  const extensions =
    key === undefined ? undefined : LEGACY_COMPLETION_FLAG_FILE_EXTENSIONS.get(key);
  if (extensions !== undefined) {
    return {
      candidates: extensions.map((extension) => ({ name: extension, description: undefined })),
      directive: LegacyCompletionDirective.FilterFileExt,
    };
  }
  return { candidates: [], directive: LegacyCompletionDirective.Default };
}

/**
 * Classifies a single completion request into candidates + directive,
 * mirroring cobra's `checkIfFlagCompletion` and the branch in
 * `getCompletions` that follows it:
 *
 * 0. A flag-shaped token that doesn't resolve to any in-scope flag
 *    short-circuits to no candidates with the Default directive — mirrors
 *    `finalCmd.ParseFlags()` failing outright on an unrecognized flag, which
 *    wins even over `--help`/`--version` below.
 * 1. `--help`/`-h` anywhere in `trimmedArgs` (or `--version`/`-v`, only when
 *    resolved to the root command) short-circuits to no candidates — these
 *    exit before any real completion runs.
 * 2. A bare `--` anywhere in `trimmedArgs` disables ALL flag-name and
 *    flag-value completion (Cases 3/4 below) for the rest of this request —
 *    mirrors cobra's `flagCompletion` gate, which goes false the moment a
 *    previous `--` is already present (`completions.go:364-381`; see
 *    `hasFlagTerminator` below).
 * 3. `toComplete` is a bare flag with no `=` → flag-NAME completion.
 * 4. `toComplete` (or the immediately preceding token) identifies a
 *    non-boolean flag's value slot → flag-VALUE completion.
 * 5. Otherwise → subcommand-name + required-flag (noun) completion; five
 *    specific leaf paths (`completion[ bash|zsh|fish|powershell]`) force the
 *    directive to NoFileComp regardless of what the subcommand walk above
 *    computed — see `LEGACY_COMPLETION_NO_FILE_COMP_PATHS`.
 */
export function legacyClassifyCompletion(
  input: LegacyClassifyCompletionInput,
): LegacyCompletionResult {
  const { finalCommand, matchedPath, leftoverArgs, trimmedArgs, toComplete, inScopeFlags } = input;
  const isAtRoot = matchedPath.length === 0;

  if (legacyFindUnresolvedFlagToken(trimmedArgs, toComplete, inScopeFlags) !== undefined) {
    return { candidates: [], directive: LegacyCompletionDirective.Default };
  }

  if (
    trimmedArgs.some((token) => LEGACY_HELP_TOKENS.has(token)) ||
    (isAtRoot && trimmedArgs.some((token) => LEGACY_VERSION_TOKENS.has(token)))
  ) {
    return { candidates: [], directive: LegacyCompletionDirective.NoFileComp };
  }

  const changedFlagNames = legacyChangedFlagNames(trimmedArgs, inScopeFlags);
  const requiredFlags = inScopeFlags.filter(
    (flag) =>
      legacyIsRequiredCompletionFlag(matchedPath, flag.name) && !changedFlagNames.has(flag.name),
  );

  const toCompleteIsFlag = toComplete.startsWith("-");
  const toCompleteEqualsIndex = toComplete.indexOf("=");
  // Once a bare `--` sentinel has already appeared, cobra never does
  // flag-name or flag-value completion again for the rest of the request
  // (verified empirically against a real `apps/cli-go` build: `db dump --
  // --s` returns zero candidates with the Default directive, not
  // `--schema` — CLI-1965 review finding).
  const hasFlagTerminator = trimmedArgs.includes("--");

  // Case 1: flag-NAME completion.
  if (!hasFlagTerminator && toCompleteIsFlag && toCompleteEqualsIndex === -1) {
    const requiredCandidates = requiredFlags.flatMap((flag) =>
      legacyFlagNameCandidates(flag, toComplete),
    );
    // Once ANY required flag is still unset, ONLY required flags are
    // offered — this exactly mirrors cobra.
    if (requiredCandidates.length > 0) {
      return { candidates: requiredCandidates, directive: LegacyCompletionDirective.NoFileComp };
    }
    const candidates = inScopeFlags
      .filter((flag) => !flag.hidden && (!changedFlagNames.has(flag.name) || flag.isVariadic))
      .flatMap((flag) => legacyFlagNameCandidates(flag, toComplete));
    return { candidates, directive: LegacyCompletionDirective.NoFileComp };
  }

  // Case 2: flag-VALUE completion.
  if (!hasFlagTerminator) {
    if (toCompleteIsFlag) {
      // toCompleteEqualsIndex !== -1 here — the no-`=` branch above returns.
      // Cobra's checkIfFlagCompletion treats ANY `--flag=value` token
      // (including a boolean's) as flag-value completion — the "reset to
      // noun completion for a boolean" only applies in the separate no-`=`
      // two-token case handled by the `else` branch below
      // (`completions.go`'s `!flagWithEqual` guard around that reset;
      // verified empirically against a real `apps/cli-go` build:
      // `--debug=maybe` returns zero candidates with the Default directive,
      // not the root command list — CLI-1965 review finding).
      const resolved = legacyResolveFlagFromToken(
        toComplete.slice(0, toCompleteEqualsIndex),
        inScopeFlags,
      );
      return legacyFlagValueCompletion(matchedPath, resolved?.name);
    }
    const precedingToken = trimmedArgs[trimmedArgs.length - 1];
    if (
      precedingToken !== undefined &&
      precedingToken.startsWith("-") &&
      !precedingToken.includes("=")
    ) {
      const resolved = legacyResolveFlagFromToken(precedingToken, inScopeFlags);
      if (resolved === undefined) {
        // Cobra's checkIfFlagCompletion errors out here (a `flagCompError`
        // short-circuits `getCompletions` outright) rather than falling
        // through to noun completion — an unresolved trailing flag (per
        // that function's OWN last-character heuristic, not
        // `legacyFindUnresolvedFlagToken`'s strict first-character parse)
        // before an empty/non-flag toComplete is a hard stop (verified
        // empirically against a real `apps/cli-go` build: `-ojson ""`
        // returns zero candidates with the Default directive, even though
        // `-ojson` is a perfectly valid `-o=json` under real pflag parsing
        // — cobra's own heuristic looks at `-ojson`'s LAST character, `n`,
        // which resolves to nothing).
        return { candidates: [], directive: LegacyCompletionDirective.Default };
      }
      if (!resolved.isBoolean) {
        return legacyFlagValueCompletion(matchedPath, resolved.name);
      }
      // A resolved BOOLEAN precedingToken falls through to Case 3 — it
      // never consumed a value, so this wasn't really flag-value
      // completion.
    }
  }

  // Case 3: subcommand-name + required-flag (bare noun) completion.
  const candidates: Array<LegacyCompletionCandidate> = [];
  let directive: number = LegacyCompletionDirective.Default;

  // Once any flag or extra positional token has already appeared before this
  // position, subcommand-name completion is suppressed entirely (cobra's
  // `len(finalArgs) == 0` gate) — including the directive it would otherwise
  // set, which stays at `Default` in that case (`completions.go:489,499-522`).
  if (leftoverArgs.length === 0) {
    const visibleSubcommands = legacyFlattenSubcommands(finalCommand).filter((sub) => !sub.hidden);
    if (visibleSubcommands.length > 0) {
      directive = LegacyCompletionDirective.NoFileComp;
      const subcommandCandidates: Array<LegacyCompletionCandidate> = visibleSubcommands.map(
        (sub) => ({ name: sub.name, description: sub.shortDescription ?? sub.description }),
      );
      // Cobra's `InitDefaultHelpCmd` (`command.go:1100,1263-1266`) auto-registers a
      // `help` subcommand on whichever command `ExecuteC()` is called against —
      // here, always the root — but never recursively on descendants (verified
      // empirically against a real `apps/cli-go` build: `__complete db ""` does
      // NOT surface it, only `__complete ""` does). This TS tree has no explicit
      // `help` command node to walk, so synthesize the one candidate cobra would
      // otherwise contribute, matching its literal `Short` text.
      if (isAtRoot) {
        subcommandCandidates.push({ name: "help", description: "Help about any command" });
      }
      // Cobra's own `Commands()` — what its subcommand-name completion walks —
      // sorts alphabetically by name whenever `EnableCommandSorting` (the
      // default) is on. This tree's subcommand declarations already happen to
      // be listed alphabetically, so this sort is a no-op everywhere except at
      // the root, where it places the synthetic "help" entry above in its
      // correct alphabetical position.
      subcommandCandidates.sort((a, b) => a.name.localeCompare(b.name));
      for (const candidate of subcommandCandidates) {
        if (candidate.name.startsWith(toComplete)) {
          candidates.push(candidate);
        }
      }
    }
  }

  // Unconditional append in cobra — not gated on `leftoverArgs`.
  for (const flag of requiredFlags) {
    candidates.push(...legacyFlagNameCandidates(flag, toComplete));
  }

  // Cobra always invokes a resolved command's own `ValidArgsFunction` (when
  // registered) at the very end of `getCompletions`, and that call
  // OVERWRITES whatever directive the subcommand walk above already set
  // (`completions.go:564-579`) — see `LEGACY_COMPLETION_NO_FILE_COMP_PATHS`'s
  // doc comment for which paths this applies to and why.
  if (LEGACY_COMPLETION_NO_FILE_COMP_PATHS.has(matchedPath.join(" "))) {
    directive = LegacyCompletionDirective.NoFileComp;
  }

  return { candidates, directive };
}

/* ========================================================================== */
/* Orchestration                                                             */
/* ========================================================================== */

/**
 * The pure, deps-free completion algorithm: resolves the command path,
 * collects in-scope flags, and classifies the request. Returns `undefined`
 * when `argv[0]` isn't a completion request, or when cobra's `args` (i.e.
 * `argv.slice(1)`) is empty — mirroring cobra's own `MinimumNArgs(1)` failure
 * (see the module doc comment for why that case isn't otherwise reproduced).
 */
export function legacyRespondToComplete(
  root: Command.Command.Any,
  argv: ReadonlyArray<string>,
): LegacyCompletionResult | undefined {
  if (argv[0] !== "__complete" && argv[0] !== "__completeNoDesc") return undefined;

  const args = argv.slice(1);
  if (args.length === 0) return undefined;

  const toComplete = args[args.length - 1] ?? "";
  const trimmedArgs = args.slice(0, -1);

  const { commandChain, matchedPath, leftoverArgs } = legacyResolveCommandPath(root, trimmedArgs);
  const finalCommand = commandChain[commandChain.length - 1] ?? root;
  const inScopeFlags = legacyCollectInScopeFlags(root, commandChain);

  return legacyClassifyCompletion({
    finalCommand,
    matchedPath,
    leftoverArgs,
    trimmedArgs,
    toComplete,
    inScopeFlags,
  });
}

/* ========================================================================== */
/* Response formatting                                                       */
/* ========================================================================== */

const GO_TRUE_BOOL_SPELLINGS: ReadonlySet<string> = new Set([
  "1",
  "t",
  "T",
  "TRUE",
  "true",
  "True",
]);
const GO_FALSE_BOOL_SPELLINGS: ReadonlySet<string> = new Set([
  "0",
  "f",
  "F",
  "FALSE",
  "false",
  "False",
]);

function legacyParseGoBool(value: string): boolean | undefined {
  if (GO_TRUE_BOOL_SPELLINGS.has(value)) return true;
  if (GO_FALSE_BOOL_SPELLINGS.has(value)) return false;
  return undefined;
}

/**
 * Cobra's real, undocumented-to-users-but-real `getEnvConfig` behavior:
 * `argv[0] === "__completeNoDesc"` always wins; otherwise
 * `SUPABASE_COMPLETION_DESCRIPTIONS` (program-specific) is checked first,
 * falling back to the generic `COBRA_COMPLETION_DESCRIPTIONS` when unset or
 * empty. An unparseable value (per Go's `strconv.ParseBool` accepted
 * spellings) is ignored, leaving the `argv[0]`-derived default in place.
 */
export function legacyResolveIncludeDescriptions(
  argv0: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  let includeDescriptions = argv0 !== "__completeNoDesc";
  if (includeDescriptions) {
    const raw = env.SUPABASE_COMPLETION_DESCRIPTIONS || env.COBRA_COMPLETION_DESCRIPTIONS || "";
    const parsed = legacyParseGoBool(raw);
    if (parsed !== undefined) includeDescriptions = parsed;
  }
  return includeDescriptions;
}

function legacyFormatCompletionLine(
  candidate: LegacyCompletionCandidate,
  includeDescriptions: boolean,
): string {
  if (!includeDescriptions) return candidate.name.trim();
  const firstDescriptionLine = (candidate.description ?? "").split("\n")[0] ?? "";
  // `.trim()` on the whole joined string (not just the description) is what
  // makes a candidate with no description end up as a bare name with no
  // trailing tab, not `"name\t"` — reproduces cobra's exact `TrimSpace` step.
  return `${candidate.name}\t${firstDescriptionLine}`.trim();
}

/**
 * Formats a completion result the way cobra's generated shell scripts expect:
 * one line per candidate (`name` or `name\tdescription`), then a final
 * `:<directive>` line. Every line ends with `\n`.
 */
export function legacyFormatCompletionResponse(
  response: LegacyCompletionResult,
  includeDescriptions: boolean,
): string {
  const lines = response.candidates.map((candidate) =>
    legacyFormatCompletionLine(candidate, includeDescriptions),
  );
  lines.push(`:${response.directive}`);
  return lines.map((line) => `${line}\n`).join("");
}

/* ========================================================================== */
/* Entry point                                                               */
/* ========================================================================== */

/**
 * Entry-point interceptor with the same shape/contract as the old
 * `tryCompletePassthrough`: runs before Effect's CLI argv parser, returns
 * `false` immediately (no side effects) when `deps.argv[0]` isn't a
 * completion request, otherwise fully handles it and returns `true`.
 */
export function legacyTryComplete(deps: LegacyCompleteDeps): boolean {
  if (deps.argv[0] !== "__complete" && deps.argv[0] !== "__completeNoDesc") return false;

  const response = legacyRespondToComplete(deps.root, deps.argv);
  if (response === undefined) {
    deps.exit(1);
    return true;
  }

  const includeDescriptions = legacyResolveIncludeDescriptions(deps.argv[0], deps.env);
  deps.stdoutWrite(legacyFormatCompletionResponse(response, includeDescriptions));
  deps.exit(0);
  return true;
}

export function legacyDefaultCompleteDeps(root: Command.Command.Any): LegacyCompleteDeps {
  return {
    root,
    argv: process.argv.slice(2),
    env: process.env,
    stdoutWrite: (message) => {
      process.stdout.write(message);
    },
    exit: (code) => {
      process.exit(code);
    },
  };
}
