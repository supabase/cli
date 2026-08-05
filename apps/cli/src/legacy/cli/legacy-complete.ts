import { Option } from "effect";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param } from "effect/unstable/cli";
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
/* Internal command field access (`next/docs/command-docs.ts` precedent)     */
/* ========================================================================== */

/**
 * `.config.flags` (a command's own declared flags), `.contextConfig.flags`
 * (flags inherited via `Command.withSharedFlags`), and `.globalFlags` (a
 * command's own declared global flags) are genuinely absent from the public
 * `Command`/`Command.Any` TypeScript interface — only `name`, `description`,
 * `shortDescription`, `alias`, `examples`, `subcommands`, `annotations`, and
 * `hidden` are public — but they exist at runtime (`internal/command.ts`'s
 * `makeCommand`, via `Object.assign`). Accessed the same way
 * `next/docs/command-docs.ts` already accesses `buildHelpDoc`.
 */
interface LegacyCommandInternal {
  readonly config: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly contextConfig: { readonly flags: ReadonlyArray<Param.AnyFlag> };
  readonly globalFlags: ReadonlyArray<GlobalFlag.GlobalFlag<any>>;
}

function legacyInternalCommand(command: Command.Command.Any): LegacyCommandInternal {
  return command as unknown as LegacyCommandInternal;
}

function legacyFlattenSubcommands(
  command: Command.Command.Any,
): ReadonlyArray<Command.Command.Any> {
  return command.subcommands.flatMap((group) => group.commands);
}

/* ========================================================================== */
/* Flag descriptors                                                          */
/* ========================================================================== */

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
 * value/`=`", i.e. the last character) to its owning in-scope flag.
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
 * case-sensitive — no prefix or fuzzy matching). A flag-shaped token — and,
 * when it's a non-boolean flag with no embedded `=`, the single token
 * immediately following it as its value — is skipped without stopping the
 * descent, mirroring cobra's `Find()`, which strips flags before matching
 * positional command names (`completions.go:340`). Descent stops at the first
 * non-flag token that doesn't match a subcommand; that token and everything
 * after it becomes `leftoverArgs` — the *positional* leftover cobra's
 * `finalArgs` represents (`completions.go:397-399`), used to gate
 * subcommand-name completion (`len(finalArgs) == 0`). Flag tokens and their
 * consumed values are never part of `leftoverArgs`.
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

    if (token.startsWith("-")) {
      consumedIndices.add(index);
      if (!token.includes("=")) {
        // The flags visible at this point of the descent are enough to tell
        // whether this token consumes the next one as its value.
        const inScopeSoFar = legacyCollectInScopeFlags(root, commandChain);
        const resolved = legacyResolveFlagFromToken(token, inScopeSoFar);
        if (resolved !== undefined && !resolved.isBoolean && index + 1 < trimmedArgs.length) {
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
 * already been provided" (not a real flag parser) — correct for the
 * overwhelming majority of real completion inputs.
 */
function legacyChangedFlagNames(
  trimmedArgs: ReadonlyArray<string>,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): ReadonlySet<string> {
  const changed = new Set<string>();
  for (const token of trimmedArgs) {
    if (token.startsWith("--")) {
      const rest = token.slice(2);
      const equalsIndex = rest.indexOf("=");
      const name = equalsIndex === -1 ? rest : rest.slice(0, equalsIndex);
      if (name.length > 0) changed.add(name);
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const equalsIndex = token.indexOf("=");
      const shorthand =
        equalsIndex === -1 ? token.charAt(token.length - 1) : token.charAt(equalsIndex - 1);
      const owner = inScopeFlags.find((flag) => flag.aliases.includes(shorthand));
      if (owner !== undefined) changed.add(owner.name);
    }
  }
  return changed;
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
 * 1. `--help`/`-h` anywhere in `trimmedArgs` (or `--version`/`-v`, only when
 *    resolved to the root command) short-circuits to no candidates — these
 *    exit before any real completion runs.
 * 2. `toComplete` is a bare flag with no `=` → flag-NAME completion.
 * 3. `toComplete` (or the immediately preceding token) identifies a
 *    non-boolean flag's value slot → flag-VALUE completion.
 * 4. Otherwise → subcommand-name + required-flag (noun) completion.
 */
export function legacyClassifyCompletion(
  input: LegacyClassifyCompletionInput,
): LegacyCompletionResult {
  const { finalCommand, matchedPath, leftoverArgs, trimmedArgs, toComplete, inScopeFlags } = input;
  const isAtRoot = matchedPath.length === 0;

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

  // Case 1: flag-NAME completion.
  if (toCompleteIsFlag && toCompleteEqualsIndex === -1) {
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
  if (toCompleteIsFlag) {
    // toCompleteEqualsIndex !== -1 here — the no-`=` branch above returns.
    const resolved = legacyResolveFlagFromToken(
      toComplete.slice(0, toCompleteEqualsIndex),
      inScopeFlags,
    );
    if (resolved === undefined || !resolved.isBoolean) {
      return legacyFlagValueCompletion(matchedPath, resolved?.name);
    }
    // A boolean flag doesn't consume a following value — fall through to
    // Case 3 with the ORIGINAL toComplete/trimmedArgs, unchanged.
  } else {
    const precedingToken = trimmedArgs[trimmedArgs.length - 1];
    if (
      precedingToken !== undefined &&
      precedingToken.startsWith("-") &&
      !precedingToken.includes("=")
    ) {
      const resolved = legacyResolveFlagFromToken(precedingToken, inScopeFlags);
      if (resolved !== undefined && !resolved.isBoolean) {
        return legacyFlagValueCompletion(matchedPath, resolved.name);
      }
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
      for (const sub of visibleSubcommands) {
        if (sub.name.startsWith(toComplete)) {
          candidates.push({ name: sub.name, description: sub.shortDescription ?? sub.description });
        }
      }
    }
  }

  // Unconditional append in cobra — not gated on `leftoverArgs`.
  for (const flag of requiredFlags) {
    candidates.push(...legacyFlagNameCandidates(flag, toComplete));
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
