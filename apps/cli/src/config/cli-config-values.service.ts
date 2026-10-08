import type { CliConfig } from "@supabase/config";
import type { Effect, Option } from "effect";
import { Context } from "effect";

import type {
  CliConfigKey,
  CliConfigKeyOrigin,
  CliConfigSources,
  CliConfigValue,
} from "./cli-config-key.ts";
import type { CliConfigLoadError, CliConfigValueError } from "./cli-config.errors.ts";

interface CliConfigLoadTarget {
  readonly workdir: string;
  /** The project the command targets, when it has one; it selects the `[remotes.*]` block. */
  readonly projectRef: Option.Option<string>;
  /** The ref came from an explicit `--project-ref`/`--project-id` rather than the link file. */
  readonly adHocProjectRef?: boolean;
}

/** An env variable that held a value but was withheld from the target (credential scoping). */
export interface CliConfigWithheldEnv {
  readonly path: string;
  readonly envName: string;
  readonly tier: "shell" | "projectEnv";
  readonly reason: "adHocProjectRef" | "foreignProjectRef";
  readonly targetRef: string;
  readonly linkedRef: Option.Option<string>;
}

interface CliConfigSnapshotSources extends CliConfigSources {
  readonly withheldEnv: ReadonlyArray<CliConfigWithheldEnv>;
}

export interface CliConfigMaterialized {
  /** The decoded config with every key's winning value written in. */
  readonly config: CliConfig;
  readonly originAt: (path: string) => CliConfigKeyOrigin;
}

export interface CliConfigSnapshot {
  readonly appliedRemote: Option.Option<string>;
  readonly sources: CliConfigSnapshotSources;
  readonly get: <A, X>(
    key: CliConfigKey<A, X>,
  ) => Effect.Effect<CliConfigValue<A>, CliConfigValueError>;
  readonly materialize: Effect.Effect<CliConfigMaterialized, CliConfigLoadError>;
  /** A non-empty variable, shell before project `.env*`; `undefined` when unset or empty. */
  readonly lookupEnv: (name: string) => string | undefined;
  /** The merged document before `env()` interpolation and decode; `None` when no config file exists. */
  readonly rawDocument: Option.Option<Record<string, unknown>>;
}

interface CliConfigValuesShape {
  readonly load: (
    target: CliConfigLoadTarget,
  ) => Effect.Effect<CliConfigSnapshot, CliConfigLoadError>;
  /** Runs a write to config or `.temp`, then drops the memoised snapshots it may have staled. */
  readonly writeThrough: <A, E, R>(write: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class CliConfigValues extends Context.Service<CliConfigValues, CliConfigValuesShape>()(
  "supabase/cli/CliConfigValues",
) {}
