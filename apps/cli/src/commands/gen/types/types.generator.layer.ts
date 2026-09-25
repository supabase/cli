import {
  findLanguage,
  InvalidOptionError,
  introspect,
  type OptionValue,
  type OptionValues,
  type Queryable,
  ToolFailedError,
  ToolNotInstalledError,
  type TypegenLanguage,
} from "@supabase/typegen";
import { Config, Effect, Layer, Option } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import { CommandSettings } from "../../../config/command-settings.service.ts";
import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  GenTypesGenerationError,
  GenTypesGenerator,
  GenTypesToolFailedError,
  GenTypesToolNotInstalledError,
} from "./types.generator.service.ts";
import { makeTypegenHost } from "./types.typegen-host.ts";

/** Only the values the language declares; the registry rejects names it does not know. */
const declaredOptions = (language: TypegenLanguage, values: OptionValues): OptionValues => {
  const declared: Record<string, OptionValue> = {};
  for (const spec of language.options) {
    const value = values[spec.name];
    if (value !== undefined) declared[spec.name] = value;
  }
  return declared;
};

const optionalEnv = (name: string) =>
  Config.option(Config.string(name)).pipe(Effect.map(Option.getOrUndefined));

/**
 * Live `GenTypesGenerator`: opens a `DbConnection` session, adapts it to typegen's `Queryable`
 * contract, introspects in-process, then hands the metadata to the language's registry entry,
 * which calls its generator in-process or runs the language's own tool in the working directory.
 */
export const genTypesGeneratorLayer = Layer.effect(
  GenTypesGenerator,
  Effect.gen(function* () {
    const dbConn = yield* DbConnection;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* CommandSettings;
    const runtime = yield* RuntimeInfo;
    const lookupEnv = {
      PATH: yield* optionalEnv("PATH"),
      PATHEXT: yield* optionalEnv("PATHEXT"),
      ComSpec: yield* optionalEnv("ComSpec"),
    };
    return GenTypesGenerator.of({
      generate: (input) =>
        Effect.gen(function* () {
          const language = findLanguage(input.lang);
          if (language === undefined) {
            return yield* new GenTypesGenerationError({
              message: `failed to generate ${input.lang} types: unknown language`,
            });
          }
          const session = yield* dbConn.connect(input.conn, {
            isLocal: input.isLocal,
            dnsResolver: input.dnsResolver,
          });
          // Both Promise bridges run through the current fiber's context (rather than a bare
          // detached `Effect.runPromise`) so they stay anchored to this generator effect instead
          // of a disconnected top-level runtime.
          const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
          const toGenerationError = (cause: unknown) =>
            new GenTypesGenerationError({
              message: `failed to generate ${input.lang} types: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              cause,
            });
          const metadata = yield* Effect.tryPromise({
            try: (signal) => {
              // `signal` aborts when this generate call is interrupted, so forwarding it to
              // every query stops an in-flight introspection query instead of leaving it
              // detached from the fiber that started it.
              const queryable: Queryable = {
                query: (sql) =>
                  runPromise(session.query(sql), { signal }).then((rows) => ({ rows: [...rows] })),
              };
              return introspect(queryable, { includedSchemas: [...input.includedSchemas] });
            },
            catch: toGenerationError,
          });
          const host = makeTypegenHost({
            cwd: settings.workdir,
            env: lookupEnv,
            platform: runtime.platform,
            spawner,
            runPromise,
          });
          return yield* Effect.tryPromise({
            try: (signal) =>
              language.generate(metadata, declaredOptions(language, input.options), {
                ...host,
                signal,
              }),
            catch: (cause) => {
              if (cause instanceof ToolNotInstalledError) {
                return new GenTypesToolNotInstalledError({
                  message: cause.message,
                  suggestion: cause.installHint,
                });
              }
              if (cause instanceof ToolFailedError) {
                return new GenTypesToolFailedError({ message: cause.message, cause });
              }
              if (cause instanceof InvalidOptionError) {
                return new GenTypesGenerationError({ message: cause.message, cause });
              }
              return toGenerationError(cause);
            },
          });
        }),
    });
  }),
);
