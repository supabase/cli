import { Cause, Data, Effect, Exit, Schema } from "effect";
import type { CompositionConfig } from "../Orchestrator.ts";
import type { Observation } from "../Rpc.ts";
import { ServiceCreation } from "../services/Catalog.ts";
import { apiRoute, endpointNames, endpointPort } from "../host/Endpoints.ts";

export class SupabaseCompositionError extends Data.TaggedError("SupabaseCompositionError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

interface SupabaseCompositionEntry {
  readonly id: string;
  readonly creation: ServiceCreation;
}

export interface SupabaseCompositionOperations {
  readonly currentComposition: Effect.Effect<CompositionConfig>;
  readonly get: (id: string) => Effect.Effect<SupabaseCompositionEntry, SupabaseCompositionError>;
  readonly status: (
    id: string,
  ) => Effect.Effect<Pick<Observation, "lifecycle" | "wakeEnabled">, SupabaseCompositionError>;
  readonly create: (
    creation: ServiceCreation,
  ) => Effect.Effect<SupabaseCompositionEntry, SupabaseCompositionError>;
  readonly destroy: (id: string) => Effect.Effect<void, SupabaseCompositionError>;
  readonly bind: (id: string) => Effect.Effect<void, SupabaseCompositionError>;
  readonly address: (
    id: string,
    endpoint: string,
    from: "host" | "runtime",
  ) => Effect.Effect<string, SupabaseCompositionError>;
  readonly output: (id: string, name: string) => Effect.Effect<string, SupabaseCompositionError>;
  readonly updateCreation: (
    id: string,
    inputs: Record<string, string | undefined>,
  ) => Effect.Effect<SupabaseCompositionEntry, SupabaseCompositionError>;
  readonly configure: (
    configuration: CompositionConfig,
  ) => Effect.Effect<void, SupabaseCompositionError>;
}

export interface SupabaseCompositionOptions {
  /** Reuses stopped instances; inputs declare desired bindings, not previous resolved creations. */
  readonly reuseIds?: ReadonlyArray<string>;
}

const compositionError = (message: string, cause?: unknown) =>
  new SupabaseCompositionError({ message, cause });

const causeMessage = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) => error.message)
    .join("; ") || "interrupted";

const compositionErrorFrom = (cause: unknown) =>
  cause instanceof SupabaseCompositionError
    ? cause
    : compositionError(cause instanceof Error ? cause.message : String(cause), cause);

export const makeSupabaseComposition = Effect.fn("Supabase.compose")(
  (
    operations: SupabaseCompositionOperations,
    inputs: ReadonlyArray<ServiceCreation>,
    options: SupabaseCompositionOptions = {},
  ) =>
    Effect.gen(function* () {
      const current = yield* operations.currentComposition;
      const reuseIds = options.reuseIds;
      if (reuseIds === undefined && (current.members.length > 0 || current.dependencies.length > 0))
        return yield* compositionError("Composition is already configured");

      const decoded = yield* Effect.forEach(inputs, (input) =>
        Schema.decodeEffect(ServiceCreation)(input).pipe(Effect.mapError(compositionErrorFrom)),
      );
      const seen = new Set<string>();
      for (const creation of decoded) {
        if (seen.has(creation.service))
          return yield* compositionError(`Duplicate service kind ${creation.service}`);
        seen.add(creation.service);
      }

      const reusedEntries: ReadonlyArray<SupabaseCompositionEntry> =
        reuseIds === undefined
          ? []
          : yield* Effect.gen(function* () {
              const unique = new Set<string>();
              for (const id of reuseIds) {
                if (unique.has(id)) return yield* compositionError(`Duplicate reuse ID ${id}`);
                unique.add(id);
              }
              const entries = yield* Effect.forEach(reuseIds, (id) =>
                operations.get(id).pipe(Effect.mapError(compositionErrorFrom)),
              );
              const kinds = new Set<string>();
              for (const entry of entries) {
                if (!seen.has(entry.creation.service))
                  return yield* compositionError(
                    `Reused service ${entry.id} (${entry.creation.service}) is not requested`,
                  );
                if (kinds.has(entry.creation.service))
                  return yield* compositionError(
                    `Multiple reuse IDs request service kind ${entry.creation.service}`,
                  );
                kinds.add(entry.creation.service);
              }

              const currentIds = new Set([
                ...current.members.map(({ id }) => id),
                ...current.dependencies.flatMap(({ from, to }) => [from, to]),
              ]);
              const currentEntries = yield* Effect.forEach([...currentIds], (id) =>
                operations.get(id).pipe(Effect.mapError(compositionErrorFrom)),
              );
              const reused = new Set(reuseIds);
              for (const entry of currentEntries) {
                if (seen.has(entry.creation.service) && !reused.has(entry.id))
                  return yield* compositionError(
                    `Existing ${entry.creation.service} member ${entry.id} must be reused or removed from the requested composition`,
                  );
              }
              const affectedIds = new Set([...currentIds, ...reuseIds]);
              yield* Effect.forEach([...affectedIds], (id) =>
                operations.status(id).pipe(
                  Effect.mapError(compositionErrorFrom),
                  Effect.flatMap((status) =>
                    status.lifecycle === "stopped" && !status.wakeEnabled
                      ? Effect.void
                      : Effect.fail(
                          compositionError(
                            `Service ${id} must be stopped with wake disabled before composition changes`,
                          ),
                        ),
                  ),
                ),
              );
              return entries;
            });

      const fixedPorts = new Set(
        [...decoded, ...reusedEntries.map(({ creation }) => creation)]
          .filter(
            (creation) =>
              apiRoute(creation.service) !== undefined && endpointNames(creation).includes("http"),
          )
          .map((creation) => endpointPort(creation, "http"))
          .filter((port): port is number => port !== "auto"),
      );
      if (fixedPorts.size > 1)
        return yield* compositionError("Shared HTTP endpoints must use one port");
      const sharedPort = [...fixedPorts][0];
      const normalized = yield* Effect.forEach(decoded, (creation) => {
        if (
          sharedPort === undefined ||
          apiRoute(creation.service) === undefined ||
          !endpointNames(creation).includes("http") ||
          endpointPort(creation, "http") !== "auto"
        )
          return Effect.succeed(creation);
        const endpoints = isRecord(creation.endpoints) ? creation.endpoints : {};
        return Schema.decodeUnknownEffect(ServiceCreation)({
          ...creation,
          endpoints: { ...endpoints, http: { port: sharedPort } },
        }).pipe(Effect.mapError(compositionErrorFrom));
      });

      const reusedByKind = new Map(reusedEntries.map((entry) => [entry.creation.service, entry]));
      const targetCreations = normalized.map(
        (creation) => reusedByKind.get(creation.service)?.creation ?? creation,
      );
      const byKind = new Map(targetCreations.map((creation) => [creation.service, creation]));
      const apiSource = targetCreations.find(
        (creation) =>
          apiRoute(creation.service) !== undefined && endpointNames(creation).includes("http"),
      );
      if (
        apiSource === undefined &&
        targetCreations.some((creation) =>
          ["auth", "functions", "studio"].includes(creation.service),
        )
      )
        return yield* compositionError("API URL bindings require a configured HTTP endpoint");

      const managedBindings: ReadonlyArray<{
        readonly sourceKind: ServiceCreation["service"];
        readonly sourceEndpoint: string;
        readonly output: string;
        readonly targetKind: ServiceCreation["service"];
        readonly input: string;
      }> = [
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "authenticatorUrl",
          targetKind: "rest",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "authDatabaseUrl",
          targetKind: "auth",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "storageDatabaseUrl",
          targetKind: "storage",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "databaseUrl",
          targetKind: "storage",
          input: "vectorDatabaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "databaseUrl",
          targetKind: "realtime",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "databaseUrl",
          targetKind: "pgmeta",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "internalDatabaseUrl",
          targetKind: "analytics",
          input: "databaseUrl",
        },
        {
          sourceKind: "database",
          sourceEndpoint: "sql",
          output: "internalDatabaseUrl",
          targetKind: "pooler",
          input: "databaseUrl",
        },
        {
          sourceKind: "imgproxy",
          sourceEndpoint: "http",
          output: "url",
          targetKind: "storage",
          input: "imgproxyUrl",
        },
        {
          sourceKind: "pgmeta",
          sourceEndpoint: "http",
          output: "url",
          targetKind: "studio",
          input: "pgmetaUrl",
        },
        {
          sourceKind: "analytics",
          sourceEndpoint: "http",
          output: "url",
          targetKind: "studio",
          input: "analyticsUrl",
        },
        {
          sourceKind: "analytics",
          sourceEndpoint: "http",
          output: "url",
          targetKind: "vector",
          input: "analyticsUrl",
        },
        {
          sourceKind: "functions",
          sourceEndpoint: "http",
          output: "url",
          targetKind: "studio",
          input: "functionsUrl",
        },
        {
          sourceKind: "mail",
          sourceEndpoint: "smtp",
          output: "smtpUrl",
          targetKind: "auth",
          input: "smtpUrl",
        },
      ];
      for (const { sourceKind, sourceEndpoint, targetKind } of managedBindings) {
        if (byKind.has(sourceKind) && byKind.has(targetKind)) {
          const source = byKind.get(sourceKind);
          if (source === undefined || !endpointNames(source).includes(sourceEndpoint))
            return yield* compositionError(
              `${sourceKind} requires configured ${sourceEndpoint} endpoint`,
            );
        }
      }

      const createdIds: Array<string> = [];
      const compose = Effect.gen(function* () {
        const created = yield* Effect.forEach(
          targetCreations.filter((creation) => !reusedByKind.has(creation.service)),
          (creation) =>
            Effect.uninterruptible(
              operations.create(creation).pipe(
                Effect.mapError(compositionErrorFrom),
                Effect.tap((entry) => Effect.sync(() => createdIds.push(entry.id))),
              ),
            ),
        );
        const createdByKind = new Map(created.map((entry) => [entry.creation.service, entry]));
        const entries = targetCreations.map((creation) => {
          const reused = reusedByKind.get(creation.service);
          return reused ?? createdByKind.get(creation.service);
        });
        const configuredEntries = entries.filter(
          (entry): entry is SupabaseCompositionEntry => entry !== undefined,
        );
        if (configuredEntries.length !== entries.length)
          return yield* compositionError("Composition instance is missing");
        for (const entry of configuredEntries) {
          yield* operations
            .bind(entry.id)
            .pipe(
              Effect.mapError((cause) =>
                compositionError(`${entry.creation.service} ${entry.id}: ${cause.message}`, cause),
              ),
            );
        }

        const addressUrl = (
          entry: { readonly id: string },
          endpoint: string,
          from: "host" | "runtime",
        ) => operations.address(entry.id, endpoint, from);
        const apiEntry =
          apiSource === undefined
            ? undefined
            : configuredEntries.find((entry) => entry.creation.service === apiSource.service);
        if (apiSource !== undefined && apiEntry === undefined)
          return yield* compositionError("API source instance is missing");
        const apiHostUrl =
          apiEntry === undefined ? undefined : yield* addressUrl(apiEntry, "http", "host");
        const apiRuntimeUrl =
          apiEntry === undefined ? undefined : yield* addressUrl(apiEntry, "http", "runtime");
        const entriesByKind = new Map(
          configuredEntries.map((entry) => [entry.creation.service, entry]),
        );
        const dependencyMap = new Map<
          string,
          { from: string; to: string; bindings: Array<{ output: string; input: string }> }
        >();
        const configInputs = new Map<string, Record<string, string | undefined>>();
        for (const {
          sourceKind,
          output: outputName,
          targetKind,
          input: inputName,
        } of managedBindings) {
          const source = entriesByKind.get(sourceKind);
          const target = entriesByKind.get(targetKind);
          if (target === undefined) continue;
          const values = configInputs.get(target.id) ?? {};
          if (source === undefined) {
            const requested = normalized.find((creation) => creation.service === targetKind);
            const fallback =
              requested === undefined ? undefined : Reflect.get(requested.config, inputName);
            values[inputName] = typeof fallback === "string" ? fallback : undefined;
            configInputs.set(target.id, values);
            continue;
          }
          values[inputName] = yield* operations.output(source.id, outputName);
          configInputs.set(target.id, values);
          const key = `${source.id}->${target.id}`;
          const dependency = dependencyMap.get(key) ?? {
            from: source.id,
            to: target.id,
            bindings: [],
          };
          dependency.bindings.push({ output: outputName, input: inputName });
          dependencyMap.set(key, dependency);
        }
        const configured = yield* Effect.forEach(configuredEntries, (entry) =>
          Effect.gen(function* () {
            const extra: Record<string, string> =
              entry.creation.service === "auth" && apiHostUrl !== undefined
                ? { externalApiUrl: `${apiHostUrl}/auth/v1` }
                : entry.creation.service === "studio" &&
                    apiHostUrl !== undefined &&
                    apiRuntimeUrl !== undefined
                  ? {
                      apiUrl: apiRuntimeUrl,
                      publicApiUrl: entry.creation.config.publicApiUrl ?? apiHostUrl,
                    }
                  : entry.creation.service === "functions" && apiRuntimeUrl !== undefined
                    ? { apiUrl: apiRuntimeUrl }
                    : {};
            const values = { ...configInputs.get(entry.id), ...extra };
            if (entry.creation.service === "studio") {
              const analytics = entriesByKind.get("analytics");
              if (
                analytics?.creation.service === "analytics" &&
                analytics.creation.config.apiKey !== undefined
              )
                values.analyticsApiKey = analytics.creation.config.apiKey;
              const functions = entriesByKind.get("functions");
              if (functions?.creation.service === "functions")
                values.functionsRoot = functions.creation.config.functionsRoot;
            }
            const database = entriesByKind.get("database");
            if (
              entry.creation.service === "functions" &&
              database !== undefined &&
              endpointNames(database.creation).includes("sql")
            )
              values.databaseUrl = yield* operations.output(database.id, "databaseUrl");
            if (Object.keys(values).length > 0) {
              return yield* operations.updateCreation(entry.id, values);
            }
            return entry;
          }),
        );
        const members = configured.map(({ id, creation }) => {
          const lazy = creation.service !== "database" && endpointNames(creation).length > 0;
          return lazy
            ? creation.service === "functions"
              ? { id, activation: "lazy" as const }
              : { id, activation: "lazy" as const, idleMillis: 60_000 }
            : { id, activation: "eager" as const };
        });
        yield* operations.configure({
          members,
          dependencies: [...dependencyMap.values()],
        });
        return configured;
      });
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(compose));
          if (Exit.isSuccess(exit)) return exit.value;
          const cleanup = yield* Effect.forEach(createdIds, (id) =>
            operations.destroy(id).pipe(
              Effect.exit,
              Effect.map((result) => ({ id, result })),
            ),
          );
          const failures = cleanup.flatMap(({ id, result }) =>
            Exit.isFailure(result) ? [`${id}: ${causeMessage(result.cause)}`] : [],
          );
          if (failures.length > 0)
            return yield* compositionError(
              `Composition failed: ${causeMessage(exit.cause)}. Cleanup failed for created services: ${failures.join("; ")}`,
              { original: exit.cause, cleanup },
            );
          return yield* Effect.failCause(exit.cause);
        }),
      );
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SupabaseCompositionError ? cause : compositionErrorFrom(cause),
      ),
    ),
);
