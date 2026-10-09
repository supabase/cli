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

import { readProjectRefFile } from "../shared/config/temp-paths.ts";
import { collectDotenvPrivateKeys } from "../shared/config/vault-decrypt.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { Output } from "../shared/output/output.service.ts";
import { CLI_CONFIG_ENV_ALIAS_NOTES, CLI_CONFIG_FAMILIES } from "./cli-config-key-annotations.ts";
import {
  cloneDocumentRecord,
  collectEnvReferences,
  documentLeafPaths,
  getDocumentValue,
  isDocumentRecord,
  pruneDocumentPaths,
  sameDocumentValue,
  setDocumentValue,
} from "./cli-config-document.ts";
import { CliConfigFlagInputs, cliConfigFlagConflictError } from "./cli-config-flags.ts";
import {
  decodingFailedMessage,
  describeCliConfigOrigin,
  lookupCliConfigEnv,
  pickCliConfigKey,
  type CliConfigKeyOrigin,
  type CliConfigSources,
  type CliConfigValue,
} from "./cli-config-key.ts";
import {
  cliConfigFamilyEnvNames,
  cliConfigFamilyKey,
  cliConfigRegistry,
  cliRemoteProjectIdEnvName,
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
  readonly ignoreConfigFile: boolean;
  readonly tolerateUnreadableLinkedRef: boolean;
  readonly tolerateInvalid: boolean;
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

/** A config-tier value the schema would reject as written: `"TRUE"`, `0` for a bool, `"a,b"` for a list. */
const needsCoercion = (key: AnyCliConfigKey, written: unknown, raw: unknown): boolean =>
  key.codec.kind !== "string" && !sameDocumentValue(written, raw);

/** An `env(NAME)` value is left for the decode to resolve, so its origin stays "from NAME". */
const isEnvReference = (raw: unknown): boolean =>
  typeof raw === "string" && ENV_CAPTURE_REGEX.test(raw);

const declaredWrite = (
  key: AnyCliConfigKey,
  picked: CliConfigValue<unknown>,
  raw: unknown,
): unknown => {
  const written = key.toDocument(picked.unnormalized ?? picked.value);
  switch (picked.origin.tier) {
    case "flag":
    case "shell":
    case "projectEnv":
      return written;
    case "config":
      return key.secret === true || (!isEnvReference(raw) && needsCoercion(key, written, raw))
        ? written
        : undefined;
    case "default":
      return undefined;
  }
};

const materializedWrite = (
  key: AnyCliConfigKey,
  picked: CliConfigValue<unknown>,
  declared: unknown,
): unknown => {
  if (picked.origin.tier === "default") {
    return key.materializeDefault === true || key.normalize !== undefined
      ? key.toDocument(picked.value)
      : undefined;
  }
  return key.normalize === undefined ? declared : key.toDocument(picked.value);
};

const aliasWarning = (used: string, canonical: string): string => {
  const note = CLI_CONFIG_ENV_ALIAS_NOTES[used];
  return `${used} is deprecated; rename it to ${canonical}.${note === undefined ? "" : ` ${note}`}`;
};

export const cliConfigValuesLayer = Layer.effect(
  CliConfigValues,
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const output = yield* Output;
    const flagInputs = yield* CliConfigFlagInputs;
    const debugLogger = yield* Effect.serviceOption(DebugLogger);

    const withPlatform = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );

    const warned = new Set<string>();
    const warnOnce = (message: string) => {
      if (warned.has(message)) return Effect.void;
      warned.add(message);
      return output.warn(message);
    };

    const parsedDocuments = yield* Cache.makeWith(
      (workdir: string) => withPlatform(parseCliConfigDocumentFile(workdir, { search: false })),
      {
        capacity: 8,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );

    const loadSnapshot = Effect.fn("CliConfigValues.load")(function* (target: LoadKey) {
      const [conflict] = flagInputs.conflicts;
      if (conflict !== undefined) return yield* cliConfigFlagConflictError(conflict);

      const parsed = target.ignoreConfigFile
        ? null
        : yield* Cache.get(parsedDocuments, target.workdir);
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
        : target.tolerateUnreadableLinkedRef
          ? yield* readProjectRefFile(fs, path, target.workdir).pipe(
              Effect.orElseSucceed(() => Option.none<string>()),
            )
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
        flags: (flagPath) => flagInputs.assignments.get(flagPath),
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
            ...(merged === null ? {} : { file: merged.path }),
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

      const declaredDraft = cloneDocumentRecord(document);
      const materializedDraft = cloneDocumentRecord(declaredDraft);
      const origins = new Map<string, CliConfigKeyOrigin>();
      const invalid: Array<CliConfigValueError> = [];
      const entryFailures: Array<CliConfigValueError> = [];
      const aliasWarnings: Array<string> = [];
      const overrideWarnings: Array<string> = [];
      for (const key of enumerated.values()) {
        const picked = pickCliConfigKey(key, sources);
        if (Result.isFailure(picked)) {
          if (target.tolerateInvalid) {
            invalid.push(picked.failure);
            pruneDocumentPaths(declaredDraft, [key.path], document);
            pruneDocumentPaths(materializedDraft, [key.path], document);
          } else if (picked.failure.issues === undefined) {
            return yield* picked.failure;
          } else {
            entryFailures.push(picked.failure);
          }
          continue;
        }
        const { origin } = picked.success;
        origins.set(key.path, origin);
        if (origin.tier === "shell" || origin.tier === "projectEnv") {
          const canonical = key.env[0];
          if (canonical !== undefined && origin.envName !== canonical) {
            aliasWarnings.push(aliasWarning(origin.envName, canonical));
          }
          if (appliedRemote !== undefined && remoteLeaves.has(key.path)) {
            overrideWarnings.push(
              `${describeCliConfigOrigin(origin, sources.context)} overrides ${key.path} in [remotes.${appliedRemote}].`,
            );
          }
        }
        const declared = declaredWrite(key, picked.success, sources.config(key.path)?.value);
        if (declared !== undefined) setDocumentValue(declaredDraft, key.path, declared);
        const materialized = materializedWrite(key, picked.success, declared);
        if (materialized !== undefined) setDocumentValue(materializedDraft, key.path, materialized);
      }
      const [firstFailure] = entryFailures;
      if (firstFailure !== undefined) {
        const issues = entryFailures.flatMap((failure) => failure.issues ?? []);
        return yield* new CliConfigValueError({
          path: firstFailure.path,
          tier: "config",
          message: decodingFailedMessage(issues),
          issues,
          ...(firstFailure.source === undefined ? {} : { source: firstFailure.source }),
        });
      }

      const envValues: Record<string, string> = {};
      for (const name of new Set([...Object.keys(projectEnv.values), ...shell.entries().keys()])) {
        const value = lookupEnv(name);
        if (value !== undefined) envValues[name] = value;
      }

      const mergedForDecode = merged ?? emptyMergedDocument(target.workdir, path.sep);
      const loaded = yield* withPlatform(
        decodeMergedCliConfig(mergedForDecode, {
          envValues,
          cliCompat: true,
          document: declaredDraft,
        }),
      );
      const fileDeclared = withPlatform(
        decodeMergedCliConfig(mergedForDecode, { envValues, cliCompat: true, silent: true }),
      );
      const materializedLoaded = yield* withPlatform(
        decodeMergedCliConfig(mergedForDecode, {
          envValues,
          cliCompat: true,
          document: materializedDraft,
          silent: true,
        }),
      );

      const materialized: CliConfigMaterialized = {
        config: materializedLoaded.config,
        originAt: (configPath) => {
          const known = origins.get(configPath);
          if (known !== undefined) return known;
          const decoded = materializedLoaded.valueOrigins?.find(
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

      const get: CliConfigSnapshot["get"] = (key) =>
        Effect.gen(function* () {
          const picked = pickCliConfigKey(key, sources);
          if (Result.isFailure(picked)) return yield* picked.failure;
          return picked.success;
        });

      for (const message of [...aliasWarnings, ...overrideWarnings]) yield* warnOnce(message);
      if (Option.isSome(debugLogger)) {
        for (const [originPath, origin] of origins) {
          if (origin.tier === "default") continue;
          yield* debugLogger.value.debug(
            `config: ${originPath} from ${describeCliConfigOrigin(origin, sources.context)}`,
          );
        }
      }

      return {
        appliedRemote: Option.fromNullishOr(appliedRemote),
        hasConfigFile: merged !== null,
        get,
        loaded,
        fileDeclared,
        materialized,
        origins,
        invalid,
        familyNames,
        declares: (configPath) => configAt(configPath) !== undefined,
        withheldEnv,
        dotenvPrivateKeys,
        projectEnvValues: { ...projectEnv.values },
        envValues: (names) => {
          const wanted = [...new Set(names)];
          return shell.load(wanted).pipe(
            Effect.map(() => {
              const values: Record<string, string> = {};
              for (const name of wanted) {
                const value = lookupEnv(name);
                if (value !== undefined) values[name] = value;
              }
              return values;
            }),
          );
        },
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
            ignoreConfigFile: target.ignoreConfigFile === true,
            tolerateUnreadableLinkedRef: target.tolerateUnreadableLinkedRef === true,
            tolerateInvalid: target.tolerateInvalid === true,
          }),
        ),
      writeThrough: (write) =>
        Effect.ensuring(
          write,
          Effect.all([Cache.invalidateAll(cache), Cache.invalidateAll(parsedDocuments)]),
        ),
    });
  }),
);
