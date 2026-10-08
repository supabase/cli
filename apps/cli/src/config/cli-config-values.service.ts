import type { CliConfig, LoadedCliConfig } from "@supabase/config";
import type {
  decodeMergedCliConfig,
  mergeParsedCliConfig,
  parseCliConfigDocumentFile,
} from "@supabase/config/internal";
import type { Effect, Option } from "effect";
import { Context } from "effect";

import type { ProjectRefReadError } from "../shared/config/temp-paths.ts";
import type { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import type { CliConfigFamilyId } from "./cli-config-key-annotations.ts";
import type { CliConfigFlagDeclaration } from "./cli-config-flags.ts";
import type { CliConfigKey, CliConfigKeyOrigin, CliConfigValue } from "./cli-config-key.ts";
import type { CliConfigFlagConflictError, CliConfigValueError } from "./cli-config.errors.ts";

interface CliConfigLoadTarget {
  readonly workdir: string;
  /** The project the command targets, when it has one; it selects the `[remotes.*]` block. */
  readonly projectRef: Option.Option<string>;
  /** Resolves env and defaults only, as if the config file were absent. */
  readonly ignoreConfigFile?: true;
  /** Treats an unreadable `.temp/project-ref` as an unlinked workdir instead of failing the load. */
  readonly tolerateUnreadableLinkedRef?: true;
  /** Leaves an invalid value out of the snapshot and lists it in `invalid`, instead of failing the load. */
  readonly tolerateInvalid?: true;
}

/** An env variable that held a value but was withheld because it belongs to the linked project. */
export interface CliConfigWithheldEnv {
  readonly path: string;
  readonly envName: string;
  readonly tier: "shell" | "projectEnv";
  readonly targetRef: string;
  readonly linkedRef: string;
}

export interface CliConfigMaterialized {
  /** The declared config plus defaults and normalizers. */
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
  | CliConfigFlagConflictError
  | ProjectRefReadError;

export interface CliConfigSnapshot {
  readonly appliedRemote: Option.Option<string>;
  /** Whether a config file was found; without one `loaded` is decoded from the winners alone. */
  readonly hasConfigFile: boolean;
  /** The winning value and its origin. */
  readonly get: <A, X, F extends CliConfigFlagDeclaration>(
    key: CliConfigKey<A, X, F>,
  ) => Effect.Effect<CliConfigValue<A>, CliConfigValueError>;
  /** What the project declares: the document with every flag, env and secret winner written in, before defaults. */
  readonly loaded: LoadedCliConfig;
  /** `loaded` plus defaults and normalizers; the config commands act on. */
  readonly materialized: CliConfigMaterialized;
  /** The origin of every key the registry resolved, by dotted path. */
  readonly origins: ReadonlyMap<string, CliConfigKeyOrigin>;
  /** Values `tolerateInvalid` left out; always empty otherwise. */
  readonly invalid: ReadonlyArray<CliConfigValueError>;
  /** The entry names of a family: those the registry declares plus those in the merged document. */
  readonly familyNames: (family: CliConfigFamilyId) => ReadonlyArray<string>;
  /** Whether the merged document holds a value or table at the dotted path. */
  readonly declares: (path: string) => boolean;
  /** The merged document's raw value at the dotted path, before `env()` resolution. */
  readonly declaredAt: (path: string) => unknown;
  /** Env variables held for the linked project that this target's resolution ignored. */
  readonly withheldEnv: ReadonlyArray<CliConfigWithheldEnv>;
  readonly dotenvPrivateKeys: ReadonlyArray<string>;
  /** Values from `supabase/.env*` files only; a name the shell sets is never in here. */
  readonly projectEnvValues: Readonly<Record<string, string>>;
  /** The non-empty value of each name, shell before project `.env*`; unset and empty names are omitted. */
  readonly envValues: (
    names: Iterable<string>,
  ) => Effect.Effect<Record<string, string>, CliConfigLoadError>;
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
