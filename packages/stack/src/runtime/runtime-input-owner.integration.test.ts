import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Option, Path, Redacted } from "effect";
import { generateKeyPairSync } from "node:crypto";
import { compileStack, type CompiledStack } from "../model/Compiler.ts";
import { StackIdSchema } from "../public/StackId.ts";
import type { StackRuntime } from "../public/Runtime.ts";
import type { PersistedStackState } from "../state/StackState.ts";
import { resolveSecrets } from "../state/SecretStore.ts";
import { makeRuntimeInputOwner } from "./RuntimeInputOwner.ts";

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
  desiredGeneration: 1,
  portsGeneration: null,
  desiredLifecycle: "stopped",
  definition: compiled.definition,
  inputFingerprint: compiled.inputFingerprint,
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
          JSON.stringify([
            { ...first, alg: "ES256", kid: "ec-key" },
            { ...second, alg: "RS256", kid: "rsa-key" },
          ]),
        );
        const state = yield* compiledState(root, {
          security: { jwt: { signing: { kind: "jwks-file", path: "keys.json" } } },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, 1, "native");
        expect(JSON.parse(material.auth?.jwtKeys ?? "[]")).toHaveLength(2);
        const jwks = JSON.parse(material.auth?.jwks ?? "{}");
        expect(jwks.keys).toHaveLength(2);
        expect(jwks.keys.every((key: Record<string, unknown>) => !Object.hasOwn(key, "d"))).toBe(
          true,
        );
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
        const material = yield* owner.resolve(state, 2, "native");
        expect(requested).toEqual([
          "https://securetoken.google.com/demo/.well-known/openid-configuration",
          "https://issuer.example/keys",
        ]);
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
        const jwks = JSON.parse((yield* owner.resolve(state, 1, "native")).auth?.jwks ?? "{}");
        expect(jwks.keys).toEqual([{ kty: "oct", k: "c3ltbWV0cmljLXNlY3JldA" }]);
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
        const failed = yield* owner.resolve(state, 1, "native").pipe(Effect.exit);
        expect(errorOf(failed)?.message).toContain("contains no keys");
      }),
    ),
  );

  it.live("writes a generation-scoped owner-only Pooler tenant file and cleans it", () =>
    withPlatform(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "runtime-input-pooler-" });
        const state = yield* compiledState(root, {
          capabilities: { pooler: { enabled: true, settings: { pool_mode: "session" } } },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const first = yield* owner.resolve(state, 3, "native");
        const second = yield* owner.resolve(state, 3, "native");
        expect(second.pooler?.tenantPath).toBe(first.pooler?.tenantPath);
        const tenant = first.pooler?.tenantPath;
        expect(tenant).toBeDefined();
        expect((yield* fs.stat(tenant!)).mode & 0o777).toBe(0o600);
        const content = yield* fs.readFileString(tenant!);
        expect(content).toContain('"db_host" => "127.0.0.1"');
        expect(content).toContain('"external_id" => "pooler-dev"');
        expect(content).not.toContain('"db_password" => ""');
        yield* owner.cleanupGeneration(3);
        expect(yield* fs.exists(path.dirname(tenant!))).toBe(false);
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
        const material = yield* owner.resolve(state, 1, "native");
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
                    secrets: { SUPABASE_RESERVED: { slot: "missing" } },
                  },
                },
              },
            },
          },
        };
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, 1, "native");
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
              settings: {
                edge_runtime: { secrets: { API_TOKEN: Redacted.make("actual-value") } },
              },
            },
          },
        });
        const owner = yield* makeRuntimeInputOwner({ stateRoot: root, stackId });
        const material = yield* owner.resolve(state, 1, "native");
        expect(material.functions?.secrets).toEqual({ API_TOKEN: "actual-value" });
        const invalid = yield* compiledState(root, {
          capabilities: {
            functions: {
              settings: {
                edge_runtime: { secrets: { SUPABASE_TOKEN: Redacted.make("value") } },
              },
            },
          },
        });
        const failed = yield* owner.resolve(invalid, 1, "native").pipe(Effect.exit);
        expect(errorOf(failed)?.message).toContain("secret name is reserved");

        const control = yield* compiledState(root, {
          capabilities: {
            functions: {
              settings: {
                edge_runtime: { secrets: { API_TOKEN: Redacted.make("value\tinvalid") } },
              },
            },
          },
        });
        const controlFailure = yield* owner.resolve(control, 1, "native").pipe(Effect.exit);
        expect(errorOf(controlFailure)?.message).toContain("secret value is invalid");
      }),
    ),
  );
});
