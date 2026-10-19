import { Effect, Option } from "effect";
import { Flag, GlobalFlag, Param, Primitive } from "effect/cli";

import { classifyRemoteValue, LEAVE_OUT_REMOTE_PREFIX, type RemoteValue } from "./remote-value.ts";
import type { ResolvedTarget } from "./resolve-target.ts";

type TargetSubject = "database" | "Storage API";

interface TargetFlagOptions {
  readonly subject: TargetSubject;
}

type RemoteFlagVariant =
  | { readonly kind: "selectable"; readonly subject: TargetSubject; readonly dbUrl: boolean }
  | { readonly kind: "hosted" };

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

/**
 * Keeps the `Boolean` primitive tag so the parser accepts a bare `--remote` and never takes the
 * next token as its value; only `--remote=<value>` (or a boolean literal) reaches `parse`.
 */
const remotePrimitive = (variant: RemoteFlagVariant): Primitive.Primitive<RemoteValue> =>
  Object.assign(Object.create(Primitive.Boolean), {
    parse: (raw: string) => {
      const value = classifyRemoteValue(raw);
      return value === undefined ? Effect.fail(leaveOutMessage(variant)) : Effect.succeed(value);
    },
  });

/** `--remote`: the linked project when bare, else the project, branch or database named by its value. */
const remoteFlag = (variant: RemoteFlagVariant) =>
  Param.makeSingle({
    kind: Param.flagKind,
    name: "remote",
    primitiveType: remotePrimitive(variant),
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

export type TargetFlagsWithDbUrl = {
  readonly remote: Flag.Flag<Option.Option<RemoteValue>>;
  readonly local: Flag.Flag<boolean>;
  readonly linked: Flag.Flag<boolean>;
  readonly dbUrl: Flag.Flag<Option.Option<string>>;
  readonly projectRef: Flag.Flag<Option.Option<string>>;
};

export type TargetFlagsWithoutDbUrl = Omit<TargetFlagsWithDbUrl, "dbUrl">;

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
  const base = {
    remote: remoteFlag({ kind: "selectable", subject: options.subject, dbUrl: options.dbUrl }),
    local: localFlag(),
    linked: linkedFlag(),
    projectRef: projectRefFlag(),
  };
  return options.dbUrl ? { ...base, dbUrl: dbUrlFlag() } : base;
}

/** The flags of a hosted-only command: `--remote=<ref|branch>` and the deprecated `--project-ref` alias. */
export const projectTargetFlags = () => ({
  remote: remoteFlag({ kind: "hosted" }),
  projectRef: projectRefFlag(),
});

/** The `--remote` value as telemetry records it: a project ref verbatim, a bare `--remote` as `true`, a branch name or database URL redacted. */
export const remoteTelemetryFlag = (
  remote: Option.Option<RemoteValue>,
): Option.Option<string | boolean> =>
  Option.map(remote, (value) => {
    switch (value._tag) {
      case "Linked":
        return true;
      case "Ref":
        return value.ref;
      default:
        return "<redacted>";
    }
  });

/** The flags that point a suggested follow-up command at `target`; a database URL is never echoed. */
export const flagsForTarget = (target: ResolvedTarget): string => {
  switch (target.kind) {
    case "local":
      return "";
    case "db-url":
      return "--remote=<db-url>";
    case "linked":
      return target.matchesLinkedRef ? "--remote" : `--remote=${target.ref}`;
  }
};

/**
 * `seed` accepts the selectors before or after its subcommand, which needs scoped globals; they
 * share their definitions with {@link targetFlags}.
 */
export const seedTargetGlobalFlags = {
  remote: GlobalFlag.Setting("remote")({
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
