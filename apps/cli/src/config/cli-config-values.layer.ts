import {
  decodeMergedCliConfig,
  ENV_CAPTURE_REGEX,
  parseMergeCliConfig,
  type MergedCliConfigDocument,
} from "@supabase/config/internal";
import {
  Cache,
  Data,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
} from "effect";

import { readProjectRefFile } from "../command-internal/temp-paths.ts";
import { collectDotenvPrivateKeys, isEncryptedSecret } from "../command-internal/vault-decrypt.ts";
import { Output } from "../shared/output/output.service.ts";
import {
  cloneDocument,
  documentLeafPaths,
  getDocumentValue,
  isDocumentRecord,
  setDocumentValue,
} from "./cli-config-document.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "./cli-config-env.ts";
import { CliConfigFlagInputs } from "./cli-config-flags.ts";
import {
  lookupCliConfigEnv,
  pickCliConfigKey,
  type CliConfigKey,
  type CliConfigKeyOrigin,
  type CliConfigSources,
} from "./cli-config-key.ts";
import { cliConfigFamilyKey, cliConfigRegistry, type AnyCliConfigKey } from "./cli-config-keys.ts";
import { cliConfigRemoteFailure, selectCliConfigRemote } from "./cli-config-remote.ts";
import {
  CliConfigValues,
  type CliConfigMaterialized,
  type CliConfigSnapshot,
  type CliConfigWithheldEnv,
} from "./cli-config-values.service.ts";
import { CliConfigLoadError } from "./cli-config.errors.ts";

const toLoadError = (cause: unknown) =>
  cause instanceof CliConfigLoadError
    ? cause
    : new CliConfigLoadError({ message: `failed to read config: ${String(cause)}` });

class LoadKey extends Data.Class<{
  readonly workdir: string;
  readonly projectRef: Option.Option<string>;
  readonly adHocProjectRef: boolean;
}> {}

const emptyMergedDocument = (workdir: string, separator: string): MergedCliConfigDocument => ({
  path: `${workdir}${separator}supabase${separator}config.toml`,
  format: "toml",
  rawText: "",
  schemaRef: undefined,
  ignoredPaths: [],
  rawDocument: {},
  document: {},
  appliedRemote: undefined,
  remoteLeafPaths: [],
});

export const cliConfigValuesLayer = Layer.effect(
  CliConfigValues,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = yield* Output;
    const flagInputs = yield* CliConfigFlagInputs;
    const warnedAliases = new Set<string>();

    const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const readLinkedRef = (workdir: string) =>
      readProjectRefFile(fs, path, workdir).pipe(
        Effect.mapError((error) => new CliConfigLoadError({ message: error.message })),
      );

    const loadSnapshot = Effect.fn("CliConfigValues.load")(function* (target: LoadKey) {
      const shell = yield* readShellEnvironment();
      const projectEnv = yield* withPlatform(loadCliProjectEnvFiles(target.workdir, { shell }));

      const targetRef = Option.getOrElse(target.projectRef, () => "");
      const linkedRef =
        target.adHocProjectRef === true || Option.isNone(target.projectRef)
          ? Option.none<string>()
          : yield* readLinkedRef(target.workdir);
      const withholdReason: CliConfigWithheldEnv["reason"] | undefined =
        target.adHocProjectRef === true
          ? "adHocProjectRef"
          : Option.isSome(linkedRef) && linkedRef.value !== targetRef
            ? "foreignProjectRef"
            : undefined;
      const scopedKeys = cliConfigRegistry.keys.filter((key) => key.envScope === "linkedTarget");
      const scopedNames = new Set(scopedKeys.flatMap((key) => key.env));
      const withheld = (name: string) => withholdReason !== undefined && scopedNames.has(name);

      const withheldEnv: ReadonlyArray<CliConfigWithheldEnv> =
        withholdReason === undefined
          ? []
          : scopedKeys.flatMap((key) =>
              key.env.flatMap((envName): ReadonlyArray<CliConfigWithheldEnv> => {
                const shellValue = shell.get(envName);
                const fileValue = shellValue === undefined ? projectEnv.values[envName] : undefined;
                const tier = shellValue !== undefined ? "shell" : "projectEnv";
                const held = shellValue ?? fileValue;
                return held === undefined || held === ""
                  ? []
                  : [
                      {
                        path: key.path,
                        envName,
                        tier,
                        reason: withholdReason,
                        targetRef,
                        linkedRef,
                      },
                    ];
              }),
            );

      const shellFor = (name: string) => (withheld(name) ? undefined : shell.get(name));
      const projectEnvFor = (name: string) => {
        const value = projectEnv.values[name];
        if (withheld(name) || value === undefined) return undefined;
        const file = projectEnv.files[name];
        return file === undefined ? { value } : { value, file };
      };
      const lookupEnv = (name: string) =>
        lookupCliConfigEnv({ shell: shellFor, projectEnv: projectEnvFor }, name);

      const merged = yield* withPlatform(
        parseMergeCliConfig(target.workdir, {
          search: false,
          selectRemote: (remotes) => selectCliConfigRemote(remotes, target.projectRef, lookupEnv),
        }),
      ).pipe(Effect.mapError(toLoadError));

      const remotes = merged?.rawDocument?.["remotes"];
      if (isDocumentRecord(remotes)) {
        const failure = cliConfigRemoteFailure(remotes, lookupEnv);
        if (failure !== undefined) return yield* new CliConfigLoadError({ message: failure });
      }

      yield* Effect.annotateCurrentSpan({
        "config.found": merged !== null,
        "config.remote_applied": merged?.appliedRemote !== undefined,
        "config.env_withheld": withholdReason !== undefined,
      });

      const document = merged?.document;
      const remoteLeaves = new Set(merged?.remoteLeafPaths.map((leaf) => leaf.join(".")));
      const localLeaves = documentLeafPaths(merged?.rawDocument ?? {});
      const appliedRemote = merged?.appliedRemote;

      const configAt = (configPath: string) => getDocumentValue(document, configPath);
      const dotenvPrivateKeys = collectDotenvPrivateKeys({
        ...projectEnv.values,
        ...Object.fromEntries(shell),
      });

      const sources: CliConfigSources = {
        flags: (flagPath) => flagInputs.get(flagPath),
        shell: shellFor,
        projectEnv: projectEnvFor,
        config: (configPath) => {
          const value = configAt(configPath);
          if (value === undefined) return undefined;
          const segments = configPath.split(".");
          const referenced =
            typeof value === "string" ? ENV_CAPTURE_REGEX.exec(value)?.[1] : undefined;
          const source: "remote" | "local" =
            remoteLeaves.has(configPath) ||
            (appliedRemote !== undefined && !localLeaves.has(configPath))
              ? "remote"
              : "local";
          const origin =
            referenced !== undefined && lookupEnv(referenced) !== undefined
              ? { path: segments, source: "environment" as const, envVariables: [referenced] }
              : { path: segments, source };
          return {
            value,
            origin,
            ...(source === "remote" && appliedRemote !== undefined
              ? { remote: appliedRemote }
              : {}),
          };
        },
        dotenvPrivateKeys,
        context: { workdir: target.workdir, projectRef: target.projectRef, path, configAt },
      };

      const get: CliConfigSnapshot["get"] = <A, X>(key: CliConfigKey<A, X>) =>
        Effect.gen(function* () {
          const picked = pickCliConfigKey(key, sources);
          if (Result.isFailure(picked)) return yield* picked.failure;
          const deprecated = picked.success.deprecatedEnv;
          if (deprecated !== undefined && !warnedAliases.has(deprecated.used)) {
            warnedAliases.add(deprecated.used);
            yield* output.raw(
              `WARN: ${deprecated.used} is deprecated. Please use ${deprecated.canonical} instead.\n`,
              "stderr",
            );
          }
          return picked.success;
        });

      const envValues = { ...projectEnv.values, ...Object.fromEntries(shell) };

      const materializeEffect = Effect.gen(function* () {
        const working = cloneDocument(document ?? {});
        const draft = isDocumentRecord(working) ? working : {};
        const origins = new Map<string, CliConfigKeyOrigin>();

        const familyKeys = cliConfigRegistry.families.flatMap((family) => {
          const table = getDocumentValue(draft, family.prefix);
          if (!isDocumentRecord(table)) return [];
          return Object.keys(table).flatMap((name) =>
            family.fields.flatMap((field): ReadonlyArray<AnyCliConfigKey> => {
              if (cliConfigRegistry.keyAt(`${family.prefix}.${name}.${field.name}`) !== undefined) {
                return [];
              }
              const key = cliConfigFamilyKey(family, name, field.name);
              return key === undefined ? [] : [key];
            }),
          );
        });

        for (const key of [
          ...cliConfigRegistry.keys.filter((candidate) => candidate.document !== false),
          ...familyKeys,
        ]) {
          const picked = pickCliConfigKey(key, sources);
          if (Result.isFailure(picked)) {
            if (picked.failure.tier === "config") continue;
            return yield* new CliConfigLoadError({ message: picked.failure.message });
          }
          const { value, origin, unnormalized } = picked.success;
          origins.set(key.path, origin);
          const existing = getDocumentValue(draft, key.path);
          const decryptsConfigSecret =
            origin.tier === "config" &&
            key.secret === true &&
            typeof existing === "string" &&
            isEncryptedSecret(existing);
          const writes =
            origin.tier === "flag" ||
            origin.tier === "shell" ||
            origin.tier === "projectEnv" ||
            decryptsConfigSecret ||
            (origin.tier === "default" && key.contextDefault === true);
          if (!writes) continue;
          const written = key.toDocument(unnormalized ?? value);
          if (written !== undefined) setDocumentValue(draft, key.path, written);
        }

        const loaded = yield* withPlatform(
          decodeMergedCliConfig(merged ?? emptyMergedDocument(target.workdir, path.sep), {
            envValues,
            goViperCompat: true,
            document: draft,
          }),
        ).pipe(Effect.mapError(toLoadError));

        const originAt = (configPath: string): CliConfigKeyOrigin => {
          const known = origins.get(configPath);
          if (known !== undefined) return known;
          const decoded = loaded.valueOrigins?.find(
            (candidate) => candidate.path.join(".") === configPath,
          );
          return decoded === undefined
            ? { tier: "default" }
            : {
                tier: "config",
                origin: decoded,
                ...(appliedRemote === undefined ? {} : { remote: appliedRemote }),
              };
        };
        return { config: loaded.config, originAt } satisfies CliConfigMaterialized;
      });

      const materialize = yield* Effect.cached(materializeEffect);

      return {
        appliedRemote: Option.fromNullishOr(appliedRemote),
        sources: { ...sources, withheldEnv },
        get,
        materialize,
        lookupEnv,
        rawDocument: isDocumentRecord(document) ? Option.some(document) : Option.none(),
      } satisfies CliConfigSnapshot;
    });

    const cache = yield* Cache.makeWith(loadSnapshot, {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    });

    return CliConfigValues.of({
      load: (target) =>
        Cache.get(
          cache,
          new LoadKey({
            workdir: target.workdir,
            projectRef: target.projectRef,
            adHocProjectRef: target.adHocProjectRef === true,
          }),
        ),
      writeThrough: (write) => Effect.ensuring(write, Cache.invalidateAll(cache)),
    });
  }),
);
