import { Effect, Option, Redacted, Result } from "effect";
import { Flag, GlobalFlag, Param, Primitive } from "effect/cli";

import { parseRemoteValue, type RemoteValue, type RemoteValueRejection } from "./remote-value.ts";
import { REMOTE_FLAG_NAME } from "./remote-vocabulary.ts";
import type { ResolvedTarget } from "./resolve-target.ts";
import { remoteFlagText } from "./target-deprecation.ts";

type TargetSubject = "database" | "Storage API";

interface TargetFlagOptions {
  readonly subject: TargetSubject;
}

interface SelectableRemoteFlagVariant {
  readonly kind: "selectable";
  readonly subject: TargetSubject;
  readonly dbUrl: boolean;
}

interface HostedRemoteFlagVariant {
  readonly kind: "hosted";
  /** A command on a parent project, such as `branches *`: its value is a ref, not a branch name. */
  readonly parent: boolean;
}

type RemoteFlagVariant = SelectableRemoteFlagVariant | HostedRemoteFlagVariant;

const takesDbUrl = (variant: RemoteFlagVariant): boolean =>
  variant.kind === "selectable" && variant.dbUrl;

/** What the variant's `--remote` takes; the help rows, flag description and errors read it. */
const valueHintOf = (variant: RemoteFlagVariant): string => {
  if (variant.kind === "hosted") return variant.parent ? "<ref>" : "<ref|branch>";
  return variant.dbUrl ? "<ref|branch|url>" : "<ref|branch>";
};

const acceptedValuesOf = (variant: RemoteFlagVariant): string => {
  if (variant.kind === "hosted" && variant.parent) return "a project ref";
  const url = takesDbUrl(variant) ? "a postgres:// URL, " : "";
  return `${url}a project ref or a branch name`;
};

const remoteDescription = (variant: RemoteFlagVariant): string => {
  const hint = valueHintOf(variant);
  if (variant.kind === "hosted") {
    return `Target another project: --remote=${hint}. Defaults to the linked project.`;
  }
  return variant.dbUrl
    ? `Target a remote database: the linked project, or --remote=${hint}.`
    : `Target a remote ${variant.subject}: the linked project, or --remote=${hint}.`;
};

const rejectionMessage = (variant: RemoteFlagVariant, rejection: RemoteValueRejection): string => {
  const fallback =
    variant.kind === "hosted" ? "use the linked project" : `target the local ${variant.subject}`;
  switch (rejection._tag) {
    case "Empty":
      return `--remote= has an empty value. Pass --remote for the linked project or --remote=${valueHintOf(variant)}; leave it out to ${fallback}.`;
    case "Off":
      return `--remote doesn't take false. Leave it out to ${fallback}.`;
    case "ForeignUrl":
      return `--remote takes ${acceptedValuesOf(variant)}${
        rejection.ref === undefined
          ? "."
          : `; to target that project, use --remote=${rejection.ref}.`
      }`;
    case "KeywordDsn":
      return `--remote takes ${acceptedValuesOf(variant)}${
        takesDbUrl(variant)
          ? "; convert a connection string to a postgresql:// URL and pass --remote=<url>."
          : "."
      }`;
  }
};

const REMOTE_PRIMITIVE = Symbol.for("supabase/cli/RemotePrimitive");

/**
 * Keeps the `Boolean` primitive tag so the parser accepts a bare `--remote` and never takes the
 * next token as its value; only `--remote=<value>` (or a boolean literal) reaches `parse`. A
 * database URL is rejected here for a command with no database connection.
 */
const remotePrimitive = (variant: RemoteFlagVariant): Primitive.Primitive<RemoteValue> =>
  Object.assign(Object.create(Primitive.Boolean), {
    [REMOTE_PRIMITIVE]: true,
    parse: (raw: string) =>
      Result.match(parseRemoteValue(raw), {
        onFailure: (rejection) => Effect.fail(rejectionMessage(variant, rejection)),
        onSuccess: (value) =>
          value._tag === "DbUrl" && !takesDbUrl(variant)
            ? Effect.fail(`--remote takes ${acceptedValuesOf(variant)}.`)
            : Effect.succeed(value),
      }),
  });

/**
 * Whether a flag was declared by {@link targetFlags}, {@link projectTargetFlags} or the `seed`
 * globals as `--remote`.
 */
export const isRemoteFlag = (single: Param.Single<Param.ParamKind, unknown>): boolean =>
  REMOTE_PRIMITIVE in single.primitiveType;

/** `--remote`: the linked project when bare, else the project, branch or database it names. */
const remoteFlag = (variant: RemoteFlagVariant): Flag.Flag<Option.Option<RemoteValue>> =>
  Param.makeSingle({
    kind: Param.flagKind,
    name: REMOTE_FLAG_NAME,
    primitiveType: remotePrimitive(variant),
    typeName: valueHintOf(variant),
  }).pipe(Flag.withDescription(remoteDescription(variant)), Flag.optional);

const localFlag = () =>
  Flag.Boolean("local").pipe(
    Flag.withDescription(
      "Deprecated, removed in v4: local is the default, so --local is not needed.",
    ),
    Flag.withDefault(false),
    Flag.withHidden,
  );

const linkedFlag = () =>
  Flag.Boolean("linked").pipe(
    Flag.withDescription("Deprecated, removed in v4: use --remote."),
    Flag.withDefault(false),
    Flag.withHidden,
  );

const dbUrlFlag = () =>
  Flag.String("db-url").pipe(
    Flag.withDescription("Deprecated, removed in v4: use --remote=<db-url>."),
    Flag.optional,
    Flag.withHidden,
  );

const projectRefFlag = () =>
  Flag.String("project-ref").pipe(
    Flag.withDescription("Deprecated, removed in v4: use --remote=<ref>."),
    Flag.optional,
    Flag.withHidden,
  );

type TargetFlagDeclarations = {
  readonly remote: Flag.Flag<Option.Option<RemoteValue>>;
  readonly local: Flag.Flag<boolean>;
  readonly linked: Flag.Flag<boolean>;
  readonly projectRef: Flag.Flag<Option.Option<string>>;
};

type DbUrlFlagDeclaration = { readonly dbUrl: Flag.Flag<Option.Option<string>> };

/** The decoded flags every hosted command's selector is read from. */
export interface ProjectTargetFlagValues {
  readonly remote: Option.Option<RemoteValue>;
  readonly projectRef: Option.Option<string>;
}

/** The decoded selector flags of a command that can also act on the local stack. */
export interface TargetFlagValues extends ProjectTargetFlagValues {
  readonly local: boolean;
  readonly linked: boolean;
  /** `gen types` only: the deprecated alias of `--project-ref`. */
  readonly projectId?: Option.Option<string>;
  /** The deprecated `--db-url`; absent on a command with no database connection. */
  readonly dbUrl?: Option.Option<string>;
}

/** The decoded flags of a command whose `targetFlags` declared `dbUrl: true`. */
export interface TargetFlagValuesWithDbUrl extends TargetFlagValues {
  readonly dbUrl: Option.Option<string>;
}

/**
 * The only declaration of `--remote` and its deprecated `--local`, `--linked`, `--db-url` and
 * `--project-ref` aliases for selectable commands.
 */
export function targetFlags(
  options: TargetFlagOptions & { readonly dbUrl: true },
): TargetFlagDeclarations & DbUrlFlagDeclaration;
export function targetFlags(
  options: TargetFlagOptions & { readonly dbUrl: false },
): TargetFlagDeclarations;
export function targetFlags(options: TargetFlagOptions & { readonly dbUrl: boolean }) {
  const base = {
    remote: remoteFlag({ kind: "selectable", subject: options.subject, dbUrl: options.dbUrl }),
    local: localFlag(),
    linked: linkedFlag(),
    projectRef: projectRefFlag(),
  };
  return options.dbUrl ? { ...base, dbUrl: dbUrlFlag() } : base;
}

/**
 * The flags of a hosted-only command: `--remote=<ref|branch>` and the deprecated `--project-ref`
 * alias; `parent` narrows the value to a ref.
 */
export const projectTargetFlags = (options: { readonly parent?: true } = {}) => ({
  remote: remoteFlag({ kind: "hosted", parent: options.parent === true }),
  projectRef: projectRefFlag(),
});

const remoteValueOfTarget = (target: ResolvedTarget): RemoteValue | undefined => {
  switch (target.kind) {
    case "local":
      return undefined;
    case "db-url":
      return { _tag: "DbUrl", url: Redacted.value(target.url) };
    case "linked":
      return target.matchesLinkedRef ? { _tag: "Linked" } : { _tag: "Ref", ref: target.ref };
  }
};

/** The flags that point a suggested follow-up command at `target`; a database URL is not echoed. */
export const flagsForTarget = (target: ResolvedTarget): string => {
  const value = remoteValueOfTarget(target);
  return value === undefined ? "" : remoteFlagText(value);
};

/**
 * `seed` accepts the selectors before or after its subcommand, which needs scoped globals; they
 * share their definitions with {@link targetFlags}.
 */
export const seedTargetGlobalFlags = {
  remote: GlobalFlag.Setting(REMOTE_FLAG_NAME)({
    flag: remoteFlag({ kind: "selectable", subject: "Storage API", dbUrl: false }),
  }),
  linked: GlobalFlag.Setting("linked")({ flag: linkedFlag() }),
  local: GlobalFlag.Setting("local")({ flag: localFlag() }),
  projectRef: GlobalFlag.Setting("project-ref")({ flag: projectRefFlag() }),
};

/** The `seed` selector flags a leaf reads from the group's scoped globals. */
export const readSeedTargetFlags = Effect.fnUntraced(function* () {
  return {
    remote: yield* seedTargetGlobalFlags.remote,
    linked: yield* seedTargetGlobalFlags.linked,
    local: yield* seedTargetGlobalFlags.local,
    projectRef: yield* seedTargetGlobalFlags.projectRef,
  } satisfies TargetFlagValues;
});

/** Hidden alias of `--remote=<ref>`, accepted only by `gen types`. */
export const deprecatedProjectIdFlag = Flag.String("project-id").pipe(
  Flag.withDescription("Deprecated, removed in v4: use --remote=<ref>."),
  Flag.optional,
  Flag.withHidden,
);
