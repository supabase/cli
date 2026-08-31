import {
  Crypto,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  FiberSet,
  Path,
  PlatformError,
  Scope,
  Schema,
  Semaphore,
} from "effect";
import type { PersistedStackState } from "../state/StackState.ts";
import type { StackId } from "../public/StackId.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { resolveStackPaths } from "../state/Paths.ts";
import {
  resolveSigningKeyMaterial,
  type ResolvedSigningKeyMaterial,
} from "../state/SecretStore.ts";
import { resolveThirdPartyIssuer } from "../model/capabilities/auth-third-party.ts";

/** A parsed JSON document fetched by the owner for OIDC discovery. */
export type RuntimeJsonFetcher = (url: string) => Effect.Effect<unknown, StackPreparationError>;

export interface RuntimeAuthTemplate {
  /** Stable URL id used by GoTrue's mailer template setting. */
  readonly id: string;
  /** User-configured project-relative path. */
  readonly path: string;
  /** Canonical host path, retained for live gateway serving. */
  readonly canonicalPath: string;
  /** File extension including the dot, when one is present. */
  readonly extension: string;
}

export interface RuntimeInputMaterial {
  readonly auth?: Readonly<{
    readonly jwtKeys?: string;
    readonly jwks: string;
    readonly templates?: ReadonlyArray<RuntimeAuthTemplate>;
  }>;
  readonly analytics?: Readonly<{ readonly gcpJwtPath?: string }>;
  readonly pooler?: Readonly<{ readonly tenantPath?: string }>;
  readonly functions?: Readonly<{ readonly secrets: Readonly<Record<string, string>> }>;
}

export interface RuntimeInputOwner {
  /** Resolves all stack-owned inputs needed before a workload is created. */
  readonly resolve: (
    state: PersistedStackState,
    generation: number,
    options?: Readonly<{ readonly includePooler?: boolean }>,
  ) => Effect.Effect<RuntimeInputMaterial, StackPreparationError>;
  /** Resolves one configured project-relative regular file without copying it. */
  readonly resolveProjectFile: (
    state: PersistedStackState,
    configuredPath: string,
  ) => Effect.Effect<string, StackPreparationError>;
  readonly resolveAuthTemplates: (
    state: PersistedStackState,
  ) => Effect.Effect<ReadonlyArray<RuntimeAuthTemplate>, StackPreparationError>;
  readonly cleanupGeneration: (generation: number) => Effect.Effect<void, StackPreparationError>;
  readonly cleanupAll: Effect.Effect<void, StackPreparationError>;
}

export interface RuntimeInputOwnerOptions {
  readonly stateRoot: string;
  readonly stackId: StackId;
  /** Injected OIDC JSON fetcher; no network service is hidden in this owner. */
  readonly fetchJson?: RuntimeJsonFetcher;
}

const failure = (message: string, fields: Readonly<Record<string, unknown>> = {}) =>
  new StackPreparationError({ message, ...fields });

const mapFile = <A, R>(
  target: string,
  operation: string,
  effect: Effect.Effect<A, PlatformError.PlatformError, R>,
): Effect.Effect<A, StackPreparationError, R> =>
  effect.pipe(
    Effect.mapError((error) => failure(`Unable to ${operation}`, { path: target, cause: error })),
  );

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const settingValue = (state: PersistedStackState, value: unknown): string => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (Array.isArray(value)) return value.map((entry) => settingValue(state, entry)).join(",");
  if (isRecord(value) && typeof value.slot === "string" && Object.keys(value).length === 1)
    return state.secrets[value.slot]?.value ?? "";
  // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- dynamic persisted settings are stringified for workload env values
  return JSON.stringify(value) ?? "";
};

type CapabilitySettingName = keyof NonNullable<PersistedStackState["definition"]>["capabilities"];

const settingsFor = (state: PersistedStackState, capability: CapabilitySettingName): unknown =>
  state.definition?.capabilities[capability].settings;

const invalidGeneration = (generation: number): boolean =>
  !Number.isSafeInteger(generation) || generation < 0;

const finiteSetting = (value: string): number | undefined => {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const relativeEscape = (path: Path.Path, root: string, candidate: string): boolean => {
  const relative = path.relative(root, candidate);
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
};

const absoluteForPlatform = (path: Path.Path, value: string): boolean =>
  path.isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || value.startsWith("\\\\");

const extensionFor = (configuredPath: string): string => {
  const file = configuredPath.slice(
    Math.max(configuredPath.lastIndexOf("/"), configuredPath.lastIndexOf("\\")) + 1,
  );
  const dot = file.lastIndexOf(".");
  return dot <= 0 ? "" : file.slice(dot);
};

const publicRemoteJwks = Schema.Struct({ keys: Schema.Array(Schema.Unknown) });
const oidcDiscovery = Schema.Struct({ jwks_uri: Schema.String });

const decodeJson = (value: unknown): Effect.Effect<unknown, Schema.SchemaError> =>
  typeof value === "string"
    ? Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(value)
    : Effect.succeed(value);

/** Keeps OIDC diagnostics useful without echoing userinfo, query, or fragment data. */
const safeUrlLabel = (value: string): string => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "<invalid-url>";
  }
};

const base64UrlEncode = (bytes: Uint8Array): string => {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index] ?? 0;
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    output += alphabet[first >> 2] ?? "";
    output += alphabet[((first & 3) << 4) | ((second ?? 0) >> 4)] ?? "";
    if (second !== undefined) output += alphabet[((second & 15) << 2) | ((third ?? 0) >> 6)] ?? "";
    if (third !== undefined) output += alphabet[third & 63] ?? "";
  }
  return output;
};

const symmetricJwk = (secret: string): Readonly<Record<string, unknown>> => ({
  kty: "oct",
  alg: "HS256",
  use: "sig",
  key_ops: ["verify"],
  k: base64UrlEncode(new TextEncoder().encode(secret)),
});

const elixirString = (value: string): string => {
  let output = '"';
  const characters = [...value];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index] ?? "";
    const code = character.codePointAt(0) ?? 0;
    if (character === "\\") output += "\\\\";
    else if (character === '"') output += '\\"';
    else if (character === "#" && characters[index + 1] === "{") output += "\\#";
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (code < 0x20) output += `\\x${code.toString(16).padStart(2, "0")}`;
    else output += character;
  }
  return `${output}"`;
};

const poolerTenantScript = (input: {
  readonly externalId: string;
  readonly dbHost: string;
  readonly dbPort: number;
  readonly dbPassword: string;
  readonly poolMode: "transaction" | "session";
  readonly defaultPoolSize: number;
  readonly maxClientConn: number;
}): string => `{:ok, _} = Application.ensure_all_started(:supavisor)

{:ok, version} =
  case Supavisor.Repo.query!("select version()") do
    %{rows: [[ver]]} -> Supavisor.Helpers.parse_pg_version(ver)
    _ -> nil
  end

params = %{
  "external_id" => ${elixirString(input.externalId)},
  "db_host" => ${elixirString(input.dbHost)},
  "db_port" => ${String(input.dbPort)},
  "db_database" => "postgres",
  "require_user" => false,
  "auth_query" => "SELECT * FROM pgbouncer.get_auth($1)",
  "default_max_clients" => ${String(input.maxClientConn)},
  "default_pool_size" => ${String(input.defaultPoolSize)},
  "default_parameter_status" => %{"server_version" => version},
  "users" => [%{
    "db_user" => "pgbouncer",
    "db_password" => ${elixirString(input.dbPassword)},
    "mode_type" => ${elixirString(input.poolMode)},
    "pool_size" => ${String(input.defaultPoolSize)},
    "is_manager" => true
  }]
}

case Supavisor.Tenants.get_tenant_by_external_id(params["external_id"]) do
  nil ->
    {:ok, _} = Supavisor.Tenants.create_tenant(params)
  existing ->
    existing = Supavisor.Repo.preload(existing, :users)
    {:ok, _} = Supavisor.Tenants.update_tenant(existing, params)
end
`;

/** Resolves materialized Edge Runtime secrets to their caller-visible names. */
export const resolveFunctionsEdgeRuntimeSecrets = (
  state: PersistedStackState,
): Effect.Effect<Readonly<Record<string, string>>, StackPreparationError> => {
  const settings = settingsFor(state, "functions");
  const edgeRuntime =
    isRecord(settings) && isRecord(settings.edge_runtime) ? settings.edge_runtime : {};
  const configured = isRecord(edgeRuntime.secrets) ? edgeRuntime.secrets : {};
  const output: Record<string, string> = {};
  for (const [name, raw] of Object.entries(configured)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
      return Effect.fail(failure("Functions Edge Runtime secret name is invalid", { name }));
    if (name.startsWith("SUPABASE_"))
      return Effect.fail(failure("Functions Edge Runtime secret name is reserved", { name }));
    const value = settingValue(state, raw);
    // oxlint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/u.test(value))
      return Effect.fail(failure("Functions Edge Runtime secret value is invalid", { name }));
    output[name] = value;
  }
  return Effect.succeed(output);
};

export const makeRuntimeInputOwner = (
  options: RuntimeInputOwnerOptions,
): Effect.Effect<
  RuntimeInputOwner,
  StackPreparationError,
  FileSystem.FileSystem | Path.Path | Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const admission = yield* Semaphore.make(1);
    const execution = yield* Semaphore.make(1);
    const ownerScope = yield* Effect.scope;
    const ownedFibers = yield* FiberSet.make().pipe(Effect.provideService(Scope.Scope, ownerScope));
    const stackPaths = yield* resolveStackPaths(options).pipe(
      Effect.mapError((cause) => failure("Unable to resolve runtime input paths", { cause })),
    );
    const poolerRoot = path.join(stackPaths.runtime, "inputs", "pooler");

    const resolveProjectFile = (
      state: PersistedStackState,
      configuredPath: string,
    ): Effect.Effect<string, StackPreparationError> => {
      if (configuredPath.length === 0 || absoluteForPlatform(path, configuredPath))
        return Effect.fail(failure("Configured project file path must be relative"));
      const root = path.resolve(state.identity.projectRoot);
      const candidate = path.resolve(root, configuredPath);
      if (relativeEscape(path, root, candidate))
        return Effect.fail(failure("Configured project file escapes the project root"));
      return Effect.gen(function* () {
        const canonicalRoot = yield* mapFile(root, "resolve project root", fs.realPath(root));
        const canonicalCandidate = yield* mapFile(
          candidate,
          "resolve configured project file",
          fs.realPath(candidate),
        );
        if (relativeEscape(path, canonicalRoot, canonicalCandidate))
          return yield* failure("Configured project file escapes the project root");
        const info = yield* mapFile(
          canonicalCandidate,
          "inspect configured project file",
          fs.stat(canonicalCandidate),
        );
        if (info.type !== "File")
          return yield* failure("Configured project path must resolve to a regular file");
        return canonicalCandidate;
      });
    };

    const resolveAuthTemplates = (
      state: PersistedStackState,
    ): Effect.Effect<ReadonlyArray<RuntimeAuthTemplate>, StackPreparationError> =>
      Effect.gen(function* () {
        const auth = settingsFor(state, "auth");
        const email = isRecord(auth) && isRecord(auth.email) ? auth.email : {};
        const result: RuntimeAuthTemplate[] = [];
        const ids = new Set<string>();
        const urls = new Set<string>();
        const add = (id: string, raw: unknown): Effect.Effect<void, StackPreparationError> => {
          if (!isRecord(raw)) return Effect.void;
          const configuredPath = settingValue(state, raw.content_path);
          if (configuredPath.length === 0) return Effect.void;
          if (ids.has(id)) return Effect.fail(failure("Duplicate Auth email template id", { id }));
          const extension = extensionFor(configuredPath);
          const url = `/email/${id}${extension}`;
          if (urls.has(url)) return Effect.fail(failure("Duplicate Auth email URL", { url }));
          return resolveProjectFile(state, configuredPath).pipe(
            Effect.tap((canonicalPath) =>
              Effect.sync(() => {
                ids.add(id);
                urls.add(url);
                result.push({
                  id,
                  path: configuredPath,
                  canonicalPath,
                  extension,
                });
              }),
            ),
            Effect.asVoid,
          );
        };
        if (isRecord(email.template))
          for (const [name, value] of Object.entries(email.template)) yield* add(name, value);
        if (isRecord(email.notification))
          for (const [name, value] of Object.entries(email.notification))
            if (isRecord(value) && value.enabled === true)
              yield* add(`${name}_notification`, value);
        return result;
      });

    const resolveRemoteKeys = (
      issuer: string,
    ): Effect.Effect<ReadonlyArray<unknown>, StackPreparationError> => {
      const fetchJson = options.fetchJson;
      if (fetchJson === undefined)
        return Effect.fail(failure("OIDC discovery requires an injected JSON fetcher"));
      const discoveryUrl = `${issuer.replace(/\/+$/u, "")}/.well-known/openid-configuration`;
      const fetchAt = (
        url: string,
        operation: string,
      ): Effect.Effect<unknown, StackPreparationError> =>
        fetchJson(url).pipe(
          Effect.mapError(() => failure(`${operation} request failed`, { url: safeUrlLabel(url) })),
        );
      return fetchAt(discoveryUrl, "OIDC discovery").pipe(
        Effect.flatMap((value) =>
          decodeJson(value).pipe(
            Effect.mapError(() =>
              failure("OIDC discovery response is invalid", { url: safeUrlLabel(discoveryUrl) }),
            ),
          ),
        ),
        Effect.flatMap((value) =>
          Schema.decodeUnknownEffect(oidcDiscovery)(value).pipe(
            Effect.mapError(() =>
              failure("OIDC discovery response is invalid", { url: safeUrlLabel(discoveryUrl) }),
            ),
          ),
        ),
        Effect.flatMap((discovery) => {
          const jwksUrl = discovery.jwks_uri.trim();
          if (jwksUrl.length === 0)
            return Effect.fail(
              failure("OIDC discovery response does not expose jwks_uri", {
                url: safeUrlLabel(discoveryUrl),
              }),
            );
          return fetchAt(jwksUrl, "OIDC JWKS").pipe(
            Effect.flatMap((value) =>
              decodeJson(value).pipe(
                Effect.mapError(() =>
                  failure("OIDC JWKS response is invalid", { url: safeUrlLabel(jwksUrl) }),
                ),
              ),
            ),
            Effect.flatMap((value) =>
              Schema.decodeUnknownEffect(publicRemoteJwks)(value).pipe(
                Effect.mapError(() =>
                  failure("OIDC JWKS response is invalid", { url: safeUrlLabel(jwksUrl) }),
                ),
              ),
            ),
            Effect.flatMap((jwks) =>
              jwks.keys.length === 0
                ? Effect.fail(
                    failure("OIDC JWKS response contains no keys", { url: safeUrlLabel(jwksUrl) }),
                  )
                : Effect.succeed(jwks.keys),
            ),
          );
        }),
      );
    };

    const resolveAuth = (
      state: PersistedStackState,
    ): Effect.Effect<NonNullable<RuntimeInputMaterial["auth"]>, StackPreparationError> =>
      Effect.gen(function* () {
        const signing = state.definition?.security.jwt.signing;
        let local: ResolvedSigningKeyMaterial | undefined;
        if (signing?.kind === "jwks-file") {
          local = yield* resolveSigningKeyMaterial({
            kind: "jwks-file",
            projectRoot: state.identity.projectRoot,
            path: signing.path,
          }).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.mapError(() =>
              failure("Unable to resolve Auth signing keys", { path: signing.path }),
            ),
          );
        }
        const thirdParty = resolveThirdPartyIssuer(settingsFor(state, "auth"));
        if (!thirdParty.ok)
          return yield* failure("Unable to resolve Auth third-party issuer", {
            provider: thirdParty.provider,
          });
        const remote =
          thirdParty.value === undefined ? [] : yield* resolveRemoteKeys(thirdParty.value.issuer);
        const localPublic = local?.publicKeys ?? [];
        const symmetric =
          signing?.kind === "jwks-file"
            ? []
            : (() => {
                const secret = state.secrets["secret:auth.settings.jwt_secret"]?.value ?? "";
                return secret.length === 0 ? [] : [symmetricJwk(secret)];
              })();
        if (signing?.kind !== "jwks-file" && symmetric.length === 0)
          return yield* failure("Persisted Auth JWT secret is missing");
        const publicKeys = [...remote, ...localPublic, ...symmetric];
        const templates =
          state.definition?.capabilities.auth.enabled === false
            ? []
            : yield* resolveAuthTemplates(state);
        return {
          ...(local === undefined ? {} : { jwtKeys: local.privateKeysJson }),
          jwks: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
            keys: publicKeys,
          }).pipe(Effect.mapError(() => failure("Unable to encode Auth JWKS"))),
          ...(templates.length === 0 ? {} : { templates }),
        };
      });

    const writePoolerTenant = (
      state: PersistedStackState,
      generation: number,
      runtime: "native" | "container",
    ): Effect.Effect<string, StackPreparationError> => {
      if (invalidGeneration(generation)) return Effect.fail(failure("Invalid pooler generation"));
      const password = state.secrets["secret:database.internal.password"]?.value ?? "";
      if (password.length === 0)
        return Effect.fail(failure("Persisted database secret is missing"));
      const settings = settingsFor(state, "pooler");
      const poolMode = settingValue(state, isRecord(settings) ? settings.pool_mode : undefined);
      if (poolMode !== "transaction" && poolMode !== "session")
        return Effect.fail(failure("Persisted Pooler mode is invalid"));
      const tenantId = settingValue(state, isRecord(settings) ? settings.tenant_id : undefined);
      if (tenantId.length === 0)
        return Effect.fail(failure("Persisted Pooler tenant id is missing"));
      const defaultPoolSize = finiteSetting(
        settingValue(state, isRecord(settings) ? settings.default_pool_size : undefined),
      );
      const maxClientConn = finiteSetting(
        settingValue(state, isRecord(settings) ? settings.max_client_conn : undefined),
      );
      if (defaultPoolSize === undefined || maxClientConn === undefined)
        return Effect.fail(failure("Persisted Pooler sizing settings are invalid"));
      const nativeAssignment = state.privatePorts.find(
        (entry) => entry.workloadId === "database:database" && entry.binding === "primary",
      );
      if (runtime === "native" && nativeAssignment === undefined)
        return Effect.fail(failure("Persisted native database assignment is missing"));
      const dbHost = runtime === "container" ? "supabase-database" : "127.0.0.1";
      const dbPort = runtime === "container" ? 5432 : nativeAssignment?.port;
      if (dbPort === undefined)
        return Effect.fail(failure("Persisted native database assignment is missing"));
      const content = poolerTenantScript({
        externalId: tenantId,
        dbHost,
        dbPort,
        dbPassword: password,
        poolMode,
        defaultPoolSize,
        maxClientConn,
      });
      const generationRoot = path.join(poolerRoot, String(generation));
      const target = path.join(generationRoot, "pooler_tenant.exs");
      return Effect.gen(function* () {
        const token = yield* crypto.randomUUIDv4.pipe(
          Effect.mapError(() => failure("Unable to allocate pooler tenant file")),
        );
        const temporary = path.join(generationRoot, `.pooler_tenant.exs.${token}.tmp`);
        return yield* Effect.gen(function* () {
          yield* mapFile(
            generationRoot,
            "create pooler tenant directory",
            fs.makeDirectory(generationRoot, { recursive: true, mode: 0o700 }),
          );
          yield* mapFile(
            generationRoot,
            "secure pooler tenant directory",
            fs.chmod(generationRoot, 0o700),
          );
          yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* mapFile(
                temporary,
                "create pooler tenant file",
                fs.open(temporary, { flag: "w", mode: 0o600 }),
              );
              yield* mapFile(
                temporary,
                "write pooler tenant file",
                file.writeAll(new TextEncoder().encode(content)),
              );
              yield* mapFile(temporary, "sync pooler tenant file", file.sync);
            }),
          );
          yield* mapFile(temporary, "secure pooler tenant file", fs.chmod(temporary, 0o600));
          yield* mapFile(target, "publish pooler tenant file", fs.rename(temporary, target));
          yield* mapFile(target, "secure published pooler tenant file", fs.chmod(target, 0o600));
          return target;
        }).pipe(
          Effect.ensuring(
            fs
              .remove(temporary, { force: true })
              .pipe(Effect.catchTag("PlatformError", () => Effect.void)),
          ),
        );
      });
    };

    const joinExit = <A, E>(result: Exit.Exit<A, E>): Effect.Effect<A, E> =>
      Exit.isSuccess(result) ? Effect.succeed(result.value) : Effect.failCause(result.cause);
    type OwnedResult<A> = Deferred.Deferred<Exit.Exit<A, StackPreparationError>, never>;
    const commonPending = new Map<string, OwnedResult<RuntimeInputMaterial>>();
    const commonCompleted = new Map<string, RuntimeInputMaterial>();
    const poolerPending = new Map<string, OwnedResult<string>>();
    const poolerCompleted = new Map<string, string>();
    const keyFor = (state: PersistedStackState, generation: number): string =>
      `${state.identity.projectRoot}\u0000${state.inputFingerprint ?? ""}\u0000${state.runtime.kind}\u0000${generation}`;

    const materializeCommon = (
      state: PersistedStackState,
    ): Effect.Effect<RuntimeInputMaterial, StackPreparationError> =>
      Effect.gen(function* () {
        const jwtConsumers = ["rest", "auth", "realtime", "storage", "functions"] as const;
        const resolvesAuthMaterial = jwtConsumers.some(
          (capability) => state.definition?.capabilities[capability].enabled !== false,
        );
        const auth = resolvesAuthMaterial ? yield* resolveAuth(state) : undefined;
        const analyticsSettings = settingsFor(state, "analytics");
        const gcpPath = isRecord(analyticsSettings)
          ? settingValue(state, analyticsSettings.gcp_jwt_path)
          : "";
        const analytics =
          state.definition?.capabilities.analytics.enabled === false || gcpPath.length === 0
            ? undefined
            : { gcpJwtPath: yield* resolveProjectFile(state, gcpPath) };
        const functions =
          state.definition?.capabilities.functions.enabled === false
            ? undefined
            : { secrets: yield* resolveFunctionsEdgeRuntimeSecrets(state) };
        return {
          ...(auth === undefined ? {} : { auth }),
          ...(analytics === undefined ? {} : { analytics }),
          ...(functions === undefined ? {} : { functions }),
        };
      });

    const singleFlight = <A>(
      key: string,
      pending: Map<string, OwnedResult<A>>,
      completed: Map<string, A>,
      materialize: Effect.Effect<A, StackPreparationError>,
    ): Effect.Effect<A, StackPreparationError> =>
      Effect.gen(function* () {
        const result = yield* Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            type Admission =
              | { readonly kind: "ready"; readonly value: A }
              | { readonly kind: "waiting"; readonly deferred: OwnedResult<A> };
            const owned = yield* admission.withPermit(
              Effect.gen(function* () {
                const ready = completed.get(key);
                if (ready !== undefined) return { kind: "ready", value: ready } satisfies Admission;
                const current = pending.get(key);
                if (current !== undefined)
                  return { kind: "waiting", deferred: current } satisfies Admission;
                const deferred = yield* Deferred.make<Exit.Exit<A, StackPreparationError>, never>();
                pending.set(key, deferred);
                const owner = execution
                  .withPermit(
                    Effect.gen(function* () {
                      const stillCurrent = yield* admission.withPermit(
                        Effect.sync(() => pending.get(key) === deferred),
                      );
                      if (!stillCurrent)
                        return yield* failure("Runtime input generation was invalidated");
                      return yield* materialize;
                    }),
                  )
                  .pipe(
                    Effect.onExit((exit) =>
                      Effect.uninterruptible(
                        Effect.gen(function* () {
                          yield* admission.withPermit(
                            Effect.sync(() => {
                              if (pending.get(key) !== deferred) return;
                              pending.delete(key);
                              if (Exit.isSuccess(exit)) completed.set(key, exit.value);
                            }),
                          );
                          yield* Deferred.succeed(deferred, exit);
                        }),
                      ),
                    ),
                  );
                yield* FiberSet.run(ownedFibers, owner, { startImmediately: true });
                return { kind: "waiting", deferred } satisfies Admission;
              }),
            );
            return owned.kind === "ready"
              ? Exit.succeed(owned.value)
              : yield* restore(Deferred.await(owned.deferred));
          }),
        );
        return yield* joinExit(result);
      });

    const resolve = (
      state: PersistedStackState,
      generation: number,
      options: Readonly<{ readonly includePooler?: boolean }> = {},
    ): Effect.Effect<RuntimeInputMaterial, StackPreparationError> =>
      Effect.gen(function* () {
        const key = keyFor(state, generation);
        const common = yield* singleFlight(
          key,
          commonPending,
          commonCompleted,
          materializeCommon(state),
        );
        if (
          options.includePooler !== true ||
          state.definition?.capabilities.pooler.enabled !== true
        )
          return common;
        const tenantPath = yield* singleFlight(
          key,
          poolerPending,
          poolerCompleted,
          writePoolerTenant(state, generation, state.runtime.kind),
        );
        return { ...common, pooler: { tenantPath } };
      });

    const cleanupGeneration = (generation: number): Effect.Effect<void, StackPreparationError> =>
      invalidGeneration(generation)
        ? Effect.fail(failure("Invalid pooler generation"))
        : execution.withPermit(
            Effect.gen(function* () {
              yield* admission.withPermit(
                Effect.sync(() => {
                  for (const key of poolerPending.keys())
                    if (key.endsWith(`\u0000${generation}`)) poolerPending.delete(key);
                  for (const key of poolerCompleted.keys())
                    if (key.endsWith(`\u0000${generation}`)) poolerCompleted.delete(key);
                }),
              );
              yield* mapFile(
                path.join(poolerRoot, String(generation)),
                "clean pooler tenant generation",
                fs.remove(path.join(poolerRoot, String(generation)), {
                  recursive: true,
                  force: true,
                }),
              );
            }),
          );
    const cleanupAll = execution.withPermit(
      Effect.gen(function* () {
        yield* admission.withPermit(
          Effect.sync(() => {
            commonPending.clear();
            commonCompleted.clear();
            poolerPending.clear();
            poolerCompleted.clear();
          }),
        );
        yield* mapFile(
          poolerRoot,
          "clean pooler tenant files",
          fs.remove(poolerRoot, { recursive: true, force: true }),
        );
      }),
    );

    return {
      resolve,
      resolveProjectFile,
      resolveAuthTemplates,
      cleanupGeneration,
      cleanupAll,
    };
  });
