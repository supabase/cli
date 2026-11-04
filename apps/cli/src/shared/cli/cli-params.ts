import { Context, Option } from "effect";
import { Command, Flag, GlobalFlag, Param } from "effect/cli";

/**
 * Reference-docs facts about a flag or argument that `Completions.fromCommand` does not expose.
 * Recorded by the constructors below from the same inputs that build the param, so the published
 * reference cannot drift from parsing.
 */
export interface ParamDocs {
  readonly kind: Param.ParamKind;
  readonly name: string;
  /** Shown as required: parse-required, a variadic with a positive minimum, or `docs.required`. */
  readonly required: boolean;
  /** The default as the reference shows it; absent when it is the value type's zero value. */
  readonly default?: string;
  readonly hidden: boolean;
  /** Present on a repeatable param: the minimum occurrence count. */
  readonly variadicMin?: number;
  readonly metavar?: string;
}

/** Docs-only facts the parser cannot express, such as a default the handler applies. */
interface ParamDocsOverrides {
  readonly default?: string;
  readonly required?: true;
}

const recorded = new WeakMap<Param.Any, ParamDocs>();

/** Records `docs` for a param built by a dedicated constructor, such as a config-key flag. */
export const recordParamDocs = <P extends Param.Any>(param: P, docs: ParamDocs): P => {
  recorded.set(param, docs);
  return param;
};

/** The docs recorded for `param`, or `undefined` when it was not built through this module. */
export const paramDocsOf = (param: Param.Any): ParamDocs | undefined => recorded.get(param);

/** Builds the base param for a name, e.g. `Flag.String`; {@link repeated} makes it variadic. */
export interface ParamType<Kind extends Param.ParamKind, A> {
  (name: string): Param.Param<Kind, A>;
  readonly variadicMin?: number;
}

/** A {@link ParamType} taken repeatedly; its minimum decides whether it is required. */
export interface RepeatedType<Kind extends Param.ParamKind, A> extends ParamType<
  Kind,
  ReadonlyArray<A>
> {
  readonly variadicMin: number;
}

/** `type` accepted any number of times between `options.min` and `options.max`. */
export const repeated = <Kind extends Param.ParamKind, A>(
  type: ParamType<Kind, A>,
  options?: Param.VariadicParamOptions,
): RepeatedType<Kind, A> =>
  Object.assign((name: string) => Param.variadic(type(name), options), {
    variadicMin: options?.min ?? 0,
  });

/** A visible param needs a description; a hidden one may omit it. */
type ParamSpec = (
  | { readonly description: string; readonly hidden?: true }
  | { readonly description?: string; readonly hidden: true }
) & { readonly docs?: ParamDocsOverrides };

type FlagSpec = ParamSpec & {
  readonly alias?: string;
  readonly metavar?: string;
};

type Required = { readonly required: true };
type Optional = { readonly optional: true };
type Defaulted<A> = { readonly default: A };
type Parsed<A, B> = { readonly parse: (flag: Flag.Flag<A>) => Flag.Flag<B> };

interface PresenceInput {
  readonly required?: true;
  readonly optional?: true;
  readonly default?: unknown;
}

const displayDefault = (name: string, value: unknown): string => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.join(",")}]`;
  throw new Error(
    `cli-params.ts: the default of "${name}" has no plain display; set docs.default to document it.`,
  );
};

const docsFor = (
  kind: Param.ParamKind,
  name: string,
  variadicMin: number | undefined,
  spec: ParamSpec & PresenceInput & { readonly metavar?: string },
): ParamDocs => {
  const hasDefault = "default" in spec;
  const isOptional = spec.optional === true || hasDefault;
  const docs: ParamDocs = {
    kind,
    name,
    required:
      spec.docs?.required === true ||
      (!isOptional && (variadicMin === undefined || variadicMin > 0)),
    hidden: spec.hidden === true,
    ...(variadicMin === undefined ? {} : { variadicMin }),
    ...(spec.metavar === undefined ? {} : { metavar: spec.metavar }),
  };
  if (spec.docs?.default !== undefined) return { ...docs, default: spec.docs.default };
  if (!hasDefault) return docs;
  // Formatted when the reference reads it, so an undisplayable default never blocks CLI startup.
  return Object.defineProperty(docs, "default", {
    enumerable: true,
    get: () => displayDefault(name, spec.default),
  });
};

const withPresence = <Kind extends Param.ParamKind>(
  param: Param.Param<Kind, unknown>,
  spec: PresenceInput,
): Param.Param<Kind, unknown> => {
  if (spec.optional === true) return Param.optional(param);
  if ("default" in spec) return Param.withDefault(param, spec.default);
  return param;
};

/**
 * Builds a flag and records its {@link ParamDocs}. Exactly one of `required`, `optional` or
 * `default` states its presence, except on a {@link repeated} type, where the minimum does;
 * `parse` (e.g. `Flag.mapTryCatch(...)`) runs before it.
 */
export function cliFlag<A>(
  name: string,
  type: RepeatedType<"flag", A>,
  spec: FlagSpec,
): Flag.Flag<ReadonlyArray<A>>;
export function cliFlag<A, B>(
  name: string,
  type: RepeatedType<"flag", A>,
  spec: FlagSpec & Parsed<ReadonlyArray<A>, B>,
): Flag.Flag<B>;
export function cliFlag<A>(
  name: string,
  type: ParamType<"flag", A>,
  spec: FlagSpec & Optional,
): Flag.Flag<Option.Option<A>>;
export function cliFlag<A>(
  name: string,
  type: ParamType<"flag", A>,
  spec: FlagSpec & (Required | Defaulted<NoInfer<A>>),
): Flag.Flag<A>;
export function cliFlag<A, B>(
  name: string,
  type: ParamType<"flag", A>,
  spec: FlagSpec & Parsed<A, B> & Optional,
): Flag.Flag<Option.Option<B>>;
export function cliFlag<A, B>(
  name: string,
  type: ParamType<"flag", A>,
  spec: FlagSpec & Parsed<A, B> & (Required | Defaulted<NoInfer<B>>),
): Flag.Flag<B>;
export function cliFlag(
  name: string,
  type: ParamType<"flag", unknown>,
  spec: FlagSpec & PresenceInput & Partial<Parsed<any, unknown>>,
): Flag.Flag<unknown> {
  const base = type(name);
  const described =
    spec.description === undefined ? base : Flag.withDescription(base, spec.description);
  const aliased = spec.alias === undefined ? described : Flag.withAlias(described, spec.alias);
  const shaped = spec.metavar === undefined ? aliased : Flag.withMetavar(aliased, spec.metavar);
  const parsed = spec.parse === undefined ? shaped : spec.parse(shaped);
  const present = withPresence(parsed, spec);
  const flag = spec.hidden === true ? Flag.withHidden(present) : present;
  return recordParamDocs(flag, docsFor(Param.flagKind, name, type.variadicMin, spec));
}

/** Builds a positional argument and records its {@link ParamDocs}; presence as in {@link cliFlag}. */
export function cliArgument<A>(
  name: string,
  type: RepeatedType<"argument", A>,
  spec: ParamSpec,
): Param.Param<"argument", ReadonlyArray<A>>;
export function cliArgument<A>(
  name: string,
  type: ParamType<"argument", A>,
  spec: ParamSpec & Optional,
): Param.Param<"argument", Option.Option<A>>;
export function cliArgument<A>(
  name: string,
  type: ParamType<"argument", A>,
  spec: ParamSpec & (Required | Defaulted<NoInfer<A>>),
): Param.Param<"argument", A>;
export function cliArgument(
  name: string,
  type: ParamType<"argument", unknown>,
  spec: ParamSpec & PresenceInput,
): Param.Param<"argument", unknown> {
  const base = type(name);
  const described =
    spec.description === undefined ? base : Param.withDescription(base, spec.description);
  const present = withPresence(described, spec);
  const argument = spec.hidden === true ? Param.withHidden(present) : present;
  return recordParamDocs(argument, docsFor(Param.argumentKind, name, type.variadicMin, spec));
}

/** The params a command declares in its own config, in declaration order. */
class CommandParams extends Context.Service<CommandParams, ReadonlyArray<Param.Any>>()(
  "supabase/cli/CommandParams",
) {}

/** The flags a command shares with its subcommands through `Command.withSharedFlags`. */
class SharedParams extends Context.Service<SharedParams, ReadonlyArray<Param.AnyFlag>>()(
  "supabase/cli/SharedParams",
) {}

/** The flags of the global settings a command registers. */
class GlobalParams extends Context.Service<GlobalParams, ReadonlyArray<Param.AnyFlag>>()(
  "supabase/cli/GlobalParams",
) {}

const paramsIn = (node: unknown, found: Array<Param.Any> = []): Array<Param.Any> => {
  if (Param.isParam(node)) {
    found.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) paramsIn(child, found);
  } else if (typeof node === "object" && node !== null) {
    for (const child of Object.values(node)) paramsIn(child, found);
  }
  return found;
};

const isFlag = (param: Param.Any): param is Param.AnyFlag => param.kind === Param.flagKind;

/** `Command.make` that also registers the config's params for the reference generator. */
export const makeCommand = <const Name extends string, const Config extends Command.Command.Config>(
  name: Name,
  config: Config,
) => Command.make(name, config).pipe(Command.annotate(CommandParams, paramsIn(config)));

/** `Command.withSharedFlags` that also registers the shared flags. */
export const withSharedParams =
  <const Shared extends Command.Command.FlagConfig>(flags: Shared) =>
  <Name extends string, Input, E, R, ContextInput>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(
      Command.withSharedFlags(flags),
      Command.annotate(SharedParams, paramsIn(flags).filter(isFlag)),
    );

/** `Command.withGlobalFlags` that also registers the settings' flags. */
export const withGlobalParams =
  <const Globals extends ReadonlyArray<GlobalFlag.GlobalFlag<any>>>(globals: Globals) =>
  <Name extends string, Input, E, R, ContextInput>(
    self: Command.Command<Name, Input, ContextInput, E, R>,
  ) =>
    self.pipe(
      Command.withGlobalFlags(globals),
      Command.annotate(
        GlobalParams,
        globals.map((global) => global.flag),
      ),
    );

/** The params registered on `command` by {@link makeCommand}, {@link withSharedParams} and {@link withGlobalParams}. */
export const registeredParams = (command: Command.Command.Any) => ({
  own: Option.getOrElse(Context.getOption(command.annotations, CommandParams), () => []),
  shared: Option.getOrElse(Context.getOption(command.annotations, SharedParams), () => []),
  global: Option.getOrElse(Context.getOption(command.annotations, GlobalParams), () => []),
});
