import { CLI_CONFIG_SCHEMA_URL, type CliConfigValueOrigin } from "@supabase/config";
import { CliConfigParseError } from "@supabase/config/effect";
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
  Ref,
  Result,
} from "effect";

import { readLinkSnapshot, readLinkSnapshotSoft } from "../shared/config/link-snapshot.ts";
import { collectDotenvPrivateKeys } from "../shared/config/vault-decrypt.ts";
import { loadCliProjectEnvFiles, readShellEnvironment } from "../shared/config/cli-config-env.ts";
import { CliConfigLoadError } from "../shared/config/cli-config-load.errors.ts";
import { DebugLogger } from "../shared/output/debug-logger.service.ts";
import { escapeControlCharacters } from "../shared/output/escape-control-characters.ts";
import { Output } from "../shared/output/output.service.ts";
import { PropConfigKey } from "../shared/telemetry/event-catalog.ts";
import { recordCommandTelemetry } from "../telemetry/command-telemetry-attributes.ts";
import { CLI_CONFIG_FAMILIES, CLI_CONFIG_REMOVED_ENV_NAMES } from "./cli-config-key-annotations.ts";
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
import { MAX_PRUNE_ROUNDS } from "./cli-config-validation.ts";
import { cliConfigFailureKey } from "./cli-config-failure-key.ts";
import { CliConfigFlagInputs, cliConfigFlagConflictError } from "./cli-config-flags.ts";
import {
  decodingFailedMessage,
  describeCliConfigEnvLocation,
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
import { reportableUnknownCliConfigKeys } from "./cli-config-unknown-keys.ts";
import { flattenSchemaIssues } from "./cli-config-schema-issues.ts";
import { cliConfigRemoteFailures, selectCliConfigRemote } from "./cli-config-remote.ts";
import {
  CliConfigValues,
  type CliConfigMaterialized,
  type ResolvedCliConfig,
  type CliConfigWithheldEnv,
} from "./cli-config-values.service.ts";
import { CliConfigRemovedEnvError, CliConfigValueError } from "./cli-config.errors.ts";

class LoadKey extends Data.Class<{
  readonly workdir: string;
  readonly projectRef: Option.Option<string>;
  readonly ignoreConfigFile: boolean;
  readonly tolerateUnreadableLinkedRef: boolean;
  readonly tolerateInvalid: boolean;
  readonly validation: boolean;
  readonly remoteName: string | undefined;
}> {}

const emptyMergedDocument = (workdir: string, separator: string): MergedCliConfigDocument => ({
  path: `${workdir}${separator}supabase${separator}config.toml`,
  format: "toml",
  rawText: "",
  schemaRef: undefined,
  ignoredPaths: [],
  deprecatedPaths: [],
  rawDocument: {},
  document: {},
  appliedRemote: undefined,
  remoteLeafPaths: [],
});

const deprecatedKeyLine = (deprecatedPath: string): string => {
  const shown = escapeControlCharacters(deprecatedPath);
  return `WARN: ${shown} is deprecated and will be removed in v4, use ${shown.replace(/enable_signup$/, "enabled")} instead.\n`;
};

const unrecognizedSchemaLine = (file: string, ref: string): string =>
  `WARN: ${file} declares schema ${escapeControlCharacters(ref)}, which is not the Supabase CLI config schema, so it is read as v1. Set it to ${CLI_CONFIG_SCHEMA_URL} to remove this warning.\n`;

const unknownKeysLine = (file: string, keys: ReadonlyArray<string>): string =>
  `WARN: ${file} has keys this version of the Supabase CLI does not recognize and ignores: ${keys.map(escapeControlCharacters).join(", ")}. Check them for typos, remove keys older CLI versions used, or upgrade the CLI if they come from a newer version.\n`;

const registryEnvNames = cliConfigRegistry.keys.flatMap((key) => key.env);

/** The env names the document makes relevant: `env()` references, remote ids and family entries. */
const documentEnvNames = (rawDocument: Record<string, unknown>): ReadonlySet<string> => {
  const names = new Set<string>();
  collectEnvReferences(rawDocument, names);
  const remotes = isDocumentRecord(rawDocument["remotes"]) ? rawDocument["remotes"] : {};
  for (const remote of Object.keys(remotes)) names.add(cliRemoteProjectIdEnvName(remote));
  for (const scope of [rawDocument, ...Object.values(remotes)]) {
    for (const family of CLI_CONFIG_FAMILIES) {
      const table = getDocumentValue(scope, family.prefix.split("."));
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

/** An `env(NAME)` value, or a list holding one. */
const isEnvReference = (raw: unknown): boolean =>
  Array.isArray(raw)
    ? raw.some(isEnvReference)
    : typeof raw === "string" && ENV_CAPTURE_REGEX.test(raw);

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
      return key.secret === true || isEnvReference(raw) || needsCoercion(key, written, raw)
        ? written
        : undefined;
    case "default":
      return undefined;
  }
};

/** The coerced config-tier value a file-only view needs, or `undefined` when the file value decodes as written. */
const fileWrite = (key: AnyCliConfigKey, sources: CliConfigSources): unknown => {
  const raw = sources.config(key.segments)?.value;
  if (raw === undefined || key.secret === true) return undefined;
  const picked = pickCliConfigKey(key, sources, { configOnly: true });
  if (Result.isFailure(picked) || picked.success.origin.tier !== "config") return undefined;
  const written = key.toDocument(picked.success.unnormalized ?? picked.success.value);
  return isEnvReference(raw) || needsCoercion(key, written, raw) ? written : undefined;
};

/** The origin the decode would record for a resolved `env()` reference, which a pre-resolved path no longer gets. */
const envOrigin = (
  key: AnyCliConfigKey,
  raw: unknown,
  lookup: (name: string) => string | undefined,
): CliConfigValueOrigin | undefined => {
  const names = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : [raw]) {
    const name = typeof item === "string" ? ENV_CAPTURE_REGEX.exec(item)?.[1] : undefined;
    if (name !== undefined && lookup(name) !== undefined) names.add(name);
  }
  return names.size === 0
    ? undefined
    : { path: [...key.segments], source: "environment", envVariables: [...names] };
};

const withEnvOrigins = <T extends { readonly valueOrigins?: ReadonlyArray<CliConfigValueOrigin> }>(
  loaded: T,
  injected: ReadonlyArray<CliConfigValueOrigin>,
): T =>
  injected.length === 0
    ? loaded
    : {
        ...loaded,
        valueOrigins: loaded.valueOrigins?.map(
          (origin) => injected.find((env) => sameDocumentValue(env.path, origin.path)) ?? origin,
        ),
      };

const withoutRemotes = (document: Record<string, unknown>): Record<string, unknown> => {
  const { remotes: _remotes, ...rest } = document;
  return rest;
};

/** The path to delete so a decode issue at `path` stops recurring: the key itself, the array holding it, or the deepest table that exists above an absent key. */
const prunableSegments = (
  draft: Record<string, unknown>,
  path: ReadonlyArray<string>,
  missingKey: boolean,
): ReadonlyArray<string> => {
  const target = missingKey ? path.slice(0, -1) : path;
  let node: unknown = draft;
  const kept: Array<string> = [];
  for (const segment of target) {
    if (!isDocumentRecord(node)) break;
    if (!Object.hasOwn(node, segment)) break;
    kept.push(segment);
    node = node[segment];
  }
  return kept;
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
    const printOnce = (line: string) => {
      if (warned.has(line)) return Effect.void;
      warned.add(line);
      return output.raw(line, "stderr");
    };

    // The latest config load or lookup decides `config_key`, so a recovered failure cannot label
    // a later one; only changes are recorded.
    const recordedFailureKey = yield* Ref.make<string | undefined>(undefined);
    const settleFailureKey = (key: string | undefined) =>
      Ref.getAndSet(recordedFailureKey, key).pipe(
        Effect.flatMap((previous) =>
          previous === key ? Effect.void : recordCommandTelemetry({ [PropConfigKey]: key }),
        ),
      );
    const tracksConfigFailureKey = <A, E, R>(self: Effect.Effect<A, E, R>) =>
      self.pipe(
        Effect.tapError((error) => settleFailureKey(cliConfigFailureKey(error))),
        Effect.tap(() => settleFailureKey(undefined)),
      );

    const parsedDocuments = yield* Cache.makeWith(
      (workdir: string) => withPlatform(parseCliConfigDocumentFile(workdir, { search: false })),
      {
        capacity: 8,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );

    const validationParsedDocuments = yield* Cache.makeWith(
      (workdir: string) =>
        withPlatform(
          parseCliConfigDocumentFile(workdir, { search: false, tolerateRemovedKeys: true }),
        ),
      {
        capacity: 8,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
      },
    );

    const loadResolvedConfig = Effect.fn("CliConfigValues.load")(function* (target: LoadKey) {
      const [conflict] = flagInputs.conflicts;
      if (conflict !== undefined) return yield* cliConfigFlagConflictError(conflict);

      const parsed = target.ignoreConfigFile
        ? null
        : yield* Cache.get(
            target.validation ? validationParsedDocuments : parsedDocuments,
            target.workdir,
          );
      const notices = !target.validation;
      for (const deprecatedPath of notices ? (parsed?.deprecatedPaths ?? []) : []) {
        yield* printOnce(deprecatedKeyLine(deprecatedPath));
      }
      if (parsed !== null && notices) {
        const displayPath = (filePath: string) =>
          path.relative(target.workdir, filePath).replaceAll("\\", "/");
        const used = displayPath(parsed.path);
        const declaration = parsed.schemaDeclaration;
        if (declaration !== undefined && declaration.version === undefined) {
          yield* printOnce(unrecognizedSchemaLine(used, declaration.ref));
        }
        const unknownKeys = reportableUnknownCliConfigKeys(parsed.rawDocument).map(
          ({ path: key }) => key.join("."),
        );
        if (unknownKeys.length > 0) {
          yield* printOnce(unknownKeysLine(used, unknownKeys));
        }
        for (const ignoredPath of parsed.ignoredPaths) {
          const ignored = displayPath(ignoredPath);
          yield* warnOnce(
            `Ignoring ${ignored} because ${used} takes precedence. Delete the file you don't use.`,
          );
        }
      }
      const rawDocument = parsed?.rawDocument ?? {};

      const shell = yield* readShellEnvironment({
        names: [
          ...registryEnvNames,
          ...Object.keys(CLI_CONFIG_REMOVED_ENV_NAMES),
          "DOTENV_PRIVATE_KEY",
          ...documentEnvNames(rawDocument),
        ],
        namesWithPrefix: ["DOTENV_PRIVATE_KEY"],
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
          ? (yield* readLinkSnapshotSoft(fs, path, target.workdir)).ref
          : (yield* readLinkSnapshot(fs, path, target.workdir)).ref;
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

      for (const [envName, { replacement }] of Object.entries(CLI_CONFIG_REMOVED_ENV_NAMES)) {
        if (lookupEnv(envName) === undefined) continue;
        return yield* new CliConfigRemovedEnvError({
          envName,
          replacement,
          location: describeCliConfigEnvLocation(
            { shell: shellFor, projectEnv: projectEnvFor },
            { workdir: target.workdir, path },
            envName,
          ),
        });
      }

      const remotes = parsed?.rawDocument?.["remotes"];
      const remoteFailures = isDocumentRecord(remotes)
        ? cliConfigRemoteFailures(remotes, lookupEnv)
        : [];
      const [firstRemoteFailure] = remoteFailures;
      if (firstRemoteFailure !== undefined && !target.validation) {
        return yield* new CliConfigLoadError({
          message: firstRemoteFailure.message,
          remote: firstRemoteFailure.remote,
        });
      }

      const merged =
        parsed === null
          ? null
          : yield* mergeParsedCliConfig(parsed, {
              selectRemote: (candidates) =>
                target.remoteName ??
                selectCliConfigRemote(candidates, target.projectRef, lookupEnv),
            });

      yield* Effect.annotateCurrentSpan({
        "config.found": merged !== null,
        "config.remote_applied": merged?.appliedRemote !== undefined,
        "config.env_withheld": Option.isSome(foreignLinkedRef),
      });

      const document =
        target.validation &&
        merged?.appliedRemote === undefined &&
        isDocumentRecord(merged?.document)
          ? withoutRemotes(merged.document)
          : merged?.document;
      const remoteLeaves = new Set(merged?.remoteLeafPaths.map((leaf) => leaf.join(".")));
      const localLeaves = documentLeafPaths(merged?.rawDocument ?? {});
      const appliedRemote = merged?.appliedRemote;

      const configAtSegments = (segments: ReadonlyArray<string>) =>
        getDocumentValue(document, segments);
      const configAt = (configPath: string) => configAtSegments(configPath.split("."));
      const dotenvPrivateKeys = collectDotenvPrivateKeys({
        ...projectEnv.values,
        ...Object.fromEntries(shell.entries()),
      });

      const sources: CliConfigSources = {
        flags: (flagPath) => flagInputs.assignments.get(flagPath),
        shell: shellFor,
        projectEnv: projectEnvFor,
        config: (segments) => {
          const value = configAtSegments(segments);
          if (value === undefined) return undefined;
          const configPath = segments.join(".");
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

      const familyNames: ResolvedCliConfig["familyNames"] = (id) => {
        const family = cliConfigRegistry.families.find((candidate) => candidate.id === id);
        if (family === undefined) return [];
        const table = getDocumentValue(document, family.prefix.split("."));
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
      const fileDraft = cloneDocumentRecord(document);
      const origins = new Map<string, CliConfigKeyOrigin>();
      const invalid: Array<CliConfigValueError> = [];
      const entryFailures: Array<CliConfigValueError> = [];
      const overrideWarnings: Array<string> = [];
      const declaredResolved: Array<ReadonlyArray<string>> = [];
      const materializedResolved: Array<ReadonlyArray<string>> = [];
      const fileResolved: Array<ReadonlyArray<string>> = [];
      const declaredEnvOrigins: Array<CliConfigValueOrigin> = [];
      const materializedEnvOrigins: Array<CliConfigValueOrigin> = [];
      const fileEnvOrigins: Array<CliConfigValueOrigin> = [];
      for (const key of enumerated.values()) {
        const raw = sources.config(key.segments)?.value;
        const configOrigin = envOrigin(key, raw, lookupEnv);
        const fileValue = fileWrite(key, sources);
        if (fileValue !== undefined) {
          setDocumentValue(fileDraft, key.segments, fileValue);
          fileResolved.push(key.segments);
          if (configOrigin !== undefined) fileEnvOrigins.push(configOrigin);
        }
        const picked = pickCliConfigKey(key, sources);
        if (Result.isFailure(picked)) {
          if (target.tolerateInvalid) {
            invalid.push(picked.failure);
            pruneDocumentPaths(declaredDraft, [key.segments], document);
            pruneDocumentPaths(materializedDraft, [key.segments], document);
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
          if (appliedRemote !== undefined && remoteLeaves.has(key.path)) {
            overrideWarnings.push(
              `${describeCliConfigOrigin(origin, sources.context)} overrides ${key.path} in [remotes.${appliedRemote}].`,
            );
          }
        }
        const fromConfig = origin.tier === "config" ? configOrigin : undefined;
        const declared = declaredWrite(key, picked.success, raw);
        if (declared !== undefined) {
          setDocumentValue(declaredDraft, key.segments, declared);
          declaredResolved.push(key.segments);
          if (fromConfig !== undefined) declaredEnvOrigins.push(fromConfig);
        }
        const materialized = materializedWrite(key, picked.success, declared);
        if (materialized !== undefined) {
          setDocumentValue(materializedDraft, key.segments, materialized);
          materializedResolved.push(key.segments);
          if (fromConfig !== undefined) materializedEnvOrigins.push(fromConfig);
        }
      }
      const [firstFailure] = entryFailures;
      if (firstFailure !== undefined) {
        const issues = entryFailures.flatMap((failure) => failure.issues ?? []);
        return yield* new CliConfigValueError({
          path: firstFailure.path,
          ...(entryFailures.length === 1 && firstFailure.segments !== undefined
            ? { segments: firstFailure.segments }
            : {}),
          tier: "config",
          message: decodingFailedMessage(issues),
          issues,
          ...(firstFailure.source === undefined ? {} : { source: firstFailure.source }),
        });
      }

      const envValues: Record<string, string> = Object.create(null);
      for (const name of new Set([...Object.keys(projectEnv.values), ...shell.entries().keys()])) {
        const value = lookupEnv(name);
        if (value !== undefined) envValues[name] = value;
      }

      const allIssues = target.validation ? ({ allIssues: true } as const) : {};
      const mergedForDecode = merged ?? emptyMergedDocument(target.workdir, path.sep);
      const schemaFailures: Array<CliConfigParseError> = [];
      const pruned: Array<ReadonlyArray<string>> = [];
      let pruneLimitReached = false;
      const decode = (
        draft: Record<string, unknown>,
        resolvedPaths: ReadonlyArray<ReadonlyArray<string>>,
        reportFailures: boolean,
      ) =>
        Effect.gen(function* () {
          let cleared = false;
          for (let round = 0; ; round++) {
            const result = yield* withPlatform(
              decodeMergedCliConfig(mergedForDecode, {
                envValues,
                cliCompat: true,
                document: draft,
                resolvedPaths,
                ...allIssues,
              }),
            ).pipe(Effect.result);
            if (Result.isSuccess(result)) return result.success;
            const error = result.failure;
            if (!target.validation || !(error instanceof CliConfigParseError) || cleared) {
              return yield* error;
            }
            if (round >= MAX_PRUNE_ROUNDS) {
              if (reportFailures) schemaFailures.push(error);
              pruneLimitReached = true;
              cleared = true;
              for (const key of Object.keys(draft)) delete draft[key];
              continue;
            }
            const targets = flattenSchemaIssues(error.cause)
              .map((issue) =>
                prunableSegments(draft, issue.path, issue.code === "missing_required"),
              )
              .filter((segments) => segments.length > 0);
            if (targets.length === 0) return yield* error;
            if (reportFailures) schemaFailures.push(error);
            for (const segments of targets) {
              if (!pruned.some((known) => sameDocumentValue(known, segments)))
                pruned.push(segments);
            }
            pruneDocumentPaths(draft, targets, document);
          }
        });
      const loaded = withEnvOrigins(
        yield* decode(declaredDraft, declaredResolved, true),
        declaredEnvOrigins,
      );
      const fileDeclared = withPlatform(
        decodeMergedCliConfig(mergedForDecode, {
          envValues,
          cliCompat: true,
          document: fileDraft,
          resolvedPaths: fileResolved,
          ...allIssues,
        }),
      ).pipe(Effect.map((decoded) => withEnvOrigins(decoded, fileEnvOrigins)));
      const materializedLoaded = withEnvOrigins(
        yield* decode(materializedDraft, materializedResolved, false),
        materializedEnvOrigins,
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
                ...(decoded.source === "remote" && appliedRemote !== undefined
                  ? { remote: appliedRemote }
                  : {}),
                ...(merged === null ? {} : { file: merged.path }),
              };
        },
      };

      const get: ResolvedCliConfig["get"] = (key) =>
        Effect.gen(function* () {
          const picked = pickCliConfigKey(key, sources);
          if (Result.isFailure(picked)) return yield* picked.failure;
          return picked.success;
        }).pipe(tracksConfigFailureKey);

      if (notices) for (const message of overrideWarnings) yield* warnOnce(message);
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
        remoteFailures: target.validation ? remoteFailures : [],
        schemaFailures,
        get pruneLimitReached() {
          return pruneLimitReached;
        },
        pruned,
        familyNames,
        declares: (configPath) => configAt(configPath) !== undefined,
        withheldEnv,
        dotenvPrivateKeys,
        projectEnvValues: Object.assign<Record<string, string>, Record<string, string>>(
          Object.create(null),
          Object.fromEntries(Object.entries(projectEnv.values).filter(([name]) => !withheld(name))),
        ),
        envValues: (names) => {
          const wanted = [...new Set(names)];
          return shell.load(wanted).pipe(
            Effect.map(() => {
              const values: Record<string, string> = Object.create(null);
              for (const name of wanted) {
                const value = lookupEnv(name);
                if (value !== undefined) values[name] = value;
              }
              return values;
            }),
          );
        },
      } satisfies ResolvedCliConfig;
    });

    const cache = yield* Cache.makeWith(loadResolvedConfig, {
      capacity: 32,
      timeToLive: (exit) => (Exit.isSuccess(exit) ? Duration.infinity : Duration.zero),
    });

    const invalidate = Effect.all([
      Cache.invalidateAll(cache),
      Cache.invalidateAll(parsedDocuments),
      Cache.invalidateAll(validationParsedDocuments),
    ]).pipe(Effect.asVoid);

    return CliConfigValues.of({
      load: (target) =>
        Cache.get(
          cache,
          new LoadKey({
            workdir: target.workdir,
            projectRef: target.projectRef,
            ignoreConfigFile: target.ignoreConfigFile === true,
            tolerateUnreadableLinkedRef: target.tolerateUnreadableLinkedRef === true,
            tolerateInvalid: target.tolerateInvalid === true || target.validation === true,
            validation: target.validation === true,
            remoteName: target.remoteName,
          }),
        ).pipe(tracksConfigFailureKey),
      writeThrough: (write) => Effect.ensuring(write, invalidate),
      invalidate,
    });
  }),
);
