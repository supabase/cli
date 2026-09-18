import { Data, Effect, Schema } from "effect";
import type { CompositionConfig } from "../Orchestrator.ts";
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
  readonly create: (
    creation: ServiceCreation,
  ) => Effect.Effect<SupabaseCompositionEntry, SupabaseCompositionError>;
  readonly bind: (id: string) => Effect.Effect<void, SupabaseCompositionError>;
  readonly address: (
    id: string,
    endpoint: string,
    from: "host" | "runtime",
  ) => Effect.Effect<string, SupabaseCompositionError>;
  readonly output: (id: string, name: string) => Effect.Effect<string, SupabaseCompositionError>;
  readonly updateCreation: (
    id: string,
    inputs: Record<string, string>,
  ) => Effect.Effect<SupabaseCompositionEntry, SupabaseCompositionError>;
  readonly configure: (
    configuration: CompositionConfig,
  ) => Effect.Effect<void, SupabaseCompositionError>;
}

const compositionError = (message: string, cause?: unknown) =>
  new SupabaseCompositionError({ message, cause });

const compositionErrorFrom = (cause: unknown) =>
  cause instanceof SupabaseCompositionError
    ? cause
    : compositionError(cause instanceof Error ? cause.message : String(cause), cause);

export const makeSupabaseComposition = Effect.fn("Supabase.compose")(
  (operations: SupabaseCompositionOperations, inputs: ReadonlyArray<ServiceCreation>) =>
    Effect.gen(function* () {
      const current = yield* operations.currentComposition;
      if (current.members.length > 0 || current.dependencies.length > 0)
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

      const fixedPorts = new Set(
        decoded
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

      const byKind = new Map(normalized.map((creation) => [creation.service, creation]));
      const apiSource = normalized.find(
        (creation) =>
          apiRoute(creation.service) !== undefined && endpointNames(creation).includes("http"),
      );
      if (
        apiSource === undefined &&
        normalized.some((creation) => ["auth", "functions", "studio"].includes(creation.service))
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

      const created = yield* Effect.forEach(normalized, (creation) =>
        operations.create(creation).pipe(Effect.mapError(compositionErrorFrom)),
      );
      const createdByKind = new Map(created.map((entry) => [entry.creation.service, entry]));
      for (const entry of created) {
        yield* operations.bind(entry.id);
      }

      const addressUrl = (
        entry: { readonly id: string },
        endpoint: string,
        from: "host" | "runtime",
      ) => operations.address(entry.id, endpoint, from);
      const apiEntry = apiSource === undefined ? undefined : createdByKind.get(apiSource.service);
      if (apiSource !== undefined && apiEntry === undefined)
        return yield* compositionError("API source instance is missing");
      const apiHostUrl =
        apiEntry === undefined ? undefined : yield* addressUrl(apiEntry, "http", "host");
      const apiRuntimeUrl =
        apiEntry === undefined ? undefined : yield* addressUrl(apiEntry, "http", "runtime");
      const dependencyMap = new Map<
        string,
        { from: string; to: string; bindings: Array<{ output: string; input: string }> }
      >();
      const configInputs = new Map<string, Record<string, string>>();
      for (const {
        sourceKind,
        output: outputName,
        targetKind,
        input: inputName,
      } of managedBindings) {
        const source = createdByKind.get(sourceKind);
        const target = createdByKind.get(targetKind);
        if (source === undefined || target === undefined) continue;
        const values = configInputs.get(target.id) ?? {};
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
      const configured = yield* Effect.forEach(created, (entry) =>
        Effect.gen(function* () {
          const extra: Record<string, string> =
            entry.creation.service === "auth" && apiHostUrl !== undefined
              ? { externalApiUrl: `${apiHostUrl}/auth/v1` }
              : entry.creation.service === "studio" &&
                  apiHostUrl !== undefined &&
                  apiRuntimeUrl !== undefined
                ? { apiUrl: apiRuntimeUrl, publicApiUrl: apiHostUrl }
                : entry.creation.service === "functions" && apiRuntimeUrl !== undefined
                  ? { apiUrl: apiRuntimeUrl }
                  : {};
          const values = { ...configInputs.get(entry.id), ...extra };
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
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof SupabaseCompositionError ? cause : compositionErrorFrom(cause),
      ),
    ),
);
