import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, FileSystem, Option, Path, Schema } from "effect";
import { AuthModule } from "../model/capabilities/auth.ts";
import { StackIdSchema } from "../public/StackId.ts";
import { ServiceInstanceIdSchema } from "../public/ServiceInstanceId.ts";
import { StackPreparationError } from "../public/Errors.ts";
import { PersistedServiceInstanceSchema } from "../model/ServiceRegistry.ts";
import type { PersistedServiceInstance } from "../model/ServiceRegistry.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { makeRuntimeInputOwner } from "./RuntimeInputOwner.ts";

const stackId = StackIdSchema.make("f".repeat(64));

const stateFor = (root: string): PersistedStackState => ({
  format: "supabase-stack-state-v2",
  identity: { projectRoot: root, branchContext: "test", stackName: "runtime-input-owner" },
  runtime: { kind: "native" },
  preparation: "on-demand",
  security: {
    jwt: {
      issuer: null,
      expirySeconds: 3600,
      signing: { kind: "symmetric", secret: { slot: "secret:auth.jwt" } },
    },
  },
  listeners: {},
  registry: { initialized: true, instances: [], defaultInstanceIds: {} },
  ports: [],
  privatePorts: [],
  secrets: { "secret:auth.jwt": { policy: "managed", value: "auth-jwt" } },
});

const errorOf = <E>(exit: Exit.Exit<unknown, E>): E | undefined =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

const authInstance = (id: string, settings: unknown): PersistedServiceInstance =>
  Schema.decodeUnknownSync(PersistedServiceInstanceSchema)({
    id: ServiceInstanceIdSchema.make(id),
    service: "auth",
    intent: "stopped",
    dependencies: { database: ServiceInstanceIdSchema.make("database") },
    resources: {},
    revisions: { config: 0, intent: 0 },
    pendingOperation: null,
    initialization: null,
    initializationInputs: null,
    data: { origin: "absent" },
    config: {
      enabled: true,
      activation: "eager",
      idleTimeoutSeconds: false,
      version: "test",
      settings,
      endpoints: {},
    },
  });

const authSettings = (issuer: string, templatePath?: string) =>
  nullify({
    ...AuthModule.defaultSettings,
    email: {
      ...AuthModule.defaultSettings.email,
      template:
        templatePath === undefined
          ? {}
          : { confirm: { subject: "Confirm", content_path: templatePath } },
    },
    third_party: {
      ...AuthModule.defaultSettings.third_party,
      workos: { enabled: true, issuer_url: issuer },
    },
  });

const serviceInstance = (
  id: string,
  service: "functions" | "studio",
  enabled: boolean,
  settings: unknown,
): PersistedServiceInstance =>
  Schema.decodeUnknownSync(PersistedServiceInstanceSchema)({
    id: ServiceInstanceIdSchema.make(id),
    service,
    intent: "stopped",
    dependencies:
      service === "studio"
        ? {
            database: ServiceInstanceIdSchema.make("database-default"),
            rest: ServiceInstanceIdSchema.make("rest-default"),
            analytics: ServiceInstanceIdSchema.make("analytics-default"),
          }
        : {},
    resources: {},
    revisions: { config: 0, intent: 0 },
    pendingOperation: null,
    initialization: null,
    initializationInputs: null,
    data: { origin: "absent" },
    config: {
      enabled,
      activation: "lazy",
      idleTimeoutSeconds: false,
      version: "test",
      settings,
      endpoints: {},
    },
  });

const nullify = (value: unknown): unknown => {
  if (value === undefined) return null;
  if (Array.isArray(value)) return value.map(nullify);
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, nullify(entry)]));
  return value;
};

const analyticsBackend = "postgres" as const;
const analyticsSettings = {
  backend: analyticsBackend,
  gcp_project_id: "local",
  gcp_project_number: "0",
  gcp_jwt_path: "",
  api_key: { slot: "secret:analytics.api_key" },
};

describe("runtime input owner", () => {
  it.live("resolves a contained regular file and rejects escapes, symlinks, and directories", () =>
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
      const state = stateFor(root);
      const canonicalRoot = yield* fs.realPath(root);
      expect(yield* owner.resolveProjectFile(state, "nested/config.json")).toBe(
        path.join(canonicalRoot, "nested", "config.json"),
      );
      for (const configured of ["/etc/passwd", "../outside.json", "linked.json"] as const) {
        const result = yield* owner.resolveProjectFile(state, configured).pipe(Effect.exit);
        expect(Exit.isFailure(result)).toBe(true);
      }
      const directory = yield* owner.resolveProjectFile(state, "nested").pipe(Effect.exit);
      expect(Exit.isFailure(directory)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("rejects a missing configured project file with a typed preparation error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-missing-" });
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
      const result = yield* owner
        .resolveProjectFile(stateFor(root), "missing.json")
        .pipe(Effect.exit);
      const error = errorOf(result);
      expect(error).toMatchObject({ _tag: "StackPreparationError" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("resolves Functions secrets for instance-qualified workloads", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-functions-" });
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
      const base = stateFor(root);
      const instanceId = ServiceInstanceIdSchema.make("functions-extra");
      const state: PersistedStackState = {
        ...base,
        registry: {
          initialized: true,
          defaultInstanceIds: { functions: instanceId },
          instances: [
            {
              id: instanceId,
              service: "functions",
              intent: "stopped",
              dependencies: {},
              resources: {},
              revisions: { config: 0, intent: 0 },
              pendingOperation: null,
              initialization: null,
              initializationInputs: null,
              data: { origin: "absent" },
              config: {
                enabled: true,
                activation: "eager",
                idleTimeoutSeconds: false,
                version: "test",
                settings: {
                  functions_root: root,
                  edge_runtime: {
                    policy: null,
                    deno_version: null,
                    verify_jwt_default: null,
                    import_map_default: null,
                    secrets: { CUSTOM_TOKEN: { slot: "secret:functions.token" } },
                  },
                  inspector: null,
                  functions: null,
                },
                endpoints: {},
              },
            },
          ],
        },
        secrets: {
          "secret:functions.token": { policy: "managed", value: "token-value" },
        },
      };
      const material = yield* owner.resolve(state, instanceId, `${instanceId}:edge-runtime`);
      expect(material.functions?.secrets).toEqual({ CUSTOM_TOKEN: "token-value" });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("uses the default Functions root for Studio without changing instance roots", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-studio-" });
      const defaultFunctionsRoot = pathJoin(root, "default-functions");
      const extraFunctionsRoot = pathJoin(root, "extra-functions");
      const studioRoot = pathJoin(root, "studio");
      const functionsSettings = (functionsRoot: string) => ({
        functions_root: functionsRoot,
        edge_runtime: {
          policy: null,
          deno_version: null,
          verify_jwt_default: null,
          import_map_default: null,
          secrets: {},
        },
        inspector: null,
        functions: null,
      });
      const defaultFunctions = serviceInstance(
        "functions-default",
        "functions",
        true,
        functionsSettings(defaultFunctionsRoot),
      );
      const extraFunctions = serviceInstance(
        "functions-extra",
        "functions",
        true,
        functionsSettings(extraFunctionsRoot),
      );
      const studio = serviceInstance("studio-default", "studio", true, {
        api_url: "",
        openai_api_key: null,
      });
      const state: PersistedStackState = {
        ...stateFor(root),
        registry: {
          initialized: true,
          defaultInstanceIds: { functions: defaultFunctions.id, studio: studio.id },
          instances: [defaultFunctions, extraFunctions, studio],
        },
      };
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });

      yield* owner.resolve(state, studio.id, `${studio.id}:studio`);
      expect(yield* fs.exists(defaultFunctionsRoot)).toBe(true);
      expect(yield* fs.exists(studioRoot)).toBe(false);

      yield* owner.resolve(state, extraFunctions.id, `${extraFunctions.id}:edge-runtime`);
      expect(yield* fs.exists(extraFunctionsRoot)).toBe(true);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("resolves Auth issuer and templates for the requested instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-auth-" });
      yield* fs.writeFileString(pathJoin(root, "one.html"), "one");
      yield* fs.writeFileString(pathJoin(root, "two.html"), "two");
      const first = authInstance("auth-one", authSettings("https://issuer.one.test", "one.html"));
      const second = authInstance("auth-two", authSettings("https://issuer.two.test", "two.html"));
      const base = stateFor(root);
      const state: PersistedStackState = {
        ...base,
        registry: {
          initialized: true,
          defaultInstanceIds: { auth: first.id },
          instances: [first, second],
        },
      };
      const requestedUrls: string[] = [];
      const fetchJson = (url: string) =>
        Effect.sync(() => {
          requestedUrls.push(url);
          if (url.includes("issuer.one")) return { jwks_uri: "https://jwks.one.test/keys" };
          if (url.includes("issuer.two")) return { jwks_uri: "https://jwks.two.test/keys" };
          if (url.includes("jwks.one")) return { keys: [{ kid: "one" }] };
          return { keys: [{ kid: "two" }] };
        });
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId, fetchJson });
      const secondMaterial = yield* owner.resolve(state, second.id, `${second.id}:auth`);
      const firstMaterial = yield* owner.resolve(state, first.id, `${first.id}:auth`);
      const secondJwks = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        secondMaterial.auth?.jwks ?? "{}",
      );
      const firstJwks = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        firstMaterial.auth?.jwks ?? "{}",
      );
      expect(secondJwks).toMatchObject({ keys: expect.arrayContaining([{ kid: "two" }]) });
      expect(firstJwks).toMatchObject({ keys: expect.arrayContaining([{ kid: "one" }]) });
      expect(secondMaterial.auth?.templates?.[0]?.path).toBe("two.html");
      expect(firstMaterial.auth?.templates?.[0]?.path).toBe("one.html");
      expect(requestedUrls.filter((url) => url.includes("issuer.one"))).toHaveLength(1);
      expect(requestedUrls.filter((url) => url.includes("issuer.two"))).toHaveLength(1);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("keeps shared materialization alive when its creator waiter is interrupted", () =>
    Effect.gen(function* () {
      const root = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "runtime-input-singleflight-",
      });
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const fetchJson = (url: string) =>
        Effect.gen(function* () {
          calls += 1;
          if (url.includes("issuer.singleflight")) {
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            return { jwks_uri: "https://jwks.singleflight.test/keys" } as unknown;
          }
          return { keys: [{ kid: "singleflight" }] } as unknown;
        });
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId, fetchJson });
      const instance = authInstance(
        "auth-singleflight",
        authSettings("https://issuer.singleflight.test"),
      );
      const base = stateFor(root);
      const state: PersistedStackState = {
        ...base,
        registry: {
          initialized: true,
          defaultInstanceIds: { auth: instance.id },
          instances: [instance],
        },
      };
      const creator = yield* Effect.forkChild(
        owner.resolve(state, instance.id, `${instance.id}:auth`),
        { startImmediately: true },
      );
      yield* Deferred.await(started);
      const joiner = yield* Effect.forkChild(
        owner.resolve(state, instance.id, `${instance.id}:auth`),
        { startImmediately: true },
      );
      yield* Fiber.interrupt(creator);
      yield* Deferred.succeed(release, undefined);
      const joined = yield* Fiber.join(joiner);
      expect(joined.auth?.jwks).toContain("singleflight");
      expect(calls).toBe(2);
      const cached = yield* owner.resolve(state, instance.id, `${instance.id}:auth`);
      expect(cached.auth?.jwks).toBe(joined.auth?.jwks);
      expect(calls).toBe(2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("removes a synchronously failed materialization so the next resolve retries", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-retry-" });
      const instance = authInstance("auth-retry", authSettings("https://issuer.retry.test"));
      const base = stateFor(root);
      const state: PersistedStackState = {
        ...base,
        registry: {
          initialized: true,
          defaultInstanceIds: { auth: instance.id },
          instances: [instance],
        },
      };
      let shouldFail = true;
      const fetchJson = (url: string) => {
        if (shouldFail) {
          shouldFail = false;
          return Effect.fail(new StackPreparationError({ message: "synthetic discovery failure" }));
        }
        return Effect.succeed(
          url.includes("issuer.retry")
            ? { jwks_uri: "https://jwks.retry.test/keys" }
            : { keys: [{ kid: "retry" }] },
        );
      };
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId, fetchJson });
      const first = yield* owner
        .resolve(state, instance.id, `${instance.id}:auth`)
        .pipe(Effect.exit);
      expect(errorOf(first)).toMatchObject({ _tag: "StackPreparationError" });
      const retried = yield* owner.resolve(state, instance.id, `${instance.id}:auth`);
      expect(retried.auth?.jwks).toContain("retry");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.live("writes Vector config under the requested analytics instance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-vector-" });
      const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
      const base = stateFor(root);
      const instanceId = ServiceInstanceIdSchema.make("analytics-extra");
      const state: PersistedStackState = {
        ...base,
        registry: {
          initialized: true,
          defaultInstanceIds: { analytics: instanceId },
          instances: [
            {
              id: instanceId,
              service: "analytics",
              intent: "stopped",
              dependencies: { database: ServiceInstanceIdSchema.make("database") },
              resources: {},
              revisions: { config: 0, intent: 0 },
              pendingOperation: null,
              initialization: null,
              initializationInputs: null,
              data: { origin: "absent" },
              config: {
                enabled: true,
                activation: "lazy",
                idleTimeoutSeconds: false,
                version: "test",
                settings: analyticsSettings,
                endpoints: {},
              },
            },
          ],
        },
        privatePorts: [
          {
            instanceId,
            workloadId: `${instanceId}:vector`,
            binding: "primary",
            port: 18_000,
          },
        ],
      };
      const material = yield* owner.resolve(state, instanceId, `${instanceId}:vector`);
      const expected = path.join(
        root,
        stackId,
        "runtime",
        "instances",
        instanceId,
        "inputs",
        "vector",
        "vector.yaml",
      );
      expect(material.analytics?.vectorConfigPath).toBe(expected);
      expect(yield* fs.readFileString(expected)).toContain("supabase-stack-vector");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

const pathJoin = (root: string, file: string): string => `${root}/${file}`;
