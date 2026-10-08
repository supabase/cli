import {
  decodeMergedCliConfig,
  ENV_CAPTURE_REGEX,
  mergeParsedCliConfig,
  parseCliConfigDocumentFile,
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
import { collectDotenvPrivateKeys } from "../command-internal/vault-decrypt.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { CliConfigLoadError } from "../shared/config/cli-config.errors.ts";
import { Output } from "../shared/output/output.service.ts";
import { CLI_CONFIG_FAMILIES } from "./cli-config-key-annotations.ts";
import {
  cloneDocument,
  documentLeafPaths,
  getDocumentValue,
  isDocumentRecord,
  setDocumentValue,
} from "./cli-config-document.ts";
import { CliConfigFlagInputs, type CliConfigFlagDeclaration } from "./cli-config-flags.ts";
import {
  lookupCliConfigEnv,
  pickCliConfigKey,
  type CliConfigKey,
  type CliConfigKeyOrigin,
  type CliConfigSources,
  type CliConfigValue,
} from "./cli-config-key.ts";
import {
  cliConfigDocumentOnlyPaths,
  cliConfigFamilyEnvNames,
  cliConfigFamilyKey,
  cliConfigRegistry,
  cliRemoteProjectIdEnvName,
  isCliConfigEnvName,
  staticCliConfigFamilyNames,
  type AnyCliConfigKey,
} from "./cli-config-keys.ts";
import { cliConfigRemoteFailure, selectCliConfigRemote } from "./cli-config-remote.ts";
import {
  CliConfigValues,
  type CliConfigMaterialized,
  type CliConfigSnapshot,
  type CliConfigWithheldEnv,
} from "./cli-config-values.service.ts";
import { CliConfigValueError } from "./cli-config.errors.ts";

class LoadKey extends Data.Class<{
  readonly workdir: string;
  readonly projectRef: Option.Option<string>;
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

const registryEnvNames = cliConfigRegistry.keys.flatMap((key) => key.env);

const collectEnvReferences = (value: unknown, out: Set<string>): void => {
  if (typeof value === "string") {
    const name = ENV_CAPTURE_REGEX.exec(value)?.[1];
    if (name !== undefined) out.add(name);
  } else if (Array.isArray(value)) {
    for (const item of value) collectEnvReferences(item, out);
  } else if (isDocumentRecord(value)) {
    for (const item of Object.values(value)) collectEnvReferences(item, out);
  }
};

/** The env names the document makes relevant: `env()` references, remote ids and family entries. */
const documentEnvNames = (rawDocument: Record<string, unknown>): ReadonlySet<string> => {
  const names = new Set<string>();
  collectEnvReferences(rawDocument, names);
  const remotes = isDocumentRecord(rawDocument["remotes"]) ? rawDocument["remotes"] : {};
  for (const remote of Object.keys(remotes)) names.add(cliRemoteProjectIdEnvName(remote));
  for (const scope of [rawDocument, ...Object.values(remotes)]) {
    for (const family of CLI_CONFIG_FAMILIES) {
      const table = getDocumentValue(scope, family.prefix);
      if (!isDocumentRecord(table)) continue;
      for (const entry of Object.keys(table)) {
        for (const name of cliConfigFamilyEnvNames(family, entry)) names.add(name);
      }
    }
  }
  return names;
};

const writesToDraft = (key: AnyCliConfigKey, origin: CliConfigKeyOrigin): boolean => {
  switch (origin.tier) {
    case "flag":
    case "shell":
    case "projectEnv":
      return true;
    case "config":
      return key.secret === true || key.normalize !== undefined;
    case "default":
      return key.materializeDefault === true || key.normalize !== undefined;
  }
};

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

    const loadSnapshot = Effect.fn("CliConfigValues.load")(function* (target: LoadKey) {
      const parsed = yield* withPlatform(
        parseCliConfigDocumentFile(target.workdir, { search: false }),
      );
      const rawDocument = parsed?.rawDocument ?? {};

      const shell = yield* readShellEnvironment({
        names: [...registryEnvNames, "DOTENV_PRIVATE_KEY", ...documentEnvNames(rawDocument)],
      });
      const projectEnv = yield* withPlatform(loadCliProjectEnvFiles(target.workdir, { shell }));
      const valueReferences = new Set<string>();
      collectEnvReferences(Object.values(projectEnv.values), valueReferences);
      collectEnvReferences([...shell.entries().values()], valueReferences);
      yield* shell.load(valueReferences);

      const targetRef = Option.getOrElse(target.projectRef, () => "");
      const linkedRef = Option.isNone(target.projectRef)
        ? Option.none<string>()
        : yield* readProjectRefFile(fs, path, target.workdir);
      const foreignLinkedRef = Option.filter(linkedRef, (linked) => linked !== targetRef);
      const scopedKeys = cliConfigRegistry.keys.filter((key) => key.envScope === "linkedTarget");
      const scopedNames = new Set(scopedKeys.flatMap((key) => key.env));
      const withheld = (name: string) => Option.isSome(foreignLinkedRef) && scopedNames.has(name);

      const withheldEnv: ReadonlyArray<CliConfigWithheldEnv> = Option.isNone(foreignLinkedRef)
        ? []
        : scopedKeys.flatMap((key) =>
            key.env.flatMap((envName): ReadonlyArray<CliConfigWithheldEnv> => {
              const shellValue = shell.get(envName);
              const held = shellValue ?? projectEnv.values[envName];
              return held === undefined || held === ""
                ? []
                : [
                    {
                      path: key.path,
                      envName,
                      tier: shellValue === undefined ? "projectEnv" : "shell",
                      targetRef,
                      linkedRef: foreignLinkedRef.value,
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

      const remotes = parsed?.rawDocument?.["remotes"];
      if (isDocumentRecord(remotes)) {
        const failure = cliConfigRemoteFailure(remotes, lookupEnv);
        if (failure !== undefined) return yield* new CliConfigLoadError({ message: failure });
      }

      const merged =
        parsed === null
          ? null
          : yield* mergeParsedCliConfig(parsed, {
              selectRemote: (candidates) =>
                selectCliConfigRemote(candidates, target.projectRef, lookupEnv),
            });

      yield* Effect.annotateCurrentSpan({
        "config.found": merged !== null,
        "config.remote_applied": merged?.appliedRemote !== undefined,
        "config.env_withheld": Option.isSome(foreignLinkedRef),
      });

      const document = merged?.document;
      const remoteLeaves = new Set(merged?.remoteLeafPaths.map((leaf) => leaf.join(".")));
      const localLeaves = documentLeafPaths(merged?.rawDocument ?? {});
      const appliedRemote = merged?.appliedRemote;

      const configAt = (configPath: string) => getDocumentValue(document, configPath);
      const dotenvPrivateKeys = collectDotenvPrivateKeys({
        ...projectEnv.values,
        ...Object.fromEntries(shell.entries()),
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

      const familyNames: CliConfigSnapshot["familyNames"] = (id) => {
        const family = cliConfigRegistry.families.find((candidate) => candidate.id === id);
        if (family === undefined) return [];
        const table = getDocumentValue(document, family.prefix);
        return [
          ...new Set([
            ...staticCliConfigFamilyNames(family),
            ...(isDocumentRecord(table) ? Object.keys(table) : []),
          ]),
        ];
      };

      const enumerated = new Map<string, AnyCliConfigKey>(
        cliConfigRegistry.keys
          .filter((key) => key.document !== false)
          .map((key): [string, AnyCliConfigKey] => [key.path, key]),
      );
      for (const family of cliConfigRegistry.families) {
        for (const entry of familyNames(family.id)) {
          for (const field of family.fields) {
            const key = cliConfigFamilyKey(family, entry, field.name);
            if (key !== undefined) enumerated.set(key.path, key);
          }
        }
      }

      const draftSource = cloneDocument(document ?? {});
      const draft = isDocumentRecord(draftSource) ? draftSource : {};
      const origins = new Map<string, CliConfigKeyOrigin>();
      for (const key of enumerated.values()) {
        const picked = pickCliConfigKey(key, sources);
        if (Result.isFailure(picked)) return yield* picked.failure;
        const { value, origin } = picked.success;
        origins.set(key.path, origin);
        if (!writesToDraft(key, origin)) continue;
        const written = key.toDocument(value);
        if (written !== undefined) setDocumentValue(draft, key.path, written);
      }

      const envValues: Record<string, string> = {};
      for (const name of new Set([...Object.keys(projectEnv.values), ...shell.entries().keys()])) {
        const value = lookupEnv(name);
        if (value !== undefined) envValues[name] = value;
      }

      const loaded = yield* withPlatform(
        decodeMergedCliConfig(merged ?? emptyMergedDocument(target.workdir, path.sep), {
          envValues,
          goViperCompat: true,
          document: draft,
        }),
      );

      const materialized: CliConfigMaterialized = {
        config: loaded.config,
        originAt: (configPath) => {
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
        },
      };

      const decodedValue = <A, X, F extends CliConfigFlagDeclaration>(
        key: CliConfigKey<A, X, F>,
        origin: CliConfigKeyOrigin,
      ): Result.Result<A, CliConfigValueError> => {
        const raw = getDocumentValue(
          cliConfigDocumentOnlyPaths.has(key.path) ? loaded.document : loaded.config,
          key.path,
        );
        if (raw === undefined) return Result.succeed(key.defaultValue(sources.context));
        const decoded = key.codec.fromConfig(raw);
        return decoded === undefined
          ? Result.fail(
              new CliConfigValueError({
                path: key.path,
                tier: origin.tier,
                message: key.codec.describe(key.path, String(raw)),
              }),
            )
          : Result.succeed(key.wrap(decoded));
      };

      const get: CliConfigSnapshot["get"] = <A, X, F extends CliConfigFlagDeclaration>(
        key: CliConfigKey<A, X, F>,
      ) =>
        Effect.gen(function* () {
          const picked = pickCliConfigKey(key, sources);
          if (Result.isFailure(picked)) return yield* picked.failure;
          const decoded = origins.has(key.path)
            ? decodedValue(key, picked.success.origin)
            : Result.succeed(picked.success.value);
          if (Result.isFailure(decoded)) return yield* decoded.failure;
          const deprecated = picked.success.deprecatedEnv;
          if (deprecated !== undefined && !warnedAliases.has(deprecated.used)) {
            warnedAliases.add(deprecated.used);
            yield* output.raw(
              `WARN: ${deprecated.used} is deprecated. Please use ${deprecated.canonical} instead.\n`,
              "stderr",
            );
          }
          return { ...picked.success, value: decoded.success } satisfies CliConfigValue<A>;
        });

      return {
        appliedRemote: Option.fromNullishOr(appliedRemote),
        sources: { ...sources, withheldEnv },
        get,
        materialized,
        familyNames,
        lookupEnv: (name) =>
          isCliConfigEnvName(name)
            ? Effect.die(new Error(`${name} is a config override; read it through its config key`))
            : shell.load([name]).pipe(Effect.map(() => lookupEnv(name))),
      } satisfies CliConfigSnapshot;
    });

    const cache = yield* Cache.makeWith(loadSnapshot, {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    });

    return CliConfigValues.of({
      load: (target) =>
        Cache.get(cache, new LoadKey({ workdir: target.workdir, projectRef: target.projectRef })),
      writeThrough: (write) => Effect.ensuring(write, Cache.invalidateAll(cache)),
    });
  }),
);
