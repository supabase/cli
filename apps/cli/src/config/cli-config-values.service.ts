import type { CliConfig, LoadedCliConfig } from "@supabase/config";
import type {
  decodeMergedCliConfig,
  mergeParsedCliConfig,
  parseCliConfigDocumentFile,
} from "@supabase/config/internal";
import type { Effect, Option } from "effect";
import { Context } from "effect";

import type { ProjectRefReadError } from "../shared/config/temp-paths.ts";
import type { CliConfigLoadError } from "../shared/config/cli-config.errors.ts";
import type { CliConfigFamilyId } from "./cli-config-key-annotations.ts";
import type { CliConfigFlagDeclaration } from "./cli-config-flags.ts";
import type {
  CliConfigKey,
  CliConfigKeyOrigin,
  CliConfigSources,
  CliConfigValue,
} from "./cli-config-key.ts";
import type { CliConfigValueError } from "./cli-config.errors.ts";

interface CliConfigLoadTarget {
  readonly workdir: string;
  /** The project the command targets, when it has one; it selects the `[remotes.*]` block. */
  readonly projectRef: Option.Option<string>;
  /** Resolves env and defaults only, as if the config file were absent. */
  readonly ignoreConfigFile?: true;
  /** Treats an unreadable `.temp/project-ref` as an unlinked workdir instead of failing the load. */
  readonly tolerateUnreadableLinkedRef?: true;
}

/** An env variable that held a value but was withheld because it belongs to the linked project. */
export interface CliConfigWithheldEnv {
  readonly path: string;
  readonly envName: string;
  readonly tier: "shell" | "projectEnv";
  readonly targetRef: string;
  readonly linkedRef: string;
}

interface CliConfigSnapshotSources extends CliConfigSources {
  readonly withheldEnv: ReadonlyArray<CliConfigWithheldEnv>;
}

export interface CliConfigMaterialized {
  /** The decoded config with every key's winning value written in. */
  readonly config: CliConfig;
  readonly originAt: (path: string) => CliConfigKeyOrigin;
}

/** What `@supabase/config` can fail with while parsing, merging and decoding the document. */
type CliConfigPackageError =
  | Effect.Error<ReturnType<typeof parseCliConfigDocumentFile>>
  | Effect.Error<ReturnType<typeof mergeParsedCliConfig>>
  | Effect.Error<ReturnType<typeof decodeMergedCliConfig>>;

/** Everything `load` can fail with; package errors keep their own tags. */
type CliConfigLoadFailure =
  | CliConfigPackageError
  | CliConfigLoadError
  | CliConfigValueError
  | ProjectRefReadError;

export interface CliConfigSnapshot {
  readonly appliedRemote: Option.Option<string>;
  readonly sources: CliConfigSnapshotSources;
  /** The winning value and its origin; failures are only possible for keys outside the document. */
  readonly get: <A, X, F extends CliConfigFlagDeclaration>(
    key: CliConfigKey<A, X, F>,
  ) => Effect.Effect<CliConfigValue<A>, CliConfigValueError>;
  /** Decoded once per load; every key's winning value is already applied. */
  readonly materialized: CliConfigMaterialized;
  /** The package's loaded document from the same decode as `materialized`; none when there is no config file. */
  readonly loaded: Option.Option<LoadedCliConfig>;
  /** The entry names of a family: those the registry declares plus those in the merged document. */
  readonly familyNames: (family: CliConfigFamilyId) => ReadonlyArray<string>;
  /**
   * A non-empty variable the registry does not own, shell before project `.env*`; `undefined` when
   * unset or empty. Registry names are read through `get`, so asking for one is a defect.
   */
  readonly lookupEnv: (name: string) => Effect.Effect<string | undefined, CliConfigLoadError>;
}

interface CliConfigValuesShape {
  readonly load: (
    target: CliConfigLoadTarget,
  ) => Effect.Effect<CliConfigSnapshot, CliConfigLoadFailure>;
  /** Runs a write to config or `.temp`, then drops the memoised snapshots it may have staled. */
  readonly writeThrough: <A, E, R>(write: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export class CliConfigValues extends Context.Service<CliConfigValues, CliConfigValuesShape>()(
  "supabase/cli/CliConfigValues",
) {}
