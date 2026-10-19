import { Effect, Option, Redacted } from "effect";
import { Flag, GlobalFlag, Param, Primitive } from "effect/cli";

import { classifyRemoteValue, LEAVE_OUT_REMOTE_PREFIX, type RemoteValue } from "./remote-value.ts";
import { REMOTE_FLAG_NAME } from "./remote-vocabulary.ts";
import type { ResolvedTarget } from "./resolve-target.ts";
import { remoteFlagText } from "./target-deprecation.ts";

type TargetSubject = "database" | "Storage API";

interface TargetFlagOptions {
  readonly subject: TargetSubject;
}

interface SelectableRemoteFlagVariant<DbUrl extends boolean> {
  readonly kind: "selectable";
  readonly subject: TargetSubject;
  readonly dbUrl: DbUrl;
}

interface HostedRemoteFlagVariant {
  readonly kind: "hosted";
}

type RemoteFlagVariant = SelectableRemoteFlagVariant<boolean> | HostedRemoteFlagVariant;

declare const urlAcceptance: unique symbol;

/** A `--remote` value on a command that takes a database URL; the brand exists only in the type. */
type RemoteValueWithUrl = RemoteValue & { readonly [urlAcceptance]?: "accepted" };

/** A `--remote` value on a command with no database connection; the brand exists only in the type. */
type RemoteValueWithoutUrl = RemoteValue & { readonly [urlAcceptance]?: "rejected" };

const remoteDescription = (variant: RemoteFlagVariant): string => {
  if (variant.kind === "hosted") {
    return "Target another project: --remote=<ref|branch>. Defaults to the linked project.";
  }
  return variant.dbUrl
    ? "Target a remote database: the linked project, or --remote=<ref|branch|url>."
    : `Target a remote ${variant.subject}: the linked project, or --remote=<ref|branch>.`;
};

const leaveOutMessage = (variant: RemoteFlagVariant): string =>
  variant.kind === "hosted"
    ? `${LEAVE_OUT_REMOTE_PREFIX}to use the linked project.`
    : `${LEAVE_OUT_REMOTE_PREFIX}to target the local ${variant.subject}.`;

const REMOTE_PRIMITIVE = Symbol.for("supabase/cli/RemotePrimitive");

/**
 * Keeps the `Boolean` primitive tag so the parser accepts a bare `--remote` and never takes the
 * next token as its value; only `--remote=<value>` (or a boolean literal) reaches `parse`.
 */
const remotePrimitive = (variant: RemoteFlagVariant): Primitive.Primitive<RemoteValue> =>
  Object.assign(Object.create(Primitive.Boolean), {
    [REMOTE_PRIMITIVE]: true,
    parse: (raw: string) => {
      const value = classifyRemoteValue(raw);
      return value === undefined ? Effect.fail(leaveOutMessage(variant)) : Effect.succeed(value);
    },
  });

/** Whether a flag was declared by {@link targetFlags}, {@link projectTargetFlags} or the `seed` globals as `--remote`. */
export const isRemoteFlag = (single: Param.Single<Param.ParamKind, unknown>): boolean =>
  REMOTE_PRIMITIVE in single.primitiveType;

/** `--remote`: the linked project when bare, else the project, branch or database named by its value. */
function remoteFlag(
  variant: SelectableRemoteFlagVariant<true>,
): Flag.Flag<Option.Option<RemoteValueWithUrl>>;
function remoteFlag(
  variant: SelectableRemoteFlagVariant<false>,
): Flag.Flag<Option.Option<RemoteValueWithoutUrl>>;
function remoteFlag(variant: HostedRemoteFlagVariant): Flag.Flag<Option.Option<RemoteValue>>;
function remoteFlag(variant: RemoteFlagVariant): Flag.Flag<Option.Option<RemoteValue>> {
  return Param.makeSingle({
    kind: Param.flagKind,
    name: REMOTE_FLAG_NAME,
    primitiveType: remotePrimitive(variant),
  }).pipe(Flag.withDescription(remoteDescription(variant)), Flag.optional);
}

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

export type TargetFlagsWithDbUrl = {
  readonly remote: Flag.Flag<Option.Option<RemoteValueWithUrl>>;
  readonly local: Flag.Flag<boolean>;
  readonly linked: Flag.Flag<boolean>;
  readonly dbUrl: Flag.Flag<Option.Option<string>>;
  readonly projectRef: Flag.Flag<Option.Option<string>>;
};

export type TargetFlagsWithoutDbUrl = {
  readonly remote: Flag.Flag<Option.Option<RemoteValueWithoutUrl>>;
  readonly local: Flag.Flag<boolean>;
  readonly linked: Flag.Flag<boolean>;
  readonly projectRef: Flag.Flag<Option.Option<string>>;
};

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
}

/** The decoded flags of a command whose `targetFlags` declared `dbUrl: true`. */
export interface TargetFlagValuesWithDbUrl extends TargetFlagValues {
  readonly remote: Option.Option<RemoteValueWithUrl>;
  readonly dbUrl: Option.Option<string>;
}

/** The decoded flags of a command whose `targetFlags` declared `dbUrl: false`. */
export interface TargetFlagValuesWithoutDbUrl extends TargetFlagValues {
  readonly remote: Option.Option<RemoteValueWithoutUrl>;
  readonly dbUrl?: undefined;
}

/** The only declaration of `--remote` and its deprecated `--local`, `--linked`, `--db-url` and `--project-ref` aliases for selectable commands. */
export function targetFlags(
  options: TargetFlagOptions & { readonly dbUrl: true },
): TargetFlagsWithDbUrl;
export function targetFlags(
  options: TargetFlagOptions & { readonly dbUrl: false },
): TargetFlagsWithoutDbUrl;
export function targetFlags(
  options: TargetFlagOptions & { readonly dbUrl: boolean },
): TargetFlagsWithDbUrl | TargetFlagsWithoutDbUrl {
  const base = { local: localFlag(), linked: linkedFlag(), projectRef: projectRefFlag() };
  return options.dbUrl
    ? {
        ...base,
        remote: remoteFlag({ kind: "selectable", subject: options.subject, dbUrl: true }),
        dbUrl: dbUrlFlag(),
      }
    : {
        ...base,
        remote: remoteFlag({ kind: "selectable", subject: options.subject, dbUrl: false }),
      };
}

/** The flags of a hosted-only command: `--remote=<ref|branch>` and the deprecated `--project-ref` alias. */
export const projectTargetFlags = () => ({
  remote: remoteFlag({ kind: "hosted" }),
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

/** The flags that point a suggested follow-up command at `target`; a database URL is never echoed. */
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
};

/** Hidden alias of `--remote=<ref>`, accepted only by `gen types`. */
export const deprecatedProjectIdFlag = Flag.String("project-id").pipe(
  Flag.withDescription("Deprecated, removed in v4: use --remote=<ref>."),
  Flag.optional,
  Flag.withHidden,
);
