import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Context, Crypto, Effect, FileSystem, Path, Redacted } from "effect";
import { compileServiceInstance } from "../model/Compiler.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import {
  AUTH_ANON_KEY_SLOT,
  AUTH_PUBLISHABLE_KEY_SLOT,
  AUTH_SECRET_KEY_SLOT,
  AUTH_SERVICE_ROLE_KEY_SLOT,
} from "../state/SecretStore.ts";
import { projectServiceCredentials, projectStackCredentials } from "./ServiceCredentials.ts";

const withPlatform = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(effect).pipe(Effect.provide(NodeServices.layer));

const stateFor = (
  projectRoot: string,
  instances: PersistedStackState["registry"]["instances"],
  defaults: PersistedStackState["registry"]["defaultInstanceIds"],
  options: {
    readonly api?: boolean;
    readonly ports?: PersistedStackState["ports"];
    readonly secrets?: PersistedStackState["secrets"];
  } = {},
): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: { projectRoot, branchContext: "test", stackName: "credentials" },
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: "test-jwt" } },
    },
  },
  listeners:
    options.api === true ? { api: { enabled: true, address: "127.0.0.1", port: 54321 } } : {},
  registry: { initialized: true, instances, defaultInstanceIds: defaults },
  ports: options.ports ?? [],
  privatePorts: [],
  secrets: {
    "test-jwt": { policy: "managed", value: "jwt-secret" },
    ...options.secrets,
  },
});

describe("service credentials projections", { timeout: 30_000 }, () => {
  it.live("projects shared API credentials for a Functions-only stack", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-credentials-" });
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const functions = yield* compileServiceInstance(
          { service: "functions", config: { activation: "lazy" } },
          { projectRoot: root, path, runtime: { kind: "native" } },
        ).pipe(Effect.provideContext(context));
        const state = stateFor(
          root,
          [functions.instance],
          { functions: functions.id },
          {
            api: true,
            secrets: {
              [AUTH_PUBLISHABLE_KEY_SLOT]: { policy: "managed", value: "publishable" },
              [AUTH_SECRET_KEY_SLOT]: { policy: "managed", value: "secret" },
              [AUTH_ANON_KEY_SLOT]: { policy: "managed", value: "anon" },
              [AUTH_SERVICE_ROLE_KEY_SLOT]: { policy: "managed", value: "service-role" },
            },
          },
        );
        expect(yield* projectServiceCredentials(state, functions.instance)).toEqual({
          publishableKey: "publishable",
          secretKey: "secret",
          anonJwt: "anon",
          serviceRoleJwt: "service-role",
        });
        const stack = yield* projectStackCredentials(state);
        expect(stack.database).toBeUndefined();
        expect(stack.api?.publishableKey).toBe("publishable");
        expect(stack.api?.anonJwt).toBe("anon");
        expect(stack.api === undefined ? undefined : Redacted.value(stack.api.secretKey)).toBe(
          "secret",
        );
        expect(stack.api === undefined ? undefined : Redacted.value(stack.api.serviceRoleJwt)).toBe(
          "service-role",
        );
      }),
    ),
  );

  it.live("projects planned database and optional storage credentials", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-credentials-" });
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const database = yield* compileServiceInstance(
          { service: "database", config: {} },
          { projectRoot: root, path, runtime: { kind: "native" } },
        ).pipe(Effect.provideContext(context));
        if (database.instance.service !== "database") throw new Error("Expected database instance");
        const storage = yield* compileServiceInstance(
          { service: "storage", config: {}, dependencies: { database: database.id } },
          { projectRoot: root, path, runtime: { kind: "native" } },
        ).pipe(Effect.provideContext(context));
        if (storage.instance.service !== "storage") throw new Error("Expected storage instance");
        const databasePassword = database.instance.config.passwordSecretRef;
        const storageSecret = storage.instance.config.settings.s3_protocol?.secret_access_key;
        if (databasePassword === undefined || storageSecret === null || storageSecret === undefined)
          return;
        const state = stateFor(
          root,
          [database.instance, storage.instance],
          { database: database.id, storage: storage.id },
          {
            api: true,
            ports: [
              {
                owner: "stack",
                binding: "api",
                address: "127.0.0.1",
                port: 54321,
                intent: "exact",
              },
              {
                owner: "instance",
                instanceId: database.id,
                binding: "sql",
                address: "127.0.0.1",
                port: 54322,
                intent: "exact",
              },
            ],
            secrets: {
              [databasePassword]: { policy: "managed", value: "db password" },
              [storageSecret.slot]: { policy: "managed", value: "storage secret" },
            },
          },
        );
        const credentials = yield* projectStackCredentials(state);
        expect(credentials.database).toEqual({
          url: Redacted.make("postgresql://postgres:db%20password@127.0.0.1:54322/postgres"),
          password: Redacted.make("db password"),
        });
        expect(credentials.storage).toEqual({
          endpoint: "http://127.0.0.1:54321/storage/v1/s3",
          region: "local",
          accessKeyId: "625729a08b95bf1b7ff351a663f3a23c",
          secretAccessKey: Redacted.make("storage secret"),
        });
      }),
    ),
  );

  it.live("returns no credentials for disabled or incomplete projections", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const crypto = yield* Crypto.Crypto;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-credentials-" });
        const context = Context.make(FileSystem.FileSystem, fs).pipe(
          Context.add(Path.Path, path),
          Context.add(Crypto.Crypto, crypto),
        );
        const functions = yield* compileServiceInstance(
          { service: "functions", config: { enabled: false } },
          { projectRoot: root, path, runtime: { kind: "native" } },
        ).pipe(Effect.provideContext(context));
        const state = stateFor(
          root,
          [functions.instance],
          { functions: functions.id },
          { api: true },
        );
        expect(yield* projectServiceCredentials(state, functions.instance)).toEqual({
          kind: "none",
        });
        expect(yield* projectStackCredentials(state)).toEqual({});
      }),
    ),
  );
});
