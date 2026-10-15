import type { Option } from "effect";
import { Flag, GlobalFlag } from "effect/cli";

type TargetFlagGroup = "sync" | "selectable";
type TargetSubject = "database" | "Storage API";

interface TargetFlagOptions {
  readonly group: TargetFlagGroup;
  readonly subject: TargetSubject;
}

const localFlag = ({ group, subject }: TargetFlagOptions) =>
  Flag.Boolean("local").pipe(
    Flag.withDescription(
      group === "sync"
        ? `Target the local ${subject}.`
        : `Target the local ${subject}. Default unless the workspace target is "remote".`,
    ),
    Flag.withDefault(false),
  );

const linkedFlag = ({ group }: TargetFlagOptions) =>
  Flag.Boolean("linked").pipe(
    Flag.withDescription(
      group === "sync"
        ? "Target the linked project (default)."
        : 'Target the linked project. Default when the workspace target is "remote".',
    ),
    Flag.withDefault(false),
  );

const dbUrlFlag = () =>
  Flag.String("db-url").pipe(
    Flag.withDescription(
      "Target the database specified by the connection string (must be percent-encoded).",
    ),
    Flag.optional,
  );

const projectRefFlag = () =>
  Flag.String("project-ref").pipe(
    Flag.withDescription("Project ref of the Supabase project. Implies --linked."),
    Flag.optional,
  );

export type TargetFlagsWithDbUrl = {
  readonly local: Flag.Flag<boolean>;
  readonly linked: Flag.Flag<boolean>;
  readonly dbUrl: Flag.Flag<Option.Option<string>>;
  readonly projectRef: Flag.Flag<Option.Option<string>>;
};

export type TargetFlagsWithoutDbUrl = Omit<TargetFlagsWithDbUrl, "dbUrl">;

/** The only declaration of `--local`, `--linked`, `--db-url` and `--project-ref` for sync and selectable commands. */
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
    local: localFlag(options),
    linked: linkedFlag(options),
    projectRef: projectRefFlag(),
  };
  return options.dbUrl ? { ...base, dbUrl: dbUrlFlag() } : base;
}

/**
 * `seed` accepts the selectors before or after its subcommand, which needs scoped globals; they
 * share their definitions with {@link targetFlags}.
 */
export const seedTargetGlobalFlags = {
  linked: GlobalFlag.Setting("linked")({
    flag: linkedFlag({ group: "selectable", subject: "Storage API" }),
  }),
  local: GlobalFlag.Setting("local")({
    flag: localFlag({ group: "selectable", subject: "Storage API" }),
  }),
};

/** Hidden alias of `--project-ref`, accepted only by `gen types`. */
export const deprecatedProjectIdFlag = Flag.String("project-id").pipe(
  Flag.withDescription("Deprecated: use --project-ref."),
  Flag.optional,
  Flag.withHidden,
);
