import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  legacyJsonResponse,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { legacySeedBuckets } from "./buckets.handler.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";

interface MockRoute {
  readonly method: string;
  /** Substring matched against the request URL. */
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
  /** When set, the route fails with a transport error instead of responding. */
  readonly transport?: boolean;
}

const DEFAULT_FLAGS: LegacyBucketsFlags = { linked: false, local: true };

function setupLegacySeedBuckets(
  workdir: string,
  opts: {
    readonly toml?: string;
    readonly routes?: ReadonlyArray<MockRoute>;
    readonly files?: Readonly<Record<string, string>>;
    readonly format?: OutputFormat;
    readonly confirm?: ReadonlyArray<boolean>;
    readonly promptConfirmFail?: boolean;
    readonly args?: ReadonlyArray<string>;
    readonly yes?: boolean;
  },
) {
  if (opts.toml !== undefined) {
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), opts.toml);
  }

  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = join(workdir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }

  const out = mockOutput({
    format: opts.format ?? "text",
    promptConfirmResponses: opts.confirm,
    promptConfirmFail: opts.promptConfirmFail,
  });

  const requests: Array<{ method: string; url: string; headers: Record<string, string> }> = [];
  const routes = opts.routes ?? [];
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      requests.push({ method: request.method, url: request.url, headers: { ...request.headers } });
      const route = routes.find(
        (r) => r.method === request.method && request.url.includes(r.match),
      );
      if (route === undefined) {
        return Effect.succeed(legacyJsonResponse(request, 404, { message: "no mock route" }));
      }
      if (route.transport === true) {
        return Effect.fail(legacyTransportFailure(request));
      }
      return Effect.succeed(legacyJsonResponse(request, route.status ?? 200, route.body ?? {}));
    }),
  );

  const telemetry = mockLegacyTelemetryStateTracked();

  const layer = Layer.mergeAll(
    out.layer,
    httpLayer,
    telemetry.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    Layer.succeed(CliArgs, { args: opts.args ?? ["seed", "buckets"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
  );

  return { layer, out, requests, telemetry };
}

const VECTOR_LIST = "/storage/v1/vector/ListVectorBuckets";
const VECTOR_CREATE = "/storage/v1/vector/CreateVectorBucket";
const VECTOR_DELETE = "/storage/v1/vector/DeleteVectorBucket";

describe("legacy seed buckets", () => {
  const tmp = useLegacyTempWorkdir("supabase-seed-buckets-");

  it.live("short-circuits with no output when nothing is configured", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: 'project_id = "test"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      expect(out.stderrText).toBe("");
    });
  });

  it.live("rejects passing both --local and --linked", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: 'project_id = "test"\n',
      args: ["seed", "buckets", "--local", "--linked"],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "if any flags in the group [linked local] are set none of the others can be; [linked local] were all set",
      );
      expect(requests).toHaveLength(0);
    });
  });

  it.live("creates a new bucket and updates an existing one (overwrite default yes)", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n[storage.buckets.private]\npublic = false\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
        { method: "PUT", match: "/storage/v1/bucket/test", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "private" } },
      ],
      // Non-interactive text mode: prompt fails → overwrite default (true) applies.
      promptConfirmFail: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Updating Storage bucket: test");
      expect(out.stderrText).toContain("Creating Storage bucket: private");
      expect(requests.some((r) => r.method === "PUT" && r.url.includes("/bucket/test"))).toBe(true);
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("skips the update when the overwrite prompt is declined", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
      ],
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).not.toContain("Updating Storage bucket");
      expect(requests.some((r) => r.method === "PUT")).toBe(false);
    });
  });

  it.live("creates configured vector buckets and leaves stale ones (prune default no)", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n[storage.vector.buckets.existing-vec]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        {
          method: "POST",
          match: VECTOR_LIST,
          body: {
            vectorBuckets: [
              { vectorBucketName: "existing-vec" },
              { vectorBucketName: "stale-vec" },
            ],
          },
        },
        { method: "POST", match: VECTOR_CREATE, body: {} },
        { method: "POST", match: VECTOR_DELETE, body: {} },
      ],
      // Non-interactive: prune prompt fails → default (false) → no delete.
      promptConfirmFail: true,
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Updating vector buckets...");
      expect(out.stderrText).toContain("Creating vector bucket: documents-openai");
      expect(out.stderrText).toContain("Bucket already exists: existing-vec");
      expect(requests.some((r) => r.url.includes(VECTOR_CREATE))).toBe(true);
      expect(requests.some((r) => r.url.includes(VECTOR_DELETE))).toBe(false);
    });
  });

  it.live("prunes a stale vector bucket when the prompt is accepted", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.keep-vec]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        {
          method: "POST",
          match: VECTOR_LIST,
          body: {
            vectorBuckets: [{ vectorBucketName: "keep-vec" }, { vectorBucketName: "stale-vec" }],
          },
        },
        { method: "POST", match: VECTOR_DELETE, body: {} },
      ],
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Pruning vector bucket: stale-vec");
      expect(requests.some((r) => r.url.includes(VECTOR_DELETE))).toBe(true);
    });
  });

  it.live("warns and continues when vector buckets are unavailable in the region", () => {
    const { layer, out } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: VECTOR_LIST, status: 400, body: { code: "FeatureNotEnabled" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("WARNING:");
      expect(out.stderrText).toContain(
        "Vector buckets are not available in this project's region yet",
      );
    });
  });

  it.live("warns and continues when the local vector service is unavailable", () => {
    const { layer, out } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        {
          method: "POST",
          match: VECTOR_LIST,
          status: 404,
          body: { message: "Route POST:/vector/ListVectorBuckets not found" },
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain(
        "Vector buckets are not available in the local storage service",
      );
      expect(out.stderrText).toContain("supabase link");
      expect(out.stderrText).toContain("restart the local stack");
    });
  });

  it.live("propagates an unclassified vector error", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: VECTOR_LIST, status: 500, body: { message: "boom" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("uploads objects from a bucket's objects_path", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      // Relative objects_path resolves under supabase/ (Go config.go:757-759).
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      files: {
        "supabase/assets/a.txt": "hello",
        "supabase/assets/sub/b.txt": "world",
      },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
      expect(out.stderrText).toContain("Uploading: supabase/assets/sub/b.txt => images/sub/b.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(2);
    });
  });

  it.live("resolves an absolute objects_path as-is (Go IsAbs guard)", () => {
    const absRoot = join(tmp.current, "external-assets");
    mkdirSync(absRoot, { recursive: true });
    writeFileSync(join(absRoot, "a.txt"), "hello");
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      // An absolute objects_path is left untouched — no supabase/ prefix.
      toml: `[storage.buckets.images]\npublic = true\nobjects_path = "${absRoot}"\n`,
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain(`Uploading: ${join(absRoot, "a.txt")} => images/a.txt`);
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live("fails with a config-load error on malformed config.toml", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, { toml: "[storage\n" });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("emits a structured result and suppresses prompts in json mode", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
        { method: "PUT", match: "/storage/v1/bucket/test", body: {} },
      ],
      format: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // json mode does not prompt; overwrite default (yes) → bucket updated.
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(requests.some((r) => r.method === "PUT" && r.url.includes("/bucket/test"))).toBe(true);
    });
  });

  it.live("returns without output when no config.toml is found", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {});
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      expect(out.stderrText).toBe("");
    });
  });

  it.live("honors an explicit external_url and service_role_key", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[api]",
        'external_url = "http://gateway.test:9999"',
        "[auth]",
        'service_role_key = "explicit-key"',
        "[storage.buckets.media]",
        "public = true",
        'allowed_mime_types = ["image/png"]',
        'file_size_limit = "0"',
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // baseUrl is the configured external_url, not the 127.0.0.1 default.
      expect(requests.every((r) => r.url.startsWith("http://gateway.test:9999"))).toBe(true);
      // A non-`sb_` key is treated as a JWT: both apikey and bearer are sent.
      expect(requests.every((r) => r.headers["apikey"] === "explicit-key")).toBe(true);
      expect(requests.every((r) => r.headers["authorization"] === "Bearer explicit-key")).toBe(
        true,
      );
    });
  });

  it.live("omits the Authorization header for an opaque sb_ service key", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[auth]",
        'service_role_key = "sb_secret_localkey"',
        "[storage.buckets.media]",
        "public = true",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Go's withAuthToken sends only `apikey` for opaque `sb_...` keys.
      expect(requests.every((r) => r.headers["apikey"] === "sb_secret_localkey")).toBe(true);
      expect(requests.every((r) => r.headers["authorization"] === undefined)).toBe(true);
    });
  });

  it.live("regenerates the service-role key when it is set to an empty string", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: ["[auth]", 'service_role_key = ""', "[storage.buckets.media]", "public = true"].join(
        "\n",
      ),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // An empty key is regenerated from the default secret (a signed JWT), not
      // sent verbatim — Go's generateAPIKeys fills it on len == 0.
      expect(
        requests.every((r) => (r.headers["authorization"] ?? "").startsWith("Bearer ey")),
      ).toBe(true);
    });
  });

  it.live("rejects a jwt_secret shorter than 16 characters", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[auth]\njwt_secret = "tooshort"\n[storage.buckets.media]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "Invalid config for auth.jwt_secret. Must be at least 16 characters",
      );
      // Validation fails before any Storage call.
      expect(requests).toHaveLength(0);
    });
  });

  it.live("derives the service-role key from auth.jwt_secret when no key is set", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[auth]",
        'jwt_secret = "custom-jwt-secret-at-least-32-characters-long"',
        "[storage.buckets.docs]",
        "public = false",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  it.live("propagates a transport failure from the Storage gateway", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("skips vector seeding when enabled but no vector buckets are configured", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).not.toContain("Updating vector buckets...");
      expect(requests.some((r) => r.url.includes("/vector/"))).toBe(false);
    });
  });

  it.live("falls back to the default host when external_url is empty", () => {
    // Clear both host overrides so legacyGetHostname resolves to loopback
    // deterministically, regardless of the test environment's DOCKER_HOST.
    const previousServices = process.env["SUPABASE_SERVICES_HOSTNAME"];
    const previousDocker = process.env["DOCKER_HOST"];
    delete process.env["SUPABASE_SERVICES_HOSTNAME"];
    delete process.env["DOCKER_HOST"];
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api]\nexternal_url = ""\n[storage.buckets.images]\npublic = true\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.url.startsWith("http://127.0.0.1:54321"))).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousServices === undefined) {
            delete process.env["SUPABASE_SERVICES_HOSTNAME"];
          } else {
            process.env["SUPABASE_SERVICES_HOSTNAME"] = previousServices;
          }
          if (previousDocker === undefined) {
            delete process.env["DOCKER_HOST"];
          } else {
            process.env["DOCKER_HOST"] = previousDocker;
          }
        }),
      ),
    );
  });

  it.live("tolerates malformed entries in the bucket list response", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        {
          method: "GET",
          match: "/storage/v1/bucket",
          // Missing key, non-object entry, and a non-string field exercise the
          // defensive readString branches.
          body: [{ id: "x" }, "not-an-object", { name: 42, id: "y" }],
        },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "POST")).toBe(true);
    });
  });

  it.live("builds an https base URL with a host override when tls is enabled", () => {
    const previousHost = process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "docker.host";
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[api]\nport = 7654\n[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.url.startsWith("https://docker.host:7654"))).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousHost === undefined) {
            delete process.env["SUPABASE_SERVICES_HOSTNAME"];
          } else {
            process.env["SUPABASE_SERVICES_HOSTNAME"] = previousHost;
          }
        }),
      ),
    );
  });

  it.live("falls back to the TCP Docker daemon host when only DOCKER_HOST is set", () => {
    const previousServices = process.env["SUPABASE_SERVICES_HOSTNAME"];
    const previousDocker = process.env["DOCKER_HOST"];
    delete process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["DOCKER_HOST"] = "tcp://docker.internal:2375";
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Go's GetHostname dials the TCP daemon host, not loopback, when only
      // DOCKER_HOST is set (misc.go:305-310).
      expect(requests.every((r) => r.url.startsWith("http://docker.internal:54321"))).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (previousServices === undefined) {
            delete process.env["SUPABASE_SERVICES_HOSTNAME"];
          } else {
            process.env["SUPABASE_SERVICES_HOSTNAME"] = previousServices;
          }
          if (previousDocker === undefined) {
            delete process.env["DOCKER_HOST"];
          } else {
            process.env["DOCKER_HOST"] = previousDocker;
          }
        }),
      ),
    );
  });

  it.live("skips non-regular files during the object walk", () => {
    // A FIFO is neither a regular file nor a directory, exercising the skip path.
    mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "assets", "a.txt"), "hello");
    execFileSync("mkfifo", [join(tmp.current, "supabase", "assets", "pipe")]);
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Skipping non-regular file: supabase/assets/pipe");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live("skips a dangling symlink without failing (Go isUploadableEntry parity)", () => {
    mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "assets", "a.txt"), "hello");
    symlinkSync("./does-not-exist", join(tmp.current, "supabase", "assets", "dangling"));
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Skipping non-regular file: supabase/assets/dangling");
      expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live(
    "does not descend into a symlinked directory (Go does not follow nested symlinks)",
    () => {
      mkdirSync(join(tmp.current, "supabase", "assets", "realdir"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "assets", "a.txt"), "hello");
      writeFileSync(join(tmp.current, "supabase", "assets", "realdir", "c.txt"), "world");
      symlinkSync("./realdir", join(tmp.current, "supabase", "assets", "linkdir"));
      const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
        toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/object/", body: {} },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain("Skipping non-regular file: supabase/assets/linkdir");
        expect(out.stderrText).toContain(
          "Uploading: supabase/assets/realdir/c.txt => images/realdir/c.txt",
        );
        expect(out.stderrText).not.toContain("supabase/assets/linkdir/c.txt");
        const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
        expect(uploads).toHaveLength(2);
      });
    },
  );

  it.live("--yes overwrites an existing bucket and echoes Go's prompt line", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.assets]\npublic = true\n",
      yes: true,
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "assets", id: "assets" }] },
        { method: "PUT", match: "/storage/v1/bucket/assets", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // The bucket name is bold-rendered, so assert the stable suffix.
      expect(out.stderrText).toContain(
        "already exists. Do you want to overwrite its properties? [Y/n] y",
      );
      expect(out.stderrText).toContain("Updating Storage bucket: assets");
      expect(requests.some((r) => r.method === "PUT")).toBe(true);
      expect(out.promptConfirmCalls).toHaveLength(0);
    });
  });

  it.live("--yes prunes a stale vector bucket and echoes Go's prompt line", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.vec1]\n",
      yes: true,
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        {
          method: "POST",
          match: VECTOR_LIST,
          body: { vectorBuckets: [{ vectorBucketName: "stale" }] },
        },
        { method: "POST", match: VECTOR_CREATE, body: {} },
        { method: "POST", match: VECTOR_DELETE, body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Bucket name + config path are bold-rendered, so assert the stable suffix.
      expect(out.stderrText).toContain("Do you want to prune it? [y/N] y");
      expect(requests.some((r) => r.url.endsWith(VECTOR_DELETE))).toBe(true);
    });
  });
});
