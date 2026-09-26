import { Data, Effect, Exit, Redacted, Schema } from "effect";
import { postgresVersion } from "../Artifacts.ts";
import { causeMessage, type CompositionConfig } from "../Orchestrator.ts";
import type { Observation } from "../Rpc.ts";
import { ServiceCreation, type ServiceCreationInput } from "../services/Catalog.ts";
import type { SavedStack, StackIdentityInput } from "../State.ts";
import { credentialInputNames } from "../host/Credentials.ts";
import { apiRoute, endpointNames, endpointPort } from "../host/Endpoints.ts";

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

/** Inputs the composition derives from its shared API endpoint and sibling members. */
const derivedInputs: Partial<Record<ServiceCreation["service"], ReadonlyArray<string>>> = {
  auth: ["externalApiUrl"],
  studio: ["apiUrl", "publicApiUrl", "analyticsApiKey", "functionsRoot"],
  functions: ["apiUrl", "databaseUrl"],
};

/** Names every config input the package supplies to a composition member of this kind. */
const managedInputs = (service: ServiceCreation["service"]): ReadonlySet<string> =>
  new Set([
    ...managedBindings.filter(({ targetKind }) => targetKind === service).map(({ input }) => input),
    ...(derivedInputs[service] ?? []),
    ...credentialInputNames(service),
  ]);

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

/** Owner operations the composition drives; their failures surface as composition errors. */
export interface SupabaseCompositionOperations<E = SupabaseCompositionError> {
  readonly currentComposition: Effect.Effect<CompositionConfig>;
  readonly get: (id: string) => Effect.Effect<SupabaseCompositionEntry, E>;
  readonly status: (id: string) => Effect.Effect<Pick<Observation, "lifecycle" | "wakeEnabled">, E>;
  readonly create: (creation: ServiceCreation) => Effect.Effect<SupabaseCompositionEntry, E>;
  readonly destroy: (id: string) => Effect.Effect<void, E>;
  readonly bind: (id: string) => Effect.Effect<void, E>;
  readonly address: (
    id: string,
    endpoint: string,
    from: "host" | "runtime",
  ) => Effect.Effect<string, E>;
  readonly output: (id: string, name: string) => Effect.Effect<string, E>;
  readonly updateCreation: (
    id: string,
    inputs: Record<string, string | undefined>,
  ) => Effect.Effect<SupabaseCompositionEntry, E>;
  readonly replaceCreation: (
    id: string,
    creation: ServiceCreation,
  ) => Effect.Effect<SupabaseCompositionEntry, E>;
  readonly configure: (configuration: CompositionConfig) => Effect.Effect<void, E>;
}

export interface SupabaseCompositionOptions {
  /** Reuses stopped instances; inputs declare desired bindings, not previous resolved creations. */
  readonly reuseIds?: ReadonlyArray<string>;
  readonly keys?: StackIdentityInput;
  /**
   * Starts every member with the composition. By default the database and members without an
   * endpoint start eagerly, and other members start on their first connection.
   */
  readonly eager?: boolean;
}

/** How a saved instance differs from a requested creation once package-managed inputs are set aside. */
export type CreationChange =
  | { readonly change: "unchanged" }
  | { readonly change: "changed"; readonly paths: ReadonlyArray<string> }
  | {
      /** The instance cannot adopt the request: its endpoints, artifact or data version differ. */
      readonly change: "incompatible";
      readonly paths: ReadonlyArray<string>;
    };

/** A saved instance of a requested service kind, compared with that request. */
export type PlannedInstance = CreationChange & {
  readonly id: string;
  readonly service: ServiceCreation["service"];
  /** Whether the instance belongs to the saved composition. */
  readonly member: boolean;
};

const differences = (left: unknown, right: unknown, path: string): ReadonlyArray<string> => {
  if (Redacted.isRedacted(left) || Redacted.isRedacted(right))
    return Redacted.isRedacted(left) &&
      Redacted.isRedacted(right) &&
      Redacted.value(left) === Redacted.value(right)
      ? []
      : [path];
  if (Array.isArray(left) || Array.isArray(right))
    return Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => differences(value, right[index], path).length === 0)
      ? []
      : [path];
  if (isRecord(left) && isRecord(right))
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .toSorted()
      .flatMap((key) => differences(left[key], right[key], path === "" ? key : `${path}.${key}`));
  return Object.is(left, right) ? [] : [path];
};

const sharesApiEndpoint = (creation: ServiceCreationInput): boolean =>
  apiRoute(creation.service) !== undefined && endpointNames(creation).includes("http");

/** Fixed ports requested for the shared API endpoint; composition accepts at most one. */
const fixedApiPorts = (creations: ReadonlyArray<ServiceCreationInput>): ReadonlySet<number> =>
  new Set(
    creations
      .filter(sharesApiEndpoint)
      .map((creation) => endpointPort(creation, "http"))
      .filter((port): port is number => port !== "auto"),
  );

/** Endpoint intents with an automatic shared API port replaced by the fixed one. */
const withSharedApiPort = (creation: ServiceCreationInput, sharedPort: number | undefined) =>
  sharedPort === undefined ||
  !sharesApiEndpoint(creation) ||
  endpointPort(creation, "http") !== "auto"
    ? creation.endpoints
    : { ...(isRecord(creation.endpoints) ? creation.endpoints : {}), http: { port: sharedPort } };

const comparable = (creation: ServiceCreationInput, sharedPort: number | undefined) => {
  const managed = managedInputs(creation.service);
  const config: Record<string, unknown> = Object.fromEntries(
    Object.entries(creation.config).filter(([key]) => !managed.has(key)),
  );
  if (creation.service === "database") config.version = postgresVersion(creation.config.version);
  return { version: creation.version, endpoints: withSharedApiPort(creation, sharedPort), config };
};

/** Compares a requested creation with a saved one, ignoring inputs the package supplies. */
const compareCreation = (
  saved: ServiceCreation,
  requested: ServiceCreationInput,
  sharedPort: number | undefined,
): CreationChange => {
  const paths = differences(comparable(saved, undefined), comparable(requested, sharedPort), "");
  const incompatible = paths.filter(
    (path) =>
      path === "version" ||
      path === "endpoints" ||
      path.startsWith("endpoints.") ||
      (saved.service === "database" && path === "config.version"),
  );
  return incompatible.length > 0
    ? { change: "incompatible", paths: incompatible }
    : paths.length > 0
      ? { change: "changed", paths }
      : { change: "unchanged" };
};

/** Compares each saved instance of a requested kind with its request, without changing state. */
export const planSupabaseComposition = (
  saved: Pick<SavedStack, "instances" | "composition">,
  requested: ReadonlyArray<ServiceCreationInput>,
): ReadonlyArray<PlannedInstance> => {
  const members = new Set(saved.composition.members.map(({ id }) => id));
  const requestedKinds = new Set(requested.map(({ service }) => service));
  const ports = fixedApiPorts([
    ...requested,
    ...saved.instances
      .filter(({ id, creation }) => members.has(id) && requestedKinds.has(creation.service))
      .map(({ creation }) => creation),
  ]);
  const sharedPort = ports.size === 1 ? [...ports][0] : undefined;
  return saved.instances.flatMap(({ id, creation }) => {
    const request = requested.find(({ service }) => service === creation.service);
    return request === undefined
      ? []
      : [
          {
            id,
            service: creation.service,
            member: members.has(id),
            ...compareCreation(creation, request, sharedPort),
          },
        ];
  });
};

const compositionError = (message: string, cause?: unknown) =>
  new SupabaseCompositionError({ message, cause });

const compositionErrorFrom = (cause: unknown) =>
  cause instanceof SupabaseCompositionError
    ? cause
    : compositionError(cause instanceof Error ? cause.message : String(cause), cause);

export const makeSupabaseComposition = Effect.fn("Supabase.compose")(
  <E>(
    operations: SupabaseCompositionOperations<E>,
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

      const fixedPorts = fixedApiPorts([
        ...decoded,
        ...reusedEntries.map(({ creation }) => creation),
      ]);
      if (fixedPorts.size > 1)
        return yield* compositionError("Shared HTTP endpoints must use one port");
      const sharedPort = [...fixedPorts][0];
      const normalized = yield* Effect.forEach(decoded, (creation) => {
        const endpoints = withSharedApiPort(creation, sharedPort);
        return endpoints === creation.endpoints
          ? Effect.succeed(creation)
          : Schema.decodeUnknownEffect(ServiceCreation)({ ...creation, endpoints }).pipe(
              Effect.mapError(compositionErrorFrom),
            );
      });

      const reusedByKind = new Map(reusedEntries.map((entry) => [entry.creation.service, entry]));
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
        const replacedByKind = new Map<ServiceCreation["service"], SupabaseCompositionEntry>();
        for (const creation of normalized) {
          const reused = reusedByKind.get(creation.service);
          if (reused === undefined) continue;
          const entry = yield* operations
            .replaceCreation(reused.id, creation)
            .pipe(Effect.mapError(compositionErrorFrom));
          replacedByKind.set(entry.creation.service, entry);
        }
        const created = yield* Effect.forEach(
          normalized.filter((creation) => !reusedByKind.has(creation.service)),
          (creation) =>
            Effect.uninterruptible(
              operations.create(creation).pipe(
                Effect.mapError(compositionErrorFrom),
                Effect.tap((entry) => Effect.sync(() => createdIds.push(entry.id))),
              ),
            ),
        );
        const createdByKind = new Map(created.map((entry) => [entry.creation.service, entry]));
        const entries = normalized.map((creation) => {
          const reused = replacedByKind.get(creation.service);
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
                compositionError(
                  `${entry.creation.service} ${entry.id}: ${compositionErrorFrom(cause).message}`,
                  cause,
                ),
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
          const lazy =
            options.eager !== true &&
            creation.service !== "database" &&
            endpointNames(creation).length > 0;
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
