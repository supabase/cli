// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import, effecttsgo/prefer-schema-over-json -- Functions tests exercise native filesystem fixtures and JSON/JWT protocol payloads through the public Promise facade.

import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import { mkdtempSync, symlinkSync } from "node:fs";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Predicate, Schema } from "effect";
import {
  resolveConfig as resolveConfigEffect,
  type ResolveConfigOptions,
} from "./StackConfigResolver.ts";
import type { PortSet } from "./PortCatalog.ts";
import { defaultJwtSecret, generateJwt } from "./JwtGenerator.ts";
import {
  clearFunctionsRuntimeConfig,
  configureFunctionsRuntime,
  functionsRuntimeConfigPath,
  ResolvedFunctionsBundleSchema,
  resolveFunctionsRuntimeConfig,
  type ResolvedFunctionsBundle,
} from "./functions.ts";
import { fileUrl, verifyRequest } from "./services/edge-runtime-main.ts";

const testPorts: PortSet = {
  apiPort: 40_000,
  dbPort: 40_001,
  authPort: 40_002,
  postgrestPort: 40_003,
  postgrestAdminPort: 40_004,
  edgeRuntimePort: 40_005,
  edgeRuntimeInspectorPort: 40_006,
  realtimePort: 40_007,
  storagePort: 40_008,
  imgproxyPort: 40_009,
  mailpitPort: 40_010,
  mailpitSmtpPort: 40_011,
  mailpitPop3Port: 40_012,
  pgmetaPort: 40_013,
  studioPort: 40_014,
  analyticsPort: 40_015,
  poolerSessionPort: 40_016,
  poolerTransactionPort: 40_017,
  poolerApiPort: 40_018,
};

const resolveConfig = (
  config?: Parameters<typeof resolveConfigEffect>[0],
  options?: Partial<ResolveConfigOptions>,
) =>
  Effect.runPromise(
    resolveConfigEffect(config, { ...options, ports: options?.ports ?? testPorts }).pipe(
      Effect.provide(NodeServices.layer),
    ),
  );

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-stack-functions-"));
}

function makeBundle(root: string): ResolvedFunctionsBundle {
  return {
    env: { SHARED: "shared-value", BUNDLE_ONLY: "bundle-value" },
    functions: [
      {
        name: "hello-world",
        verifyJWT: true,
        entrypointPath: join(root, "functions", "hello-world", "index.ts"),
        importMapPath: null,
        staticFiles: [join(root, "functions", "hello-world", "assets", "*")],
        env: { SHARED: "function-value", FUNCTION_ONLY: "function-value" },
      },
    ],
  };
}

function jwtWithInvalidSignature(algorithm?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: algorithm, typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: "test-user" })).toString("base64url");
  return `${header}.${payload}.invalid`;
}

const authFailureCases = [
  {
    name: "returns the missing authorization error",
    code: "UNAUTHORIZED_NO_AUTH_HEADER",
    message: "Missing authorization header",
  },
  {
    name: "returns the invalid JWT format error",
    authorization: "Bearer not-a-jwt",
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "returns the invalid JWT format error when the algorithm is missing",
    authorization: `Bearer ${jwtWithInvalidSignature()}`,
    code: "UNAUTHORIZED_INVALID_JWT_FORMAT",
    message: "Invalid JWT format",
  },
  {
    name: "returns the legacy JWT error",
    authorization: `Bearer ${jwtWithInvalidSignature("HS256")}`,
    code: "UNAUTHORIZED_LEGACY_JWT",
    message: "Invalid JWT",
  },
  {
    name: "returns the asymmetric JWT error",
    authorization: `Bearer ${jwtWithInvalidSignature("ES256")}`,
    code: "UNAUTHORIZED_ASYMMETRIC_JWT",
    message: "Invalid JWT",
  },
  {
    name: "returns the unsupported algorithm error",
    authorization: `Bearer ${jwtWithInvalidSignature("none")}`,
    code: "UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM",
    message: "Unsupported JWT algorithm none",
  },
];

describe("stack Functions runtime config", () => {
  it("projects an explicit bundle without project discovery", async () => {
    const root = makeTempProject();
    const stackConfig = await resolveConfig(
      {
        mode: "docker",
        projectDir: root,
        functions: makeBundle(root),
      },
      { runtime: { mode: "docker", containerRuntime: "docker" } },
    );
    const config = resolveFunctionsRuntimeConfig(
      stackConfig,
      { hostname: "127.0.0.1" },
      makeBundle(root),
    );

    expect(config?.env).toEqual({ SHARED: "shared-value", BUNDLE_ONLY: "bundle-value" });
    expect(config?.functions["hello-world"]).toEqual({
      verifyJWT: true,
      entrypointPath: join(root, "functions", "hello-world", "index.ts"),
      importMapPath: null,
      staticFiles: [join(root, "functions", "hello-world", "assets", "*")],
      env: { SHARED: "function-value", FUNCTION_ONLY: "function-value" },
    });

    await rm(root, { recursive: true, force: true });
  });

  it("projects native function paths relative to the Edge Runtime workspace", async () => {
    const root = makeTempProject();
    const runtimeRoot = join(root, "runtime");
    const stackConfig = await resolveConfig(
      { projectDir: root, runtimeRoot, functions: makeBundle(root) },
      { runtime: { mode: "native", containerRuntime: null } },
    );
    const config = resolveFunctionsRuntimeConfig(
      stackConfig,
      { hostname: "127.0.0.1" },
      makeBundle(root),
    );

    expect(config?.functions["hello-world"]).toEqual({
      verifyJWT: true,
      entrypointPath: "../../functions/hello-world/index.ts",
      importMapPath: null,
      staticFiles: ["../../functions/hello-world/assets/*"],
      env: { SHARED: "function-value", FUNCTION_ONLY: "function-value" },
    });

    await rm(root, { recursive: true, force: true });
  });

  it("resolves relative native entrypoints against the runtime cwd", () => {
    expect(fileUrl("../../functions/hello-world/index.ts", "/tmp/runtime/edge-runtime")).toBe(
      "file:///tmp/functions/hello-world/index.ts",
    );
    expect(fileUrl("/tmp/functions/hello-world/index.ts")).toBe(
      "file:///tmp/functions/hello-world/index.ts",
    );
  });

  it("rejects a function bundle when Edge Runtime is disabled", async () => {
    const root = makeTempProject();

    const error = await resolveConfig({
      mode: "native",
      projectDir: root,
      edgeRuntime: false,
      functions: makeBundle(root),
    }).then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(Predicate.isTagged(error, "StackBuildError")).toBe(true);
    if (Predicate.isTagged(error, "StackBuildError")) {
      expect(error).toMatchObject({
        reason: "invalid_config",
        detail: "Edge Functions require Edge Runtime to be enabled",
      });
    }

    await rm(root, { recursive: true, force: true });
  });

  it("validates paths, import maps, and unique function names", async () => {
    const decode = Schema.decodeUnknownSync(ResolvedFunctionsBundleSchema);
    const root = makeTempProject();
    const bundle = makeBundle(root);

    expect(decode(bundle).functions[0]?.importMapPath).toBeNull();
    expect(() =>
      decode({
        ...bundle,
        functions: [{ ...bundle.functions[0], entrypointPath: "./index.ts" }],
      }),
    ).toThrow("Expected an absolute path");
    expect(() =>
      decode({
        ...bundle,
        functions: [bundle.functions[0], bundle.functions[0]],
      }),
    ).toThrow("Duplicate function name: hello-world");

    await rm(root, { recursive: true, force: true });
  });

  it("validates explicit bundles at config resolution", async () => {
    const root = makeTempProject();
    const bundle = makeBundle(root);

    await expect(
      resolveConfig({
        projectDir: root,
        functions: {
          ...bundle,
          functions: [bundle.functions[0]!, bundle.functions[0]!],
        },
      }),
    ).rejects.toMatchObject({
      _tag: "StackBuildError",
      detail: "Invalid Edge Functions bundle",
    });
    await expect(
      resolveConfig({
        projectDir: join(root, "project"),
        functions: bundle,
      }),
    ).rejects.toMatchObject({
      _tag: "StackBuildError",
      detail: "Invalid Edge Functions bundle",
    });

    await rm(root, { recursive: true, force: true });
  });

  it("rejects bundle paths that escape projectDir through a symlink", async () => {
    const root = makeTempProject();
    const outside = makeTempProject();
    const bundle = makeBundle(root);
    symlinkSync(
      outside,
      join(root, "linked-outside"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      resolveConfig({
        projectDir: root,
        functions: {
          ...bundle,
          functions: [
            {
              ...bundle.functions[0]!,
              entrypointPath: join(root, "linked-outside", "index.ts"),
            },
          ],
        },
      }),
    ).rejects.toMatchObject({
      _tag: "StackBuildError",
      detail: "Invalid Edge Functions bundle",
    });

    await Promise.all([
      rm(root, { recursive: true, force: true }),
      rm(outside, { recursive: true, force: true }),
    ]);
  });

  it("keeps placeholder mode when no functions are supplied", async () => {
    const stackConfig = await resolveConfig({ functions: false });

    expect(
      resolveFunctionsRuntimeConfig(stackConfig, { hostname: "127.0.0.1" }, undefined),
    ).toBeUndefined();
    expect(
      resolveFunctionsRuntimeConfig(
        stackConfig,
        { hostname: "127.0.0.1" },
        {
          env: {},
          functions: [],
        },
      ),
    ).toBeUndefined();
  });

  it.live("atomically writes restrictive ephemeral config and removes it", () => {
    const cwd = makeTempProject();

    return Effect.gen(function* () {
      const bundle = makeBundle(cwd);
      const stackConfig = yield* Effect.promise(() =>
        resolveConfig(
          { mode: "docker", projectDir: cwd, runtimeRoot: cwd, functions: bundle },
          { runtime: { mode: "docker", containerRuntime: "docker" } },
        ),
      );
      yield* configureFunctionsRuntime(stackConfig, { hostname: "127.0.0.1" }, bundle);
      const filePath = functionsRuntimeConfigPath(stackConfig.runtimeRoot);
      const written = JSON.parse(yield* Effect.promise(() => readFile(filePath, "utf8"))) as {
        functions: Record<string, unknown>;
      };

      expect(Object.keys(written.functions)).toEqual(["hello-world"]);
      expect((yield* Effect.promise(() => stat(filePath))).mode & 0o777).toBe(0o600);
      expect(yield* Effect.promise(() => readdir(join(cwd, "edge-runtime")))).toEqual([
        "functions-runtime-config.json",
      ]);

      yield* clearFunctionsRuntimeConfig(stackConfig.runtimeRoot);
      expect(yield* Effect.promise(() => readdir(join(cwd, "edge-runtime")))).toEqual([]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.promise(() => rm(cwd, { recursive: true, force: true }))),
    );
  });
});

describe("stack Functions runtime auth", () => {
  for (const { name, authorization, code, message } of authFailureCases) {
    it(name, async () => {
      const response = await verifyRequest(
        new Request("http://127.0.0.1/functions/v1/test", {
          headers: authorization === undefined ? undefined : { authorization },
        }),
        { jwtSecret: defaultJwtSecret },
        { verifyJWT: true },
      );

      expect(response).not.toBeNull();
      if (response === null) return;

      expect(response.status).toBe(401);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(response.headers.get("sb-error-code")).toBe(code);
      expect(response.headers.get("access-control-expose-headers")).toBe("sb-error-code");
      expect(await response.json()).toEqual({ code, message, msg: message });
    });
  }

  it("accepts a valid legacy JWT", async () => {
    const token = generateJwt(defaultJwtSecret, "anon");
    const response = await verifyRequest(
      new Request("http://127.0.0.1/functions/v1/test", {
        headers: { authorization: `Bearer ${token}` },
      }),
      { jwtSecret: defaultJwtSecret },
      { verifyJWT: true },
    );

    expect(response).toBeNull();
  });

  it("accepts a lowercase bearer scheme", async () => {
    const token = generateJwt(defaultJwtSecret, "anon");
    const response = await verifyRequest(
      new Request("http://127.0.0.1/functions/v1/test", {
        headers: { authorization: `bearer ${token}` },
      }),
      { jwtSecret: defaultJwtSecret },
      { verifyJWT: true },
    );

    expect(response).toBeNull();
  });
});
