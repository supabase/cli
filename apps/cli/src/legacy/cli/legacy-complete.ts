import { Option } from "effect";
import { GlobalFlag } from "effect/unstable/cli";
import type { Command, Param, Primitive } from "effect/unstable/cli";
import process from "node:process";
import {
  LEGACY_QUERY_OUTPUT_FORMATS,
  LEGACY_RESOURCE_OUTPUT_FORMATS,
} from "../shared/legacy-go-output-flag.ts";
import { legacyUnwrapParam } from "../shared/legacy-param-introspection.ts";
import { legacyIsValidBase0Int64, legacyParseUintBase0 } from "../shared/legacy-parse-uint.ts";
import { legacyParseStringSliceFlag } from "../shared/legacy-string-slice-flag.ts";

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
 * command), ordered and grouped the way cobra's own completion path emits
 * flag-name candidates: `InheritedFlags().VisitAll` (every ancestor's global
 * and shared flags, as ONE pflag-alphabetically-sorted block), followed by
 * `NonInheritedFlags().VisitAll` (the resolved command's own global flags,
 * its own `--help`, root's own `--version`, and its own local flags, as a
 * SECOND, separately-sorted block) — pflag's `FlagSet.VisitAll` walks
 * `sortedFormalFlags`, which sorts strictly by each flag's canonical long
 * name (verified empirically against a real `apps/cli-go` build: `db dump -`
 * lists `--agent`, `--create-ticket`, `--debug`, ... alphabetically, THEN a
 * second alphabetical run starting `--data-only`, `--db-url`, `--dry-run`,
 * ... — not one merged alphabetical list and not this tree's own declaration
 * order — CLI-1965 review finding).
 *
 * The resolved command's own local flags win on a canonical-name collision —
 * e.g. a command's own local `--output` (`db diff`'s file-path flag) must
 * shadow the global `--output` choice flag declared at root — by being
 * excluded from the inherited block entirely, mirroring pflag's
 * `InheritedFlags()`, which skips any persistent flag shadowed by a
 * same-named local one (rather than being present in both and "last write
 * wins": a `Map`'s insertion-order position does not move on a same-key
 * `.set()`, so a naive later-overwrite would leave the shadowed entry sitting
 * in the wrong (inherited) sort position instead of removing it).
 */
export function legacyCollectInScopeFlags(
  root: Command.Command.Any,
  commandChain: ReadonlyArray<Command.Command.Any>,
): ReadonlyArray<LegacyFlagDescriptor> {
  const finalCommand = commandChain[commandChain.length - 1] ?? root;
  const ancestors = commandChain.slice(0, -1);

  // `GlobalFlag.Completions`/`GlobalFlag.LogLevel` are TS-only framework
  // additions with no Go/cobra equivalent. They are normally only injected
  // via `GlobalFlag.BuiltIns` at parse time (never stored on a command's own
  // `.globalFlags`), so this filter is a defensive guard rather than
  // something that changes today's output — kept explicit so it stays true
  // if that ever changes.
  const globalFlagParamsOf = (command: Command.Command.Any): ReadonlyArray<Param.AnyFlag> =>
    legacyInternalCommand(command)
      .globalFlags.filter(
        (entry) => entry !== GlobalFlag.Completions && entry !== GlobalFlag.LogLevel,
      )
      .map((entry) => entry.flag);

  const inheritedParams: Array<Param.AnyFlag> = [
    ...ancestors.flatMap(globalFlagParamsOf),
    ...ancestors.flatMap((ancestor) => legacyInternalCommand(ancestor).contextConfig.flags),
  ];
  const ownParams: Array<Param.AnyFlag> = [
    ...globalFlagParamsOf(finalCommand),
    GlobalFlag.Help.flag,
    // Cobra's `InitDefaultVersionFlag` only registers `--version`, and only on
    // the root command (gated on `c.Version != ""`, and non-persistent) — it
    // is never inherited by subcommands the way `--help` is.
    ...(commandChain.length === 1 ? [GlobalFlag.Version.flag] : []),
    ...legacyInternalCommand(finalCommand).config.flags,
  ];

  const descriptorsOf = (
    params: ReadonlyArray<Param.AnyFlag>,
  ): ReadonlyArray<LegacyFlagDescriptor> => {
    const byName = new Map<string, LegacyFlagDescriptor>();
    for (const param of params) {
      const descriptor = legacyFlagDescriptorFromParam(param);
      if (descriptor !== undefined) byName.set(descriptor.name, descriptor);
    }
    return Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  };

  const own = descriptorsOf(ownParams);
  const ownNames = new Set(own.map((descriptor) => descriptor.name));
  const inherited = descriptorsOf(inheritedParams).filter(
    (descriptor) => !ownNames.has(descriptor.name),
  );

  return [...inherited, ...own];
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
 * - A bare `-` is NOT flag-shaped at all — pflag's own `isFlagArg`
 *   (`command.go:750-753`) requires at least 2 characters, so cobra's
 *   `stripFlags` (`command.go:674-706`) silently drops it from its
 *   subcommand-name scan (it matches none of that function's `switch`
 *   cases) without either consuming a value OR stopping the descent, and —
 *   critically — WITHOUT removing it from the leftover args the way a
 *   matched command name is (`argsMinusFirstX` only ever strips the exact
 *   matched name). It therefore must stay in `leftoverArgs` here too, while
 *   still letting the descent continue past it (verified empirically
 *   against a real `apps/cli-go` build: `db - dump --da` still descends
 *   past the bare `-` into `dump` and offers `--data-only`, while `sso -
 *   --debug a` returns zero candidates with the Default directive — the
 *   surviving `-` keeps the `len(finalArgs) == 0` subcommand-listing gate
 *   below closed — CLI-1965 review finding).
 *
 * Descent stops at the first non-flag token that doesn't match a subcommand,
 * or at a `--` sentinel; that token and everything after it becomes
 * `leftoverArgs` — the *positional* leftover cobra's `finalArgs` represents
 * (`completions.go:397-399`), used to gate subcommand-name completion
 * (`len(finalArgs) == 0`). Flag tokens and their consumed values are never
 * part of `leftoverArgs`; a bare `-` is the one exception, per above.
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

    if (token === "-") {
      // Not flag-shaped (pflag's `isFlagArg` requires length >= 2) and never
      // a real subcommand name — skip it without consuming a value, without
      // breaking the descent, and WITHOUT marking it consumed, so it survives
      // into `leftoverArgs` exactly like real cobra's `finalArgs` does. See
      // this function's doc comment for the empirical verification.
      index++;
      continue;
    }

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
 *
 * `legacyClassifyCompletion`'s `--help`/`--version` short-circuit reads THIS
 * set (`changedFlagNames.has("help"/"version")`) rather than scanning raw
 * tokens for a reason beyond DRY: pflag's `boolValue.Set` marks the flag
 * `Changed` on an explicit-value spelling too (`--help=false`), and cobra's
 * `helpOrVersionFlagPresent` (`completions.go:530-537`) checks `.Changed`,
 * not the parsed value — so `--help=false`/`--version=false` short-circuit
 * exactly like a bare `--help`/`--version` (verified empirically against a
 * real `apps/cli-go` build: `--help=false --d` and `--version=false br` both
 * return zero candidates with the NoFileComp directive) — and this
 * function's name-collection above already marks a flag changed on ANY
 * spelling, explicit-value included. A raw token scan misses the terminator-
 * and value-consumption cases this function already handles instead (see
 * `legacyClassifyCompletion`'s call site for the specific repros).
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
 * Whether `trimmedArgs` contains a genuine, unconsumed pflag end-of-flags
 * sentinel — a bare `--` token that is NOT itself the value a preceding
 * value-taking flag already consumed. `--file --` consumes the `--` as
 * `--file`'s string value (`pflag@v1.0.10/flag.go:1013-1023`'s
 * `parseLongArg`, which grabs the very next token unconditionally); pflag's
 * sentinel check only ever inspects the CURRENT token being parsed, never
 * one already claimed as a preceding flag's value, so a consumed `--`
 * never disables later flag completion. A naive `trimmedArgs.includes("--")`
 * treats that consumed token as a terminator too, wrongly shutting off
 * flag-name/flag-value completion for the rest of the request (verified
 * empirically against a real `apps/cli-go` build: `db dump --file -- --s`
 * still offers `--schema`, not zero candidates, while `db dump -- --s` — no
 * preceding value flag to consume the `--` — correctly returns zero
 * candidates — CLI-1965 review finding). Walks the same long/short
 * consumption rules `legacyChangedFlagNames` does, reusing
 * `legacyResolveShortFlagCluster` for the short-flag case.
 */
function legacyHasUnconsumedFlagTerminator(
  trimmedArgs: ReadonlyArray<string>,
  inScopeFlags: ReadonlyArray<LegacyFlagDescriptor>,
): boolean {
  let index = 0;
  while (index < trimmedArgs.length) {
    const token = trimmedArgs[index];
    index++;
    if (token === undefined) continue;
    if (token === "--") return true; // genuine, unconsumed sentinel.

    if (token.startsWith("--")) {
      const rest = token.slice(2);
      const equalsIndex = rest.indexOf("=");
      const name = equalsIndex === -1 ? rest : rest.slice(0, equalsIndex);
      if (equalsIndex === -1 && index < trimmedArgs.length) {
        const owner = inScopeFlags.find((flag) => flag.name === name);
        if (owner !== undefined && !owner.isBoolean) index++; // consumes the next token (possibly `--`) as its value.
      }
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      const cluster = legacyResolveShortFlagCluster(token, inScopeFlags);
      const consumesNextToken =
        cluster !== undefined && !cluster.flag.isBoolean && cluster.attachedValue === undefined;
      if (consumesNextToken && index < trimmedArgs.length) index++;
    }
  }
  return false;
}

/**
 * Go registers `--jobs`/`--last` as `UintVarP`/`UintVar` pflag values
 * (`apps/cli-go/cmd/functions.go:161` — `functions deploy`;
 * `cmd/migration.go:152` — `migration down`; `cmd/db.go:717` — `db reset`;
 * `cmd/storage.go:107` — `storage cp`, the same bug class), which reject a
 * leading `-`/`+` outright (`strconv.ParseUint(s, 0, 64)`) — unlike this TS
 * tree's plain signed `Flag.integer("jobs"/"last")`. `legacyIsValidFlagValue`
 * checks this table BEFORE dispatching on `primitiveTag`, since it must
 * catch `storage cp --jobs` too, which is `Flag.string("jobs")` in TS (its
 * own handler already calls `legacyParseUintBase0` directly at parse time,
 * `cp.command.ts`) rather than `Flag.integer` — a bare `primitiveTag`
 * switch would never see it (verified empirically against a real
 * `apps/cli-go` build: `functions deploy --jobs -1 --p`, `migration down
 * --last -1 --d`, `db reset --last -1 --d`, and `storage cp --jobs -1 --r`
 * all return zero candidates with the Default directive — CLI-1965 review
 * finding). Key = `<matched command path>:<flag name>`, matching
 * `LEGACY_COMPLETION_REQUIRED_FLAGS`'s convention.
 */
const LEGACY_COMPLETION_UINT_FLAGS: ReadonlySet<string> = new Set([
  "functions deploy:jobs",
  "migration down:last",
  "db reset:last",
  "storage cp:jobs",
]);

/**
 * Go registers `--query-timeout` (`gen types`, `cmd/gen.go:161`) and
 * `--valid-for` (`gen bearer-jwt`, `cmd/gen.go:179`) as `DurationVar` pflag
 * values (`time.ParseDuration`), unlike this TS tree's plain
 * `Flag.string("query-timeout"/"valid-for")` — same shape as
 * `LEGACY_COMPLETION_UINT_FLAGS` above, keyed the same way (verified
 * empirically against a real `apps/cli-go` build: `gen types
 * --query-timeout bogus --l` and `gen bearer-jwt --role anon --valid-for
 * bogus --p` both return zero candidates with the Default directive —
 * CLI-1965 review finding).
 */
const LEGACY_COMPLETION_DURATION_FLAGS: ReadonlySet<string> = new Set([
  "gen types:query-timeout",
  "gen bearer-jwt:valid-for",
]);

/**
 * Go registers `--exp` (`gen bearer-jwt`, `cmd/gen.go:178`) as a `TimeVar`
 * pflag value constrained to `time.RFC3339` (`time.Parse(time.RFC3339, s)`),
 * unlike this TS tree's plain `Flag.string("exp")` (verified empirically
 * against a real `apps/cli-go` build: `gen bearer-jwt --role anon --exp
 * bogus --p` returns zero candidates with the Default directive, while
 * `--exp 2024-01-02T15:04:05Z --p` still offers `--profile`/`--payload` —
 * CLI-1965 review finding).
 */
const LEGACY_COMPLETION_RFC3339_FLAGS: ReadonlySet<string> = new Set(["gen bearer-jwt:exp"]);

/**
 * Mirrors Go's `time.ParseDuration` grammar (`time/format.go`): an optional
 * sign, then either the literal `0` alone, or one or more
 * `<number><unit>` terms concatenated (`1h30m`, `1.5h`, `.5s`) — every unit
 * pflag's duration parser accepts: `ns`, `us`/`µs`/`μs`, `ms`, `s`, `m`, `h`.
 * A bare number with no unit (`"5"`), a unit with no leading digits (`"h"`),
 * or anything that fails to fully consume (trailing/leading garbage) is
 * rejected, matching Go's "missing unit"/"invalid duration" errors (verified
 * against go1.26 `time.ParseDuration`: `"300ms"`/`"1.5h"`/`"2h45m"`/
 * `"-1.5h"`/`"0"`/`".5s"` → valid; `"bogus"`/`"5"`/`"0.0"`/`"1_0s"` →
 * invalid).
 *
 * Known residual: Go's accumulator additionally overflows (→ "invalid
 * duration") for a magnitude that, once unit-scaled, exceeds `int64`
 * nanoseconds (e.g. a ~20-digit hour count) — this syntax-only check doesn't
 * reproduce that overflow bound, the same class of residual
 * `legacyParseUintBase0`'s own doc comment already accepts for values above
 * 2^53. Unreachable through any realistic completion input.
 */
const GO_DURATION_PATTERN =
  /^[+-]?(?:0|(?:(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:ns|us|µs|μs|ms|s|m|h))+)$/;

function legacyIsValidGoDuration(value: string): boolean {
  return GO_DURATION_PATTERN.test(value);
}

/**
 * Mirrors Go's `time.Parse(time.RFC3339, s)` — `2006-01-02T15:04:05Z07:00`
 * — exact 4/2/2/2/2/2-digit date-time fields, a literal (case-sensitive) `T`
 * separator, an optional `.`-prefixed fractional-seconds run of any length,
 * and a `Z` or `±HH:MM` offset with NO numeric bound of its own (verified
 * against go1.26 `time.Parse`: `"2024-01-02T15:04:05+24:00"` parses
 * successfully — Go never range-checks the offset). Hour/minute/second are
 * bounded to `0-23`/`0-59`/`0-59` (Go rejects `":60"` — no leap-second
 * allowance — and `"25:"` — verified empirically). Month/day validity
 * (including leap years, and short months like April's 30 days) is checked
 * by round-tripping the parsed year/month/day through `Date#setUTCFullYear`
 * and comparing what comes back — that method (unlike the `Date` constructor
 * or `Date.UTC`) does NOT special-case a 0-99 year into 1900+year, so it
 * stays correct for Go's own accepted `"0000-01-02T15:04:05Z"`, and its
 * normal calendar-overflow behavior (Feb 29 rolling to Mar 1 in a
 * non-leap year, day 32 rolling into the next month, month 13 rolling into
 * the next year) exactly reproduces Go's own leap-year and day/month-bounds
 * rejections without hand-rolling the calendar math.
 */
const GO_RFC3339_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function legacyIsValidGoRfc3339(value: string): boolean {
  const match = GO_RFC3339_PATTERN.exec(value);
  if (match === null) return false;
  const [, year, month, day, hour, minute, second] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;

  const roundTrip = new Date(0);
  roundTrip.setUTCFullYear(y, mo - 1, d);
  return (
    roundTrip.getUTCFullYear() === y &&
    roundTrip.getUTCMonth() === mo - 1 &&
    roundTrip.getUTCDate() === d
  );
}

/**
 * Go registers `--sql-paths` (`db reset`, `cmd/db.go:714`) as a plain
 * `StringArrayVar` — pflag stores each repeated occurrence verbatim, with NO
 * CSV parsing — unlike every OTHER variadic (`isVariadic`) string flag
 * reachable from this tree, which Go declares `StringSliceVar`/
 * `StringSliceVarP` (CSV-split per occurrence): `--domains` (sso
 * add/update), `--schema`/`--exclude` (db dump/diff/pull/lint, gen types, db
 * schema declarative generate/sync), `--config` (postgres-config
 * delete/update), `--db-unban-ip` (network-bans remove), `--db-allow-cidr`
 * (network-restrictions update), and `--exclude`/`--override-name`
 * (start/status). This is the one, small exception — kept as an exclusion
 * set rather than an inclusion table, since the inclusion side is the much
 * longer list. Key = `<matched command path>:<flag name>`.
 */
const LEGACY_COMPLETION_NON_CSV_VARIADIC_FLAGS: ReadonlySet<string> = new Set([
  "db reset:sql-paths",
]);

/**
 * Validates a CSV-per-occurrence (`isVariadic`, pflag `StringSliceVar`)
 * flag's value the same way `legacyParseStringSliceFlag` does at real parse
 * time — reused here directly rather than re-implemented, so the two never
 * drift (verified empirically against a real `apps/cli-go` build: `sso add
 * --domains 'a,"b' --type` — an unterminated quote — returns zero
 * candidates with the Default directive, not `--type` — CLI-1965 review
 * finding).
 */
function legacyIsValidCsvFlagValue(value: string): boolean {
  try {
    legacyParseStringSliceFlag([value]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Go registers `--output`/`-o` as a command-scoped enum: the root persistent
 * flag accepts `env|pretty|json|toml|yaml` (`internal/utils/output.go:30-38`)
 * while `db query`'s own local flag accepts `json|table|csv` (`cmd/db.go:285-
 * 288`) — two value sets that only overlap on `json`, on what this TS tree
 * models as a single global `LegacyOutputFlag` whose `choiceKeys` is the
 * union of both (`legacy-go-output-flag.ts`), so `flag.choiceKeys` alone
 * can't tell which enum applies at the resolved command. This restores Go's
 * per-command validation (verified empirically against a real `apps/cli-go`
 * build: `--output table ""` outside `db query`, and `db query --output env
 * ""`, are BOTH rejected with zero candidates and the Default directive,
 * even though each value is accepted on the OTHER side — CLI-1965 review
 * finding).
 */
function legacyOutputFlagChoiceKeys(matchedPath: ReadonlyArray<string>): ReadonlyArray<string> {
  return matchedPath.length === 2 && matchedPath[0] === "db" && matchedPath[1] === "query"
    ? LEGACY_QUERY_OUTPUT_FORMATS
    : LEGACY_RESOURCE_OUTPUT_FORMATS;
}

/**
 * Validates a flag's value the way pflag's typed `Value.Set` does inside
 * `finalCmd.ParseFlags()` — e.g. `-o not-a-format` (a `Choice`-typed
 * `--output`) or `--debug=maybe` (a `Boolean`-typed `--debug`) fail to parse
 * in real pflag, and cobra reports the parse error instead of generating any
 * completions (verified empirically against a real `apps/cli-go` build: both
 * return zero candidates with the Default directive, exactly like an
 * unresolved flag name). The command-dependent overrides
 * (`LEGACY_COMPLETION_UINT_FLAGS`, `LEGACY_COMPLETION_DURATION_FLAGS`,
 * `LEGACY_COMPLETION_RFC3339_FLAGS`, `LEGACY_COMPLETION_NON_CSV_VARIADIC_FLAGS`)
 * are checked BEFORE the `primitiveTag` dispatch — a bare `LegacyFlagDescriptor`
 * can't express any of them on its own (all need `matchedPath`, and the uint
 * one specifically needs to catch a flag whose TS `primitiveTag` isn't
 * `"Integer"` at all, e.g. `storage cp --jobs`; the duration/RFC3339 ones
 * catch flags that are plain `Flag.string` in TS but a Go `Duration`/`Time`
 * pflag value). Every other primitive shape pflag can actually reject is
 * checked in the switch; `String`/`Path`/`Date`/etc. flags accept any string
 * in Go too, so the default case is unconditionally valid.
 */
function legacyIsValidFlagValue(
  matchedPath: ReadonlyArray<string>,
  flag: LegacyFlagDescriptor,
  value: string,
): boolean {
  const key = `${matchedPath.join(" ")}:${flag.name}`;
  if (LEGACY_COMPLETION_UINT_FLAGS.has(key)) {
    return "value" in legacyParseUintBase0(value);
  }
  if (LEGACY_COMPLETION_DURATION_FLAGS.has(key)) {
    return legacyIsValidGoDuration(value);
  }
  if (LEGACY_COMPLETION_RFC3339_FLAGS.has(key)) {
    return legacyIsValidGoRfc3339(value);
  }
  if (
    flag.isVariadic &&
    flag.primitiveTag === "String" &&
    !LEGACY_COMPLETION_NON_CSV_VARIADIC_FLAGS.has(key)
  ) {
    return legacyIsValidCsvFlagValue(value);
  }
  switch (flag.primitiveTag) {
    case "Boolean":
      return legacyParseGoBool(value) !== undefined;
    case "Choice":
      if (flag.name === "output") {
        return legacyOutputFlagChoiceKeys(matchedPath).includes(value);
      }
      return flag.choiceKeys !== undefined && flag.choiceKeys.includes(value);
    case "Integer":
      return legacyIsValidBase0Int64(value);
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
  matchedPath: ReadonlyArray<string>,
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
        if (!legacyIsValidFlagValue(matchedPath, resolved, token.slice(equalsIndex + 1)))
          return token;
        continue;
      }
      if (resolved.isBoolean) continue;
      if (index >= trimmedArgs.length) {
        if (trailingMissingValueIsFatal) return token;
        continue;
      }
      const value = trimmedArgs[index];
      index++; // skip the consumed value token
      if (value !== undefined && !legacyIsValidFlagValue(matchedPath, resolved, value))
        return value;
      continue;
    }

    const cluster = legacyResolveShortFlagCluster(token, inScopeFlags);
    if (cluster === undefined) return token;
    // An attached value (`-o=json`, or a non-boolean's `-ojson`) must be
    // validated BEFORE the boolean short-circuit below — pflag treats
    // `-f=value` as an explicit value for a boolean shorthand too
    // (`pflag@v1.0.10/flag.go:1005-1033`), so a boolean owner does not, on
    // its own, mean "nothing to validate" (verified empirically against a
    // real `apps/cli-go` build: `storage cp -r=maybe --j` returns zero
    // candidates with the Default directive, not `--jobs` — CLI-1965 review
    // finding).
    if (cluster.attachedValue !== undefined) {
      if (!legacyIsValidFlagValue(matchedPath, cluster.flag, cluster.attachedValue)) return token;
      continue;
    }
    if (cluster.flag.isBoolean) continue;
    if (index >= trimmedArgs.length) {
      if (trailingMissingValueIsFatal) return token;
      continue;
    }
    const value = trimmedArgs[index];
    index++; // skip the consumed value token
    if (value !== undefined && !legacyIsValidFlagValue(matchedPath, cluster.flag, value))
      return value;
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
 * Mirrors cobra's auto-registered `help` command's own `ValidArgsFunction`
 * (`command.go:1263-1310`, `InitDefaultHelpCmd`): `help` is a REAL subcommand
 * of root, and its `ValidArgsFunction` re-resolves everything typed after it
 * from root — via `c.Root().Find(args)` — then lists THAT resolved command's
 * own visible subcommands, filtered by `toComplete`'s prefix. `help db d`
 * therefore completes as if `d` were being completed inside `db` (`diff`,
 * `dump`), not as an argument to `help` itself.
 *
 * Mirrors cobra's `legacyArgs` validator (`args.go:28-37`) for the "unknown
 * command" error `Find` surfaces through `e`: it fires ONLY when the
 * resolved command is root itself (no real descent happened at all) AND a
 * token is left over — a token left over under any OTHER resolved command is
 * never an error there (subcommands "will always accept arbitrary
 * arguments"). On that error path cobra returns zero candidates, but still
 * with the NoFileComp directive, same as the success path (verified
 * empirically against a real `apps/cli-go` build: `help bogus d` -> no
 * candidates; `help db bogus d` -> still `db`'s subcommands, since `db` is
 * not root — CLI-1965 review finding).
 *
 * `root` here is always `finalCommand` from the outer resolution: `help` has
 * no node anywhere in this TS tree (it is a synthesized candidate, not a
 * real `Command.Command.Any` — see the comment where Case 3 pushes it
 * below), so the outer `legacyResolveCommandPath` call always stops at root
 * immediately when `trimmedArgs[0] === "help"`, making `finalCommand` and
 * real cobra's `c.Root()` the same command.
 */
function legacyHelpArgumentCandidates(
  root: Command.Command.Any,
  argsAfterHelp: ReadonlyArray<string>,
  toComplete: string,
): LegacyCompletionResult {
  const { matchedPath, leftoverArgs, commandChain } = legacyResolveCommandPath(root, argsAfterHelp);
  if (matchedPath.length === 0 && leftoverArgs.length > 0) {
    return { candidates: [], directive: LegacyCompletionDirective.NoFileComp };
  }

  const resolved = commandChain[commandChain.length - 1] ?? root;
  const visibleSubcommands = legacyFlattenSubcommands(resolved).filter((sub) => !sub.hidden);
  const candidates: Array<LegacyCompletionCandidate> = visibleSubcommands.map((sub) => ({
    name: sub.name,
    description: sub.shortDescription ?? sub.description,
  }));
  // Cobra's help command is itself one of root's `Commands()`, so re-resolving
  // to root also re-lists `help` (verified empirically: `help h` -> `help`).
  if (matchedPath.length === 0) {
    candidates.push({ name: "help", description: "Help about any command" });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  return {
    candidates: candidates.filter((candidate) => candidate.name.startsWith(toComplete)),
    directive: LegacyCompletionDirective.NoFileComp,
  };
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
 * 0.5. An unmatched ROOT-level positional (`matchedPath.length === 0` — no
 *    real descent happened at all — with a genuine leftover positional token)
 *    ALSO short-circuits to no candidates with the Default directive, and
 *    wins over `--help`/`--version` too — mirrors `Command.Find`'s own
 *    `legacyArgs` validator (`cobra@v1.10.2/args.go:28-37`), which returns
 *    `unknown command %q` precisely when the resolved command is root, has
 *    subcommands (root always does), and has a leftover non-flag positional
 *    — an error `getCompletions` surfaces as zero candidates before doing
 *    anything else with `finalCmd`.
 * 1. `--help`/`-h` anywhere in `trimmedArgs` (or `--version`/`-v`, only when
 *    resolved to the root command) short-circuits to no candidates — these
 *    exit before any real completion runs.
 * 2. A genuine, unconsumed bare `--` anywhere in `trimmedArgs` disables ALL
 *    flag-name and flag-value completion (Cases 3/4 below) for the rest of
 *    this request — mirrors cobra's `flagCompletion` gate, which goes false
 *    the moment a previous `--` is already present (`completions.go:364-
 *    381`; see `legacyHasUnconsumedFlagTerminator` below for why "unconsumed"
 *    matters).
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

  if (
    legacyFindUnresolvedFlagToken(trimmedArgs, toComplete, inScopeFlags, matchedPath) !== undefined
  ) {
    return { candidates: [], directive: LegacyCompletionDirective.Default };
  }

  // Mirrors cobra's `stripFlags` (`command.go:674-710`), which the
  // `legacyArgs` validator below runs its leftover-count check against — a
  // bare `-` (and an empty string) is dropped from consideration, NOT
  // counted as a genuine leftover positional, even though
  // `legacyResolveCommandPath` deliberately leaves a bare `-` IN
  // `leftoverArgs` for other purposes (verified empirically against a real
  // `apps/cli-go` build: `__complete - --d` still offers root's own
  // `--debug`/`--dns-resolver`, since `stripFlags` drops the lone `-` and
  // leaves zero real leftover commands to error on — CLI-1965 review
  // finding, root cause shared with the `nosuch --d` finding below).
  //
  // Exempts `trimmedArgs[0] === "help"`: real cobra's `help` is a REAL child
  // node of root (`InitDefaultHelpCmd`), so `Find(["help", ...])` resolves
  // INTO the help command itself rather than stopping at root — this TS
  // tree has no such node (see `legacyHelpArgumentCandidates`'s doc
  // comment), so the outer resolution below always sees "help" as an
  // immediate non-match and would otherwise misfire this same root-level
  // check for every legitimate `help ...` request. Case 3's own
  // `isAtRoot && trimmedArgs[0] === "help"` branch re-resolves `help`'s own
  // arguments from root separately and already reproduces cobra's real
  // unknown-command handling for THAT inner resolution
  // (`legacyHelpArgumentCandidates`'s `matchedPath.length === 0 &&
  // leftoverArgs.length > 0` check).
  const rootLeftoverPositionals = leftoverArgs.filter((arg) => arg !== "" && !arg.startsWith("-"));
  if (isAtRoot && trimmedArgs[0] !== "help" && rootLeftoverPositionals.length > 0) {
    // Mirrors cobra's `Command.Find` -> `legacyArgs` (`args.go:28-37`):
    // resolving to root itself (no descent at all) with a leftover
    // positional is an "unknown command" error there, unlike a leftover
    // positional under any OTHER resolved command, which is never an error
    // (verified empirically against a real `apps/cli-go` build: `nosuch
    // --d` returns zero candidates with the Default directive — even ahead
    // of the `--help`/`--version` short-circuit below, i.e. `nosuch --help`
    // is ALSO zero candidates, not the help short-circuit's NoFileComp —
    // while `db bogus --d`, where `db` itself resolves, still offers `db`'s
    // own `--debug`/`--dns-resolver` normally — CLI-1965 review finding).
    return { candidates: [], directive: LegacyCompletionDirective.Default };
  }

  // `legacyChangedFlagNames` (not a raw token scan) is load-bearing here: it
  // already stops at a genuine, unconsumed `--` terminator and already skips
  // a token consumed as a PRECEDING non-boolean flag's value — exactly the
  // two cases pflag's own `Changed` tracking respects and a bare
  // `trimmedArgs.some(...)` token scan does not (verified empirically against
  // a real `apps/cli-go` build: `db dump -- --help ""` still offers `db
  // dump`'s own completions, not the help short-circuit — `--help` is
  // positional, past the terminator; `--workdir --version br` still
  // completes `branches`, not the version short-circuit — `--version` is
  // consumed as `--workdir`'s string value, never parsed as a flag at all —
  // CLI-1965 review finding).
  const changedFlagNames = legacyChangedFlagNames(trimmedArgs, inScopeFlags);

  // `version` is gated on `isAtRoot`: cobra's `--version` flag lives on the
  // root command only (see `legacyCollectInScopeFlags`'s comment) — `help` is
  // NOT gated the same way since every command registers its own local
  // `--help` (present in `inScopeFlags`/`changedFlagNames` at every depth).
  if (changedFlagNames.has("help") || (isAtRoot && changedFlagNames.has("version"))) {
    return { candidates: [], directive: LegacyCompletionDirective.NoFileComp };
  }

  const requiredFlags = inScopeFlags.filter(
    (flag) =>
      legacyIsRequiredCompletionFlag(matchedPath, flag.name) && !changedFlagNames.has(flag.name),
  );

  const toCompleteIsFlag = toComplete.startsWith("-");
  const toCompleteEqualsIndex = toComplete.indexOf("=");
  // Once a genuine, unconsumed bare `--` sentinel has already appeared,
  // cobra never does flag-name or flag-value completion again for the rest
  // of the request (verified empirically against a real `apps/cli-go`
  // build: `db dump -- --s` returns zero candidates with the Default
  // directive, not `--schema` — CLI-1965 review finding). See
  // `legacyHasUnconsumedFlagTerminator`'s doc comment for why a raw
  // `trimmedArgs.includes("--")` over-triggers when a preceding value-taking
  // flag consumed that `--` as its own value instead.
  const hasFlagTerminator = legacyHasUnconsumedFlagTerminator(trimmedArgs, inScopeFlags);

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
      // A bare `-` is excluded — pflag's `isFlagArg` (`command.go:750-753`)
      // requires at least 2 characters, so real cobra's own equivalent
      // "preceding token is flag-shaped" check never fires for it either,
      // and this must fall through to Case 3 instead of hard-stopping
      // (verified empirically against a real `apps/cli-go` build: `help db
      // - d` still lists `db`'s subcommands `diff`/`dump`, not zero
      // candidates — CLI-1965 review finding).
      precedingToken !== "-" &&
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

  // `help` is a real cobra subcommand with its own `ValidArgsFunction` that
  // completes a SECOND, independent command-path lookup from root — see
  // `legacyHelpArgumentCandidates`'s doc comment. `isAtRoot &&
  // trimmedArgs[0] === "help"` exactly identifies "this request is `help
  // ...`": `help` isn't a node anywhere in this tree, so the outer
  // `legacyResolveCommandPath` call always stops at root immediately when
  // it's the first token (CLI-1965 review finding).
  if (isAtRoot && trimmedArgs[0] === "help") {
    return legacyHelpArgumentCandidates(finalCommand, trimmedArgs.slice(1), toComplete);
  }

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
