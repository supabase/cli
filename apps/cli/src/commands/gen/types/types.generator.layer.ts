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

import { DbConnection } from "../../../command-internal/db-connection.service.ts";
import { RuntimeInfo } from "../../../shared/runtime/runtime-info.service.ts";
import {
  type GenTypesGenerateError,
  type GenTypesGenerateInput,
  GenTypesGenerationError,
  GenTypesGenerator,
  GenTypesToolFailedError,
  GenTypesToolNotInstalledError,
} from "./types.generator.service.ts";
import { makeTypegenHost } from "./types.typegen-host.ts";

/** Only the values the language declares; the registry rejects names it does not know. */
export const declaredOptions = (language: TypegenLanguage, values: OptionValues): OptionValues => {
  const declared: Record<string, OptionValue> = {};
  for (const spec of language.options) {
    const value = values[spec.name];
    if (value !== undefined) declared[spec.name] = value;
  }
  return declared;
};

const generationError = (lang: string, cause: unknown): GenTypesGenerationError =>
  new GenTypesGenerationError({
    message: `failed to generate ${lang} types: ${cause instanceof Error ? cause.message : String(cause)}`,
    cause,
  });

/** The CLI error for whatever `TypegenLanguage.generate` rejected with. */
export const mapRegistryError = (lang: string, cause: unknown): GenTypesGenerateError => {
  if (cause instanceof ToolNotInstalledError) {
    return new GenTypesToolNotInstalledError({ message: cause.message });
  }
  if (cause instanceof ToolFailedError) {
    return new GenTypesToolFailedError({ message: cause.message, cause });
  }
  if (cause instanceof InvalidOptionError) {
    return new GenTypesGenerationError({ message: cause.message, cause });
  }
  return generationError(lang, cause);
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
    const runtime = yield* RuntimeInfo;
    const lookupEnv = {
      PATH: yield* optionalEnv("PATH"),
      PATHEXT: yield* optionalEnv("PATHEXT"),
      ComSpec: yield* optionalEnv("ComSpec"),
    };
    return GenTypesGenerator.of({
      generate: Effect.fn("GenTypes.generate")(function* (input: GenTypesGenerateInput) {
        yield* Effect.annotateCurrentSpan({
          "typegen.lang": input.lang,
          "typegen.schema_count": input.includedSchemas.length,
          "db.is_local": input.isLocal,
        });
        const language = findLanguage(input.lang);
        if (language === undefined) {
          return yield* new GenTypesGenerationError({
            message: `failed to generate ${input.lang} types: unknown language`,
          });
        }
        // Each Promise bridge runs through its phase's fiber context (rather than a bare detached
        // `Effect.runPromise`) so it stays anchored to this generator effect instead of a
        // disconnected top-level runtime.
        const toGenerationError = (cause: unknown) => generationError(input.lang, cause);
        // The session closes before an out-of-process tool starts, so no connection idles
        // while, say, `dart run` compiles.
        const metadata = yield* Effect.scoped(
          Effect.gen(function* () {
            const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
            const session = yield* dbConn.connect(input.conn, {
              isLocal: input.isLocal,
              dnsResolver: input.dnsResolver,
            });
            return yield* Effect.tryPromise({
              try: (signal) => {
                // `signal` aborts when this generate call is interrupted, so forwarding it to
                // every query stops an in-flight introspection query instead of leaving it
                // detached from the fiber that started it.
                const queryable: Queryable = {
                  query: (sql) =>
                    runPromise(session.query(sql), { signal }).then((rows) => ({
                      rows: [...rows],
                    })),
                };
                return introspect(queryable, { includedSchemas: [...input.includedSchemas] });
              },
              catch: toGenerationError,
            });
          }),
        ).pipe(
          Effect.tap((metadata) =>
            Effect.annotateCurrentSpan({
              "typegen.table_count": metadata.tables.length,
              "typegen.view_count": metadata.views.length,
              "typegen.function_count": metadata.functions.length,
            }),
          ),
          Effect.withSpan("GenTypes.introspect"),
        );
        return yield* Effect.gen(function* () {
          const host = makeTypegenHost({
            cwd: runtime.cwd,
            env: lookupEnv,
            platform: runtime.platform,
            spawner,
            runPromise: Effect.runPromiseWith(yield* Effect.context<never>()),
          });
          const source = yield* Effect.tryPromise({
            try: (signal) =>
              language.generate(metadata, declaredOptions(language, input.options), {
                ...host,
                signal,
              }),
            catch: (cause) => mapRegistryError(input.lang, cause),
          });
          yield* Effect.annotateCurrentSpan("typegen.output_length", source.length);
          return source;
        }).pipe(Effect.withSpan("GenTypes.render"));
      }),
    });
  }),
);
