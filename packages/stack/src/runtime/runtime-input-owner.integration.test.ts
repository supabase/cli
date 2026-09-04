import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Option,
  Path,
  Redacted,
  Scope,
} from "effect";
import { generateKeyPairSync } from "node:crypto";
import { compileStack, type CompiledStack } from "../model/Compiler.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import { containerAliasFor } from "../model/WorkloadCatalog.ts";
import { makeRuntimeInputOwner } from "./RuntimeInputOwner.ts";
import { resolveContainerResolutionFor } from "./WorkloadRuntimeSpec.ts";

const stackId = StackIdSchema.make("f".repeat(64));

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const identityFor = (projectRoot: string): PersistedStackState["identity"] => ({
  stackId,
  projectRoot,
  checkoutRoot: projectRoot,
  workspaceId: projectRoot,
  checkoutId: projectRoot,
  branchContext: "ordinary-workspace",
  localProjectKey: ".",
  stackName: "runtime-input-owner",
});

const stateFor = (
  root: string,
  compiled: CompiledStack,
  secrets: PersistedStackState["secrets"],
  runtime: StackRuntime = { kind: "native" },
): PersistedStackState => ({
  format: "supabase-stack-state-v1",
  identity: identityFor(root),
  runtime,
  desiredLifecycle: "stopped",
  definition: compiled.definition,
  ports: [],
  privatePorts: [],
  secrets,
});

const compiledState = (root: string, config: Parameters<typeof compileStack>[0]["config"] = {}) =>
  Effect.gen(function* () {
    const compiled = yield* compileStack({
      projectRoot: root,
      runtime: { kind: "native" },
      config,
    });
    const resolved = yield* resolveSecrets(
      { declarations: compiled.secrets },
      undefined,
      "stopped",
    );
    return stateFor(root, compiled, resolved.persisted);
  });

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

describe("runtime input owner", () => {
  it.live("resolves contained regular files and rejects escapes, symlinks, and directories", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-files-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-outside-" });
        yield* fs.makeDirectory(path.join(root, "nested"), { recursive: true });
        yield* fs.writeFileString(path.join(root, "nested", "config.json"), "{}");
        yield* fs.writeFileString(path.join(outside, "secret.json"), "secret");
        yield* fs.symlink(path.join(outside, "secret.json"), path.join(root, "linked.json"));
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const state = yield* compiledState(root);
        const canonicalRoot = yield* fs.realPath(root);
        expect(yield* owner.resolveProjectFile(state, "nested/config.json")).toBe(
          path.join(canonicalRoot, "nested", "config.json"),
        );
        for (const configured of ["/etc/passwd", "../outside.json", "linked.json"] as const) {
          const failed = yield* owner.resolveProjectFile(state, configured).pipe(Effect.exit);
          expect(Exit.isFailure(failed)).toBe(true);
        }
        const directory = yield* owner.resolveProjectFile(state, "nested").pipe(Effect.exit);
        expect(Exit.isFailure(directory)).toBe(true);
      }),
    ),
  );

  it.live("returns all private local keys and a public-only JWKS", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-jwks-" });
        const first = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          format: "jwk",
        });
        const second = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
          format: "jwk",
        });
        yield* fs.writeFileString(
          path.join(root, "keys.json"),
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- dynamic JWK fixture JSON
          JSON.stringify([
            { ...first, alg: "ES256", kid: "ec-key" },
            { ...second, alg: "RS256", kid: "rsa-key" },
          ]),
        );
        const base = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: {
                  workos: { enabled: true, issuer_url: "https://issuer.example" },
                },
              },
            },
          },
        });
        if (base.definition === undefined) return yield* Effect.die("compiled definition missing");
        const state: PersistedStackState = {
          ...base,
          definition: {
            ...base.definition,
            security: {
              ...base.definition.security,
              jwt: {
                ...base.definition.security.jwt,
                signing: { kind: "jwks-file", path: "keys.json" },
              },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) =>
            Effect.succeed(
              url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] },
            ),
        });
        const material = yield* owner.resolve(state, "auth:auth");
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- inspect generated JWT fixture
        expect(JSON.parse(material.auth?.jwtKeys ?? "[]")).toHaveLength(2);
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- inspect generated JWKS fixture
        const jwks = JSON.parse(material.auth?.jwks ?? "{}");
        expect(jwks.keys).toHaveLength(3);
        expect(jwks.keys.every((key: Record<string, unknown>) => !Object.hasOwn(key, "d"))).toBe(
          true,
        );
      }),
    ),
  );

  it.live("rejects a JWKS file when any configured key is invalid", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-jwks-invalid-" });
        const valid = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({
          format: "jwk",
        });
        yield* fs.writeFileString(
          path.join(root, "keys.json"),
          // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- dynamic JWK fixture JSON
          JSON.stringify([
            { ...valid, alg: "ES256" },
            { kty: "EC", alg: "ES256", d: "bad" },
          ]),
        );
        const base = yield* compiledState(root);
        if (base.definition === undefined) return yield* Effect.die("compiled definition missing");
        const state: PersistedStackState = {
          ...base,
          definition: {
            ...base.definition,
            security: {
              ...base.definition.security,
              jwt: {
                ...base.definition.security.jwt,
                signing: { kind: "jwks-file", path: "keys.json" },
              },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const failed = yield* owner.resolve(state, "auth:auth").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
      }),
    ),
  );

  it.live("merges injected third-party keys with the canonical symmetric key", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-oidc-" });
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { firebase: { enabled: true, project_id: "demo" } },
              },
            },
          },
        });
        const requested: string[] = [];
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) =>
            Effect.sync(() => {
              requested.push(url);
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            }),
        });
        const material = yield* owner.resolve(state, "auth:auth");
        expect(requested).toEqual([
          "https://securetoken.google.com/demo/.well-known/openid-configuration",
          "https://issuer.example/keys",
        ]);
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- inspect generated JWKS fixture
        expect(JSON.parse(material.auth?.jwks ?? "{}").keys).toHaveLength(2);
      }),
    ),
  );

  it.live("publishes the persisted symmetric JWT secret as an oct JWK", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-symmetric-",
        });
        const state = yield* compiledState(root, {
          capabilities: {
            auth: { settings: { jwt_secret: Redacted.make("symmetric-secret") } },
          },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- inspect generated JWKS fixture
        const jwks = JSON.parse((yield* owner.resolve(state, "auth:auth")).auth?.jwks ?? "{}");
        expect(jwks.keys).toEqual([
          {
            kty: "oct",
            alg: "HS256",
            use: "sig",
            key_ops: ["verify"],
            k: "c3ltbWV0cmljLXNlY3JldA",
          },
        ]);
      }),
    ),
  );

  it.live("skips JWT file and OIDC resolution when every JWT consumer is disabled", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-no-jwt-" });
        const base = yield* compiledState(root);
        if (base.definition === undefined) return yield* Effect.die("compiled definition missing");
        const definition = base.definition;
        const state: PersistedStackState = {
          ...base,
          definition: {
            ...definition,
            capabilities: {
              ...definition.capabilities,
              rest: { ...definition.capabilities.rest, enabled: false },
              auth: { ...definition.capabilities.auth, enabled: false },
              realtime: { ...definition.capabilities.realtime, enabled: false },
              storage: { ...definition.capabilities.storage, enabled: false },
              functions: { ...definition.capabilities.functions, enabled: false },
            },
            security: {
              ...definition.security,
              jwt: {
                ...definition.security.jwt,
                signing: { kind: "jwks-file", path: "missing.json" },
              },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: () => Effect.die("OIDC fetch should not run"),
        });
        const material = yield* owner.resolve(state, "auth:auth");
        expect(material.auth).toBeUndefined();
      }),
    ),
  );

  it.live("resolves only material needed by the requested workload", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-workload-scope-",
        });
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: {
                  workos: { enabled: true, issuer_url: "https://issuer.example" },
                },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: () => Effect.fail(new StackPreparationError({ message: "OIDC unavailable" })),
        });
        const database = yield* owner.resolve(state, "database:database");
        expect(database.auth).toBeUndefined();
        const auth = yield* owner.resolve(state, "auth:auth").pipe(Effect.exit);
        expect(Exit.isFailure(auth)).toBe(true);
      }),
    ),
  );

  it.live("creates the configured Functions root only for mounted workloads", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-functions-root-" });
        const compiled = yield* compileStack({
          projectRoot: root,
          runtime: { kind: "container", engine: "docker" },
          config: {
            capabilities: {
              functions: { enabled: true },
              studio: { enabled: true },
            },
          },
        });
        const resolved = yield* resolveSecrets(
          { declarations: compiled.secrets },
          undefined,
          "stopped",
        );
        const state = stateFor(root, compiled, resolved.persisted, {
          kind: "container",
          engine: "docker",
        });
        const withPrivatePorts: PersistedStackState = {
          ...state,
          privatePorts: [
            { workloadId: "database:database", binding: "primary", port: 30_001 },
            { workloadId: "functions:edge-runtime", binding: "primary", port: 30_002 },
            { workloadId: "studio:studio", binding: "primary", port: 30_003 },
          ],
        };
        const functionsRoot = compiled.definition?.capabilities.functions.settings.functions_root;
        if (functionsRoot === undefined || functionsRoot === null)
          return yield* Effect.die("Compiled Functions root is missing");
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        yield* owner.resolve(withPrivatePorts, "database:database");
        expect(yield* fs.exists(functionsRoot)).toBe(false);

        const functionsMaterial = yield* owner.resolve(withPrivatePorts, "functions:edge-runtime");
        const functions = compiled.executionPlan.workloads.find(
          ({ id }) => id === "functions:edge-runtime",
        );
        if (functions === undefined) return yield* Effect.die("Functions workload is missing");
        const functionsResolution = yield* resolveContainerResolutionFor(
          withPrivatePorts,
          functions,
          functionsMaterial,
        );
        expect(yield* fs.exists(functionsRoot)).toBe(true);
        expect(functionsResolution?.mounts[0]?.source).toBe(functionsRoot);

        yield* fs.remove(functionsRoot, { recursive: true, force: true });
        expect(yield* fs.exists(functionsRoot)).toBe(false);
        const studioMaterial = yield* owner.resolve(withPrivatePorts, "studio:studio");
        const studio = compiled.executionPlan.workloads.find(({ id }) => id === "studio:studio");
        if (studio === undefined) return yield* Effect.die("Studio workload is missing");
        const studioResolution = yield* resolveContainerResolutionFor(
          withPrivatePorts,
          studio,
          studioMaterial,
        );
        expect(yield* fs.exists(functionsRoot)).toBe(true);
        expect(studioResolution?.mounts[0]?.source).toBe(functionsRoot);
      }),
    ),
  );

  it.live("resolves JWT material when Auth is disabled but Rest remains enabled", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-rest-jwt-",
        });
        const base = yield* compiledState(root);
        if (base.definition === undefined) return yield* Effect.die("compiled definition missing");
        const state: PersistedStackState = {
          ...base,
          definition: {
            ...base.definition,
            capabilities: {
              ...base.definition.capabilities,
              auth: { ...base.definition.capabilities.auth, enabled: false },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, "rest:rest");
        expect(material.auth?.jwks).toContain('"kty":"oct"');
      }),
    ),
  );

  it.live("sanitizes OIDC URL labels in transport failures", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-oidc-secret-",
        });
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: {
                  workos: {
                    enabled: true,
                    issuer_url: "https://issuer.example/tenant?token=secret-token#fragment",
                  },
                },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: () => Effect.fail(new StackPreparationError({ message: "transport failure" })),
        });
        const failed = yield* owner.resolve(state, "auth:auth").pipe(Effect.exit);
        const error = errorOf(failed);
        expect(error?.message).toContain("OIDC discovery request failed");
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assert sanitized diagnostic payload
        expect(JSON.stringify(error)).not.toContain("secret-token");
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- assert sanitized diagnostic payload
        expect(JSON.stringify(error)).not.toContain("fragment");
      }),
    ),
  );

  it.live("fails closed on malformed or empty third-party OIDC responses", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-oidc-invalid-" });
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) =>
            Effect.succeed(
              url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [] },
            ),
        });
        const failed = yield* owner.resolve(state, "auth:auth").pipe(Effect.exit);
        expect(errorOf(failed)?.message).toContain("contains no keys");
      }),
    ),
  );

  it.live("writes a session-scoped owner-only Pooler tenant file and cleans it", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-pooler-" });
        const state = yield* compiledState(root, {
          capabilities: {
            analytics: { settings: { vector_port: 9001 } },
            pooler: { enabled: true, settings: { pool_mode: "session" } },
          },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const nativeState: PersistedStackState = {
          ...state,
          privatePorts: [
            { workloadId: "database:database", binding: "primary", port: 30_001 },
            { workloadId: "analytics:vector", binding: "primary", port: 30_008 },
          ],
        };
        const first = yield* owner.resolve(nativeState, "pooler:pooler");
        const second = yield* owner.resolve(nativeState, "pooler:pooler");
        const tenant = first.pooler?.tenantPath;
        expect(second.pooler?.tenantPath).toBe(tenant);
        expect(tenant).toBeDefined();
        expect((yield* fs.stat(tenant!)).mode & 0o777).toBe(0o600);
        const content = yield* fs.readFileString(tenant!);
        expect(content).toContain('"db_host" => "127.0.0.1"');
        expect(content).toContain('"external_id" => "pooler-dev"');
        expect(content).toContain('"db_port" => 30001');
        expect(content).not.toContain('"db_password" => ""');
        const analytics = yield* owner.resolve(nativeState, "analytics:vector");
        expect(analytics.analytics?.vectorConfigPath).toBeDefined();
        yield* owner.cleanupAll;
        expect(yield* fs.exists(path.dirname(tenant!))).toBe(false);
        expect(yield* fs.exists(analytics.analytics?.vectorConfigPath ?? "")).toBe(false);
      }),
    ),
  );

  it.live("writes and cleans session-scoped Vector config material", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-vector-" });
        const base = yield* compiledState(root, {
          capabilities: { analytics: { settings: { vector_port: 9001 } } },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const native: PersistedStackState = {
          ...base,
          privatePorts: [{ workloadId: "analytics:vector", binding: "primary", port: 30_008 }],
        };
        const material = yield* owner.resolve(native, "analytics:vector");
        const configPath = material.analytics?.vectorConfigPath;
        expect(configPath).toBeDefined();
        expect(yield* fs.stat(configPath!)).toMatchObject({ type: "File" });
        expect(yield* fs.readFileString(configPath!)).toContain('address: "${VECTOR_API_ADDRESS}"');
        expect(yield* fs.readFileString(configPath!)).toContain("type: demo_logs");
        expect(yield* fs.readFileString(configPath!)).toContain("count: 1");
        expect(yield* fs.readFileString(configPath!)).toContain("type: internal_metrics");
        expect(yield* fs.readFileString(configPath!)).toContain("type: blackhole");
        const config = yield* fs.readFileString(configPath!);
        expect(config).toContain("type: remap");
        expect(config).toContain('.event_message = "supabase-stack-vector"');
        expect(config).toContain("del(.message)");
        expect(config).toContain('uri: "${LOGFLARE_URL}/logs?source_name=postgres.logs"');
        expect(config).toContain('x-api-key: "${LOGFLARE_PRIVATE_ACCESS_TOKEN}"');
        expect(config).toContain("retry_attempts: 5");
        expect(config).toContain("retry_max_duration_secs: 10");
        expect(config).not.toContain('x-api-key: "api-key"');
        yield* owner.cleanupAll;
        expect(yield* fs.exists(path.join(root, stackId, "runtime", "inputs", "vector"))).toBe(
          false,
        );
        const rematerialized = yield* owner.resolve(native, "analytics:vector");
        expect(rematerialized.analytics?.vectorConfigPath).toBeDefined();
        expect(yield* fs.exists(rematerialized.analytics?.vectorConfigPath ?? "")).toBe(true);
      }),
    ),
  );

  it.live("does not recreate cleaned Pooler material for non-Pooler work", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-pooler-lazy-" });
        const state = yield* compiledState(root, {
          capabilities: { pooler: { enabled: true, settings: { pool_mode: "session" } } },
        });
        const nativeState: PersistedStackState = {
          ...state,
          privatePorts: [{ workloadId: "database:database", binding: "primary", port: 30_001 }],
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const first = yield* owner.resolve(nativeState, "pooler:pooler");
        const tenant = first.pooler?.tenantPath;
        expect(tenant).toBeDefined();
        yield* owner.cleanupAll;
        const common = yield* owner.resolve(nativeState, "database:database");
        expect(common.pooler).toBeUndefined();
        expect(yield* fs.exists(path.join(root, stackId, "runtime", "inputs", "pooler"))).toBe(
          false,
        );
        const recreated = yield* owner.resolve(nativeState, "pooler:pooler");
        expect(recreated.pooler?.tenantPath).toBeDefined();
        expect(yield* fs.exists(recreated.pooler?.tenantPath ?? "")).toBe(true);
      }),
    ),
  );

  it.live("renders literal Elixir interpolation and container database endpoint", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({
          prefix: "runtime-input-pooler-container-",
        });
        const base = yield* compiledState(root, {
          capabilities: {
            pooler: {
              enabled: true,
              settings: {
                tenant_id: "tenant-custom",
                pool_mode: "transaction",
              },
            },
          },
        });
        const state = {
          ...base,
          runtime: { kind: "container", engine: "docker" } as const,
          secrets: {
            ...base.secrets,
            "secret:database.internal.password": {
              policy: "managed" as const,
              value: "#{System.halt()}",
            },
          },
        };
        const containerState = state;
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(containerState, "pooler:pooler");
        const tenant = material.pooler?.tenantPath;
        expect(tenant).toBeDefined();
        expect((yield* fs.stat(tenant!)).mode & 0o777).toBe(0o644);
        const content = yield* fs.readFileString(tenant!);
        expect(content).toContain('"external_id" => "tenant-custom"');
        expect(content).toContain(`"db_host" => "${containerAliasFor("database:database")}"`);
        expect(content).toContain('"db_port" => 5432');
        expect(content).toContain("\\#{System.halt()}");
        expect(content).toContain("Supavisor.Repo.preload(existing, :users)");
        expect(content).toContain("Supavisor.Tenants.update_tenant(existing, params)");
      }),
    ),
  );

  it.live("fails native Pooler resolution without the persisted database assignment", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-pooler-no-port-",
        });
        const state = yield* compiledState(root, {
          capabilities: { pooler: { enabled: true, settings: { pool_mode: "session" } } },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const failed = yield* owner.resolve(state, "pooler:pooler").pipe(Effect.exit);
        expect(Exit.isFailure(failed)).toBe(true);
      }),
    ),
  );

  it.live("fails closed when persisted Pooler sizing is missing or blank", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-pooler-sizing-" });
        const base = yield* compiledState(root, {
          capabilities: { pooler: { enabled: true, settings: { pool_mode: "session" } } },
        });
        const native = {
          ...base,
          privatePorts: [{ workloadId: "database:database", binding: "primary", port: 30_001 }],
        };
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- clone dynamic persisted fixture
        const missing = JSON.parse(JSON.stringify(native));
        delete missing.definition.capabilities.pooler.settings.default_pool_size;
        // oxlint-disable-next-line effecttsgo/prefer-schema-over-json -- clone dynamic persisted fixture
        const blank = JSON.parse(JSON.stringify(native));
        blank.definition.capabilities.pooler.settings.default_pool_size = "  ";
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        for (const invalid of [missing, blank]) {
          const failed = yield* owner.resolve(invalid, "pooler:pooler").pipe(Effect.exit);
          expect(errorOf(failed)?.message).toContain("sizing settings are invalid");
          expect(yield* fs.exists(path.join(root, stackId, "runtime", "inputs", "pooler"))).toBe(
            false,
          );
        }
      }),
    ),
  );

  it.live("does not resolve Functions material while provisioning Pooler", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-pooler-invalid-" });
        const state = yield* compiledState(root, {
          capabilities: {
            pooler: { enabled: true },
            functions: {
              enabled: true,
              settings: {
                edge_runtime: { secrets: { SUPABASE_BAD: Redacted.make("x") } },
              },
            },
          },
        });
        const nativeState = {
          ...state,
          privatePorts: [{ workloadId: "database:database", binding: "primary", port: 30_001 }],
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(nativeState, "pooler:pooler");
        expect(material.pooler?.tenantPath).toBeDefined();
        expect(yield* fs.exists(path.join(root, stackId, "runtime", "inputs", "pooler"))).toBe(
          true,
        );
      }),
    ),
  );

  it.live("single-flights cold equivalent resolutions and reuses the completed material", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-single-flight-" });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
              },
            },
            pooler: { enabled: true },
          },
        });
        const native = {
          ...state,
          privatePorts: [{ workloadId: "database:database", binding: "primary", port: 30_001 }],
        };
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) => {
            fetches += 1;
            return Effect.gen(function* () {
              if (fetches === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            });
          },
        });
        const first = yield* Effect.forkChild(owner.resolve(native, "auth:auth"), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(owner.resolve(native, "auth:auth"), {
          startImmediately: true,
        });
        expect(fetches).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const [firstMaterial, secondMaterial] = yield* Effect.all([
          Fiber.join(first),
          Fiber.join(second),
        ]);
        expect(fetches).toBe(2);
        expect(firstMaterial.auth?.jwks).toBe(secondMaterial.auth?.jwks);
        const cached = yield* owner.resolve(native, "auth:auth");
        expect(cached.auth?.jwks).toBe(firstMaterial.auth?.jwks);
        expect(fetches).toBe(2);
      }),
    ),
  );

  it.live("shares OIDC material across JWT-consuming workloads", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-auth-shared-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) => {
            fetches += 1;
            return Effect.gen(function* () {
              if (fetches === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            });
          },
        });
        const rest = yield* Effect.forkChild(owner.resolve(state, "rest:rest"), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const realtime = yield* Effect.forkChild(owner.resolve(state, "realtime:realtime"), {
          startImmediately: true,
        });
        expect(fetches).toBe(1);
        yield* Deferred.succeed(release, undefined);
        const [restMaterial, realtimeMaterial] = yield* Effect.all([
          Fiber.join(rest),
          Fiber.join(realtime),
        ]);
        expect(fetches).toBe(2);
        expect(restMaterial.auth?.jwks).toBe(realtimeMaterial.auth?.jwks);
        expect(restMaterial.analytics).toBeUndefined();
        expect(realtimeMaterial.analytics).toBeUndefined();
        const changedState = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://other.example" } },
              },
            },
          },
        });
        yield* owner.resolve(changedState, "rest:rest");
        expect(fetches).toBe(4);
      }),
    ),
  );

  it.live("keeps the owner alive when an in-flight waiter is interrupted", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-single-flight-interrupt-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) => {
            fetches += 1;
            return Effect.gen(function* () {
              if (fetches === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            });
          },
        });
        const first = yield* Effect.forkChild(owner.resolve(state, "auth:auth"), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const second = yield* Effect.forkChild(owner.resolve(state, "auth:auth"), {
          startImmediately: true,
        });
        expect(fetches).toBe(1);
        yield* Fiber.interrupt(second);
        yield* Deferred.succeed(release, undefined);
        const firstMaterial = yield* Fiber.join(first);
        expect(firstMaterial.auth?.jwks).toContain('"keys"');
        expect(fetches).toBe(2);
        const cached = yield* owner.resolve(state, "auth:auth");
        expect(cached.auth?.jwks).toBe(firstMaterial.auth?.jwks);
        expect(fetches).toBe(2);
      }),
    ),
  );

  it.live("completes materializing and queued owners when their scope closes", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-owner-scope-close-",
        });
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        let fetches = 0;
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                third_party: { workos: { enabled: true, issuer_url: "https://issuer.example" } },
              },
            },
          },
        });
        const ownerScope = yield* Scope.make();
        const owner = yield* makeRuntimeInputOwner({
          stateRoot: root,
          stackId,
          fetchJson: (url) => {
            fetches += 1;
            return Effect.gen(function* () {
              if (fetches === 1) {
                yield* Deferred.succeed(started, undefined);
                yield* Deferred.await(release);
              }
              return url.endsWith("openid-configuration")
                ? { jwks_uri: "https://issuer.example/keys" }
                : { keys: [{ kty: "RSA", n: "n", e: "AQAB" }] };
            });
          },
        }).pipe(Effect.provideService(Scope.Scope, ownerScope));
        const materializing = yield* Effect.forkChild(owner.resolve(state, "auth:auth"), {
          startImmediately: true,
        });
        yield* Deferred.await(started);
        const queued = yield* Effect.forkChild(owner.resolve(state, "auth:auth"), {
          startImmediately: true,
        });
        expect(fetches).toBe(1);
        yield* Scope.close(ownerScope, Exit.void);
        const materializingExit = yield* Fiber.join(materializing).pipe(Effect.exit);
        const queuedExit = yield* Fiber.join(queued).pipe(Effect.exit);
        expect(Exit.isFailure(materializingExit)).toBe(true);
        expect(Exit.isFailure(queuedExit)).toBe(true);
      }),
    ),
  );

  it.live("resolves the configured Analytics service-account file without copying it", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-analytics-" });
        yield* fs.writeFileString(path.join(root, "gcp.json"), "{}");
        const state = yield* compiledState(root, {
          capabilities: { analytics: { settings: { gcp_jwt_path: "gcp.json" } } },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, "analytics:analytics");
        expect(material.analytics?.gcpJwtPath).toBe(
          path.join(yield* fs.realPath(root), "gcp.json"),
        );
      }),
    ),
  );

  it.live("does not resolve disabled capability inputs", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-disabled-",
        });
        const base = yield* compiledState(root);
        if (base.definition === undefined) return yield* Effect.die("compiled definition missing");
        const definition = base.definition;
        const state: PersistedStackState = {
          ...base,
          definition: {
            ...definition,
            capabilities: {
              ...definition.capabilities,
              analytics: {
                ...definition.capabilities.analytics,
                enabled: false,
                settings: {
                  ...definition.capabilities.analytics.settings,
                  gcp_jwt_path: "missing.json",
                },
              },
              functions: {
                ...definition.capabilities.functions,
                enabled: false,
                settings: {
                  ...definition.capabilities.functions.settings,
                  edge_runtime: {
                    policy: null,
                    deno_version: null,
                    verify_jwt_default: null,
                    import_map_default: null,
                    secrets: { SUPABASE_RESERVED: { slot: "missing" } },
                  },
                },
              },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, "analytics:analytics");
        expect(material.analytics).toBeUndefined();
        expect(material.functions).toBeUndefined();
      }),
    ),
  );

  it.live("returns live Auth template mappings and rejects URL id collisions", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-templates-" });
        yield* fs.writeFileString(path.join(root, "confirm.html"), "confirm");
        const state = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                email: {
                  template: { confirm: { content_path: "confirm.html" } },
                },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const canonicalRoot = yield* fs.realPath(root);
        const templates = yield* owner.resolveAuthTemplates(state);
        expect(templates).toEqual([
          {
            id: "confirm",
            path: "confirm.html",
            canonicalPath: path.join(canonicalRoot, "confirm.html"),
            extension: ".html",
          },
        ]);
        const collisionState = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                email: {
                  template: { welcome_notification: { content_path: "confirm.html" } },
                  notification: { welcome: { enabled: true, content_path: "confirm.html" } },
                },
              },
            },
          },
        });
        const failed = yield* owner.resolveAuthTemplates(collisionState).pipe(Effect.exit);
        expect(errorOf(failed)?.message).toContain("Duplicate Auth email template id");
        yield* fs.writeFileString(path.join(root, "welcome"), "welcome");
        const extensionCollisionState = yield* compiledState(root, {
          capabilities: {
            auth: {
              settings: {
                email: {
                  template: {
                    welcome: { content_path: "confirm.html" },
                    "welcome.html": { content_path: "welcome" },
                  },
                },
              },
            },
          },
        });
        const extensionCollision = yield* owner
          .resolveAuthTemplates(extensionCollisionState)
          .pipe(Effect.exit);
        expect(errorOf(extensionCollision)?.message).toContain("Duplicate Auth email URL");
      }),
    ),
  );

  it.live("validates Functions Edge Runtime secrets and returns real names", () =>
    withPlatform(
      Effect.gen(function* () {
        const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
          prefix: "runtime-input-functions-",
        });
        const state = yield* compiledState(root, {
          capabilities: {
            functions: {
              enabled: true,
              settings: {
                edge_runtime: { secrets: { API_TOKEN: Redacted.make("actual-value") } },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, "functions:edge-runtime");
        expect(material.functions?.secrets).toEqual({ API_TOKEN: "actual-value" });
        const invalid = yield* compiledState(root, {
          capabilities: {
            functions: {
              enabled: true,
              settings: {
                edge_runtime: { secrets: { SUPABASE_TOKEN: Redacted.make("value") } },
              },
            },
          },
        });
        const failed = yield* owner.resolve(invalid, "functions:edge-runtime").pipe(Effect.exit);
        expect(errorOf(failed)?.message).toContain("secret name is reserved");
      }),
    ),
  );
});
