import { CliConfigSchema, findCliProjectPaths } from "@supabase/config/effect";
import { Data, Effect, FileSystem, Option, Path, Schema } from "effect";
import * as SmolToml from "smol-toml";
import { CommandSettings } from "../config/command-settings.service.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  actionability,
  type CliErrorActionabilityDeclaration,
  ErrorActionabilityId,
} from "../shared/telemetry/error-actionability.ts";
import { yellow } from "./colors.ts";
import { DbConfigLoadError } from "./db-config.errors.ts";
import { loadProjectEnvEntries } from "./db-config.toml-read.ts";
import type { DbConnType, DbTargetSelection } from "./db-target-flags.ts";
import { relativeConfigPath } from "./workdir-project.ts";
import { shouldSearchAncestors } from "./workdir-search.ts";
import { viperEnvStringWithProjectFallback } from "./viper-env.ts";

type WorkspaceTarget = "local" | "remote";

/** Where a resolved target came from: an explicit selector, the workspace setting, or the pre-`target` default. */
type TargetSource = "selector" | "workspace" | "legacy";

export class WorkspaceTargetError extends Data.TaggedError("WorkspaceTargetError")<{
  readonly message: string;
}> {
  get [ErrorActionabilityId](): CliErrorActionabilityDeclaration {
    return actionability.invalidConfig;
  }
}

/** A workspace `target` and the place it was read from (`SUPABASE_TARGET`, a `.env` file, or the config file). */
export interface WorkspaceTargetReading {
  readonly target: WorkspaceTarget;
  readonly origin: string;
}

export interface ResolvedDbTarget extends DbTargetSelection {
  readonly connType: DbConnType;
  readonly source: TargetSource;
  /** Where the workspace target came from; set only when `source` is `"workspace"`. */
  readonly origin: string | undefined;
  /** True when the default is about to flip from linked to the workspace target and nothing pinned it. */
  readonly warn: boolean;
}

const targetConfigSchema = Schema.Struct({ target: CliConfigSchema.fields.target });
const UnknownFromJsonString = Schema.fromJsonString(Schema.Unknown);

const isWorkspaceTarget = (value: string): value is WorkspaceTarget =>
  value === "local" || value === "remote";

export const originFromPath = (workdir: string, filePath: string): string =>
  relativeConfigPath(workdir, filePath).replaceAll("\\", "/");

/**
 * Picks the connection type: explicit selector flag, then a `remote` workspace target (which also
 * lifts `--project-ref` onto the linked project), then `--project-ref` keeping `legacyDefault`,
 * then a `local` workspace target, then `legacyDefault`.
 */
export const selectDbTarget = (input: {
  readonly selection: DbTargetSelection;
  readonly projectRefSet: boolean;
  readonly workspace: WorkspaceTargetReading | undefined;
  readonly legacyDefault: "linked" | "local";
}): ResolvedDbTarget => {
  const { selection, legacyDefault, workspace } = input;
  if (selection.connType !== undefined) {
    return {
      ...selection,
      connType: selection.connType,
      source: "selector",
      origin: undefined,
      warn: false,
    };
  }
  if (workspace?.target === "remote") {
    return {
      ...selection,
      connType: "linked",
      source: "workspace",
      origin: workspace.origin,
      warn: false,
    };
  }
  if (input.projectRefSet) {
    return {
      ...selection,
      connType: legacyDefault,
      source: "selector",
      origin: undefined,
      warn: false,
    };
  }
  if (workspace !== undefined) {
    return {
      ...selection,
      connType: "local",
      source: "workspace",
      origin: workspace.origin,
      warn: false,
    };
  }
  return {
    ...selection,
    connType: legacyDefault,
    source: "legacy",
    origin: undefined,
    warn: legacyDefault === "linked",
  };
};

interface ProjectEnvEntries {
  readonly values: Record<string, string>;
  readonly sources: Record<string, string>;
}

const readEnvTarget = Effect.fnUntraced(function* (projectEnv: ProjectEnvEntries, workdir: string) {
  const raw = yield* viperEnvStringWithProjectFallback("SUPABASE_TARGET", projectEnv.values);
  if (raw === "") return undefined;
  const shellOnly = yield* viperEnvStringWithProjectFallback("SUPABASE_TARGET", {});
  const file = raw === shellOnly ? undefined : projectEnv.sources["SUPABASE_TARGET"];
  const origin = file === undefined ? "SUPABASE_TARGET" : originFromPath(workdir, file);
  if (!isWorkspaceTarget(raw)) {
    return yield* new WorkspaceTargetError({
      message:
        file === undefined
          ? `SUPABASE_TARGET must be "local" or "remote" when set, got "${raw}"`
          : `SUPABASE_TARGET in ${origin} must be "local" or "remote" when set, got "${raw}"`,
    });
  }
  return { target: raw, origin } satisfies WorkspaceTargetReading;
});

const configLoadError = (cause: unknown) =>
  new DbConfigLoadError({
    message: `failed to load config: ${cause instanceof Error ? cause.message : String(cause)}`,
  });

const readConfigTarget = Effect.fnUntraced(function* (settings: {
  readonly workdir: string;
  readonly explicitWorkdir: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const project = yield* findCliProjectPaths(settings.workdir, {
    search: shouldSearchAncestors(settings),
  });
  if (project === null) return undefined;
  const content = yield* fs
    .readFileString(project.configPath)
    .pipe(
      Effect.mapError(
        (error) =>
          new DbConfigLoadError({ message: `failed to read file config: ${error.message}` }),
      ),
    );
  const document = yield* project.configPath.endsWith(".json")
    ? Schema.decodeEffect(UnknownFromJsonString)(content).pipe(Effect.mapError(configLoadError))
    : Effect.try({ try: () => SmolToml.parse(content), catch: configLoadError });
  const decoded = yield* Schema.decodeUnknownEffect(targetConfigSchema)(document).pipe(
    Effect.mapError(
      () =>
        new WorkspaceTargetError({
          message: `target in ${project.configPath} must be "local" or "remote"`,
        }),
    ),
  );
  if (decoded.target === undefined) return undefined;
  return {
    target: decoded.target,
    origin: originFromPath(settings.workdir, project.configPath),
  } satisfies WorkspaceTargetReading;
});

/**
 * Reads the workspace `target` and where it came from: `SUPABASE_TARGET` (shell env, then project
 * `.env*`), then the `target` key of the config file. A missing file is unset; an unreadable or
 * malformed `.env*` file or config fails with `DbConfigLoadError`, an invalid value with
 * `WorkspaceTargetError`.
 */
export const readWorkspaceTarget = Effect.fn("WorkspaceTarget.read")(function* () {
  const settings = yield* CommandSettings;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectEnv = yield* loadProjectEnvEntries(fs, path, settings.workdir);
  const fromEnv = yield* readEnvTarget(projectEnv, settings.workdir);
  if (fromEnv !== undefined) return fromEnv;
  return yield* readConfigTarget(settings);
});

const emitTargetDefaultFlipWarning = (command: string, localLabel = "local database") =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(
      `${yellow(
        `Warning: supabase ${command} will target the ${localLabel} by default in the next major version. Pass --linked to keep targeting the linked project. Setting target = "remote" in your Supabase config (or SUPABASE_TARGET=remote) also works, but applies to every database command that can run locally, including db reset.`,
      )}\n`,
      "stderr",
    );
  });

const emitLinkedTargetProvenance = (origin: string) =>
  Effect.gen(function* () {
    const output = yield* Output;
    yield* output.raw(
      `Targeting the linked project (target = "remote" from ${origin})\n`,
      "stderr",
    );
  });

/** The failure message for a `--password` that a `local` workspace target would drop; `undefined` when it still applies. */
export const passwordDroppedByWorkspaceTarget = (
  target: ResolvedDbTarget,
  password: Option.Option<string>,
): string | undefined =>
  Option.isSome(password) && target.source === "workspace" && target.connType === "local"
    ? `--password only applies when targeting the linked project, but target = "local" is set (${target.origin}); use --linked or set target = "remote"`
    : undefined;

/**
 * Resolves the connection type for a selectable-instance command. On stderr it warns when a linked
 * default is about to flip, and names the source when the workspace target picks the linked
 * project. The workspace target is only read when no selector flag was given.
 */
export const resolveDbTarget = Effect.fn("WorkspaceTarget.resolve")(function* (input: {
  readonly command: string;
  readonly selection: DbTargetSelection;
  readonly projectRefSet: boolean;
  readonly legacyDefault: "linked" | "local";
  readonly localLabel?: string;
}) {
  const workspace =
    input.selection.connType === undefined ? yield* readWorkspaceTarget() : undefined;
  const resolved = selectDbTarget({
    selection: input.selection,
    projectRefSet: input.projectRefSet,
    workspace,
    legacyDefault: input.legacyDefault,
  });
  yield* Effect.annotateCurrentSpan({
    "target.source": resolved.source,
    "target.conn_type": resolved.connType,
  });
  if (resolved.warn) yield* emitTargetDefaultFlipWarning(input.command, input.localLabel);
  if (resolved.origin !== undefined && resolved.connType === "linked") {
    yield* emitLinkedTargetProvenance(resolved.origin);
  }
  return resolved;
});
