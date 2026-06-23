import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";

import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  legacyJsonResponse,
  legacyStatusCodeFailure,
  legacyTransportFailure,
  mockLegacyCliConfig,
  mockLegacyPlatformApiService,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { CliArgs } from "../../../../shared/cli/cli-args.service.ts";
import { LegacyYesFlag } from "../../../../shared/legacy/global-flags.ts";
import type { OutputFormat } from "../../../../shared/output/types.ts";
import { LegacyProjectRefResolver } from "../../../../legacy/config/legacy-project-ref.service.ts";
import { LegacyProjectNotLinkedError } from "../../../../legacy/config/legacy-project-ref.errors.ts";
import { legacySeedBuckets } from "./buckets.handler.ts";
import type { LegacyBucketsFlags } from "./buckets.command.ts";
import { LegacyPlatformApi } from "../../../../legacy/auth/legacy-platform-api.service.ts";
import { LegacyPlatformApiFactory } from "../../../../legacy/auth/legacy-platform-api-factory.service.ts";

interface MockRoute {
  readonly method: string;
  /** Substring matched against the request URL. */
  readonly match: string;
  readonly status?: number;
  readonly body?: unknown;
  /** When set, the route fails with a transport error instead of responding. */
  readonly transport?: boolean;
  /** Transport-error description (defaults to "ECONNREFUSED"); e.g. a malformed-response. */
  readonly transportDescription?: string;
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
    /** Project ref returned by loadProjectRef for --linked tests. */
    readonly projectRef?: string;
    /** API keys response for Management API mock. */
    readonly apiKeys?: ReadonlyArray<{
      name: string;
      api_key?: string | null;
      type?: string | null;
      secret_jwt_template?: Record<string, unknown> | null;
    }>;
    /** When true, loadProjectRef fails with LegacyProjectNotLinkedError. */
    readonly linkedFails?: boolean;
    /** When set, the Management API `getProjectApiKeys` call fails with this error. */
    readonly apiKeysFail?: HttpClientError.HttpClientError;
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

  const requests: Array<{
    method: string;
    url: string;
    headers: Record<string, string>;
    body: unknown;
  }> = [];
  const routes = opts.routes ?? [];
  const httpLayer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const reqBody = request.body;
      let body: unknown;
      if (reqBody._tag === "Uint8Array") {
        try {
          body = JSON.parse(new TextDecoder().decode(reqBody.body));
        } catch {
          body = undefined;
        }
      }
      requests.push({
        method: request.method,
        url: request.url,
        headers: { ...request.headers },
        body,
      });
      const route = routes.find(
        (r) => r.method === request.method && request.url.includes(r.match),
      );
      if (route === undefined) {
        return Effect.succeed(legacyJsonResponse(request, 404, { message: "no mock route" }));
      }
      if (route.transport === true) {
        return Effect.fail(legacyTransportFailure(request, route.transportDescription));
      }
      return Effect.succeed(legacyJsonResponse(request, route.status ?? 200, route.body ?? {}));
    }),
  );

  const telemetry = mockLegacyTelemetryStateTracked();
  const linkedCache = mockLegacyLinkedProjectCacheTracked();

  const projectRefRef = opts.projectRef ?? LEGACY_VALID_REF;
  const projectRefLayer = Layer.succeed(LegacyProjectRefResolver, {
    resolve: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new LegacyProjectNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(projectRefRef),
    resolveForLink: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new LegacyProjectNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(projectRefRef),
    resolveOptional: () => Effect.succeed(Option.some(projectRefRef)),
    loadProjectRef: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new LegacyProjectNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(projectRefRef),
    promptProjectRef: () => Effect.succeed(projectRefRef),
  });

  const defaultApiKeys = [
    {
      name: "service_role",
      api_key: "test-service-role-key",
      type: "secret",
      secret_jwt_template: { role: "service_role" },
    },
  ];
  const managementApi = mockLegacyPlatformApiService({
    v1: {
      getProjectApiKeys: () =>
        opts.apiKeysFail !== undefined
          ? Effect.fail(opts.apiKeysFail)
          : Effect.succeed(opts.apiKeys ?? defaultApiKeys),
    },
  });

  const layer = Layer.mergeAll(
    out.layer,
    httpLayer,
    telemetry.layer,
    mockLegacyCliConfig({ workdir }),
    BunServices.layer,
    Layer.succeed(CliArgs, { args: opts.args ?? ["seed", "buckets"] }),
    Layer.succeed(LegacyYesFlag, opts.yes ?? false),
    projectRefLayer,
    Layer.succeed(LegacyPlatformApiFactory, {
      make: LegacyPlatformApi.pipe(Effect.provide(managementApi.layer)),
    }),
    linkedCache.layer,
  );

  return { layer, out, requests, telemetry, linkedCache };
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

  it.live("emits an empty JSON result for a no-op run (json mode)", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: 'project_id = "test"\n',
      format: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      // Scripted json callers get a result object even for the no-op short-circuit.
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["buckets_created"]).toEqual([]);
      expect(success?.data?.["objects_uploaded"]).toEqual([]);
    });
  });

  // --local/--linked mutual exclusivity is enforced at the command level, before
  // instrumentation (so it doesn't emit telemetry, matching Go's flag-validation
  // rejection). It's covered by `legacyAssertSeedTargetsExclusive` in
  // buckets.flags.unit.test.ts rather than here, since the handler no longer
  // performs the check.

  it.live("tolerates null string fields in 200 responses (Go encoding/json zero value)", () => {
    // Go decodes these bodies into plain `string` fields (not *string); a JSON
    // `null` leaves them at "" and does NOT abort (fetcher/http.go:144-151). A
    // list entry with `name: null` and a create response with `message: null`
    // must therefore be tolerated, not treated as a parse failure.
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.docs]\npublic = false\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: null, id: "legacy" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { message: null } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: docs");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("tolerates a null element in a bucket list (Go zero-value struct)", () => {
    // Go's encoding/json decodes a null array element into the zero-value struct
    // (BucketResponse{Name:"", Id:""}) and the upsert loop continues
    // (pkg/storage/buckets.go:21-27). A null element must not abort the run; the
    // configured bucket is still created. A genuine type mismatch (string/number
    // element) still aborts — that's covered by the malformed-response test.
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.docs]\npublic = false\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [null, { name: "other", id: "o" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: docs");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
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

  it.live("treats a null vectorBuckets list as empty (Go nil slice)", () => {
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        // Go decodes `{"vectorBuckets": null}` into a nil slice → empty, not an error.
        { method: "POST", match: VECTOR_LIST, body: { vectorBuckets: null } },
        { method: "POST", match: VECTOR_CREATE, body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating vector bucket: documents-openai");
      expect(requests.some((r) => r.url.includes(VECTOR_CREATE))).toBe(true);
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

  it.live("sets the object Content-Type from the file bytes, not the extension", () => {
    // Go sniffs the first 512 bytes with http.DetectContentType and only refines
    // a generic text/plain by extension (objects.go:77-108). A PNG named `.txt`
    // must upload as image/png (bytes win), and a JSON text file refines to
    // application/json via its extension.
    mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
    // Real PNG magic bytes — written raw (a UTF-8 string would mangle 0x89).
    writeFileSync(
      join(tmp.current, "supabase", "assets", "logo.txt"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    writeFileSync(join(tmp.current, "supabase", "assets", "data.json"), '{"a":1}');
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
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
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      const byKey = (suffix: string) => uploads.find((r) => r.url.endsWith(suffix));
      // PNG content named .txt → image/png (the bytes win over the extension).
      expect(byKey("images/logo.txt")?.headers["content-type"]).toBe("image/png");
      // JSON text → text/plain sniff refined to application/json by extension.
      expect(byKey("images/data.json")?.headers["content-type"]).toBe("application/json");
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

  it.live("treats a missing config file as embedded defaults: local no-op, no text output", () => {
    // Go never aborts on a missing config.toml — it uses embedded defaults and
    // no-ops the LOCAL path on empty buckets (internal/seed/buckets/buckets.go:16-20).
    // Text mode emits nothing for the no-op, same as before.
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {});
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits an empty JSON result for a missing config file (local no-op, json mode)", () => {
    // The missing-config local no-op flows through the same empty-summary path as
    // an empty-but-present config, so scripted json callers still get a result.
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["buckets_created"]).toEqual([]);
      expect(success?.data?.["objects_uploaded"]).toEqual([]);
    });
  });

  it.live("does not skip a --linked run when the config file is absent", () => {
    // A linked run never short-circuits (gating is len(projectRef) == 0), so even
    // with no config file Go still builds the remote client, fetches the
    // service-role key, and lists buckets — failures surface instead of a silent
    // success. With no configured buckets the remote LIST must still happen.
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      projectRef: LEGACY_VALID_REF,
      apiKeys: [
        {
          name: "service_role",
          api_key: "remote-service-role-key",
          type: "secret",
          secret_jwt_template: { role: "service_role" },
        },
      ],
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // The remote list call fired against the linked project — not a silent no-op.
      expect(
        requests.some(
          (r) =>
            r.method === "GET" &&
            r.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`) &&
            r.url.includes("/storage/v1/bucket"),
        ),
      ).toBe(true);
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

  it.live("fails on an invalid bucket file_size_limit before any Storage call", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // First bucket is valid; the second has an unparseable size. Go parses all
      // sizes at config-load before NewStorageAPI, so nothing is mutated.
      toml: [
        "[storage.buckets.ok]",
        "public = true",
        "[storage.buckets.bad]",
        'file_size_limit = "not-a-size"',
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      // No list/create happened — validation precedes every Storage side effect.
      expect(requests).toHaveLength(0);
    });
  });

  it.live("rejects a malformed file_size_limit numeral (Go strconv.ParseFloat)", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // JS parseFloat would parse "1.2.3" as 1.2; Go's strconv.ParseFloat rejects
      // the whole config before NewStorageAPI.
      toml: '[storage.buckets.media]\npublic = true\nfile_size_limit = "1.2.3MiB"\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails on an invalid storage-level file_size_limit (only vector buckets)", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // No storage buckets inherit it, only a vector bucket is configured — Go
      // still unmarshals storage.FileSizeLimit at config-load and aborts.
      toml: [
        '[storage]\nfile_size_limit = "bogus"',
        "[storage.vector]\nenabled = true",
        "[storage.vector.buckets.docs-openai]",
      ].join("\n"),
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails on an invalid storage-level file_size_limit even with nothing to seed", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // No buckets and no vector buckets — but Go decodes storage.FileSizeLimit
      // at config-load before buckets.Run's no-op path, so it still aborts. The
      // config-load validations must run before the no-op short-circuit.
      toml: '[storage]\nfile_size_limit = "bogus"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("inherits the storage-level file_size_limit when a bucket omits it", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // Custom storage-level limit; the bucket omits file_size_limit, so Go's
      // resolve() copies the storage-level value (5MiB) into the bucket.
      toml: '[storage]\nfile_size_limit = "5MiB"\n[storage.buckets.media]\npublic = true\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const create = requests.find(
        (r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket"),
      );
      // 5MiB = 5 * 1024 * 1024 (not the 50MiB bucket schema default).
      expect((create?.body as { file_size_limit?: number } | undefined)?.file_size_limit).toBe(
        5 * 1024 * 1024,
      );
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

  it.live("appends Go's port-conflict hint on a malformed local response", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[api]\nport = 7654\n[storage.buckets.test]\npublic = true\n",
      // A malformed response (not connection-refused) is the port-conflict signal.
      routes: [
        {
          method: "GET",
          match: "/storage/v1/bucket",
          transport: true,
          transportDescription: "malformed HTTP response",
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const s = JSON.stringify(exit);
      expect(s).toContain("Another process may be listening on the configured API port 7654");
      expect(s).toContain("lsof -nP -iTCP:7654 -sTCP:LISTEN");
    });
  });

  it.live("omits the port-conflict hint on a connection-refused local failure", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      // Stack simply stopped → ECONNREFUSED. Go's localGatewayHint does NOT fire
      // for connection-refused (only malformed/timeout), so neither do we.
      toml: "[api]\nport = 7654\n[storage.buckets.test]\npublic = true\n",
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("reports the external_url port (not api.port) in the local hint", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      // external_url overrides the host:port the gateway actually targets; Go's
      // localGatewayHint parses that URL, so the hint reports 9999, not 7654.
      toml: '[api]\nport = 7654\nexternal_url = "http://127.0.0.1:9999"\n[storage.buckets.test]\npublic = true\n',
      routes: [
        {
          method: "GET",
          match: "/storage/v1/bucket",
          transport: true,
          transportDescription: "malformed HTTP response",
        },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const s = JSON.stringify(exit);
      expect(s).toContain("configured API port 9999");
      expect(s).not.toContain("port 7654");
    });
  });

  it.live("omits the port-conflict hint for a non-loopback external_url", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api]\nexternal_url = "http://gateway.test:9999"\n[storage.buckets.test]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("omits the port-conflict hint on a --linked (remote) transport failure", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets({ linked: true, local: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("fails when a bucket create returns a non-object body (Go ParseJSON)", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        // Go decodes the create 200 body into {name}; a non-object body fails.
        { method: "POST", match: "/storage/v1/bucket", body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse response body");
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

  it.live("tolerates bucket entries with a missing field (Go zero value)", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        // A missing `name` decodes to the zero value (""), tolerated like Go's
        // json.Decode. (Non-object elements / wrong-typed fields are NOT — see below.)
        { method: "GET", match: "/storage/v1/bucket", body: [{ id: "x" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "POST")).toBe(true);
    });
  });

  it.live("fails on a malformed bucket-list response before any mutation", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        // A non-object element / wrong-typed field — Go's ParseJSON aborts here
        // (cannot unmarshal string into BucketResponse), before any create.
        {
          method: "GET",
          match: "/storage/v1/bucket",
          body: [{ id: "x" }, "not-an-object", { name: 42, id: "y" }],
        },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse response body");
      // No bucket was created from the bad response.
      expect(requests.some((r) => r.method === "POST")).toBe(false);
    });
  });

  it.live("fails on a non-array bucket-list response (misrouted gateway)", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: { message: "not an array" } },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(requests.some((r) => r.method === "POST")).toBe(false);
    });
  });

  it.live("treats a non-200 2xx gateway response as an error (Go expects exactly 200)", () => {
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        // Go's gateway uses WithExpectedStatus(200); a 201 is an error.
        { method: "POST", match: "/storage/v1/bucket", status: 201, body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 201");
    });
  });

  it.live(
    "trusts the Kong CA for an explicit https external_url even when tls.enabled is false",
    () => {
      // Go installs status.NewKongClient unconditionally for the local client, so
      // an https external_url with tls.enabled false/omitted still trusts the
      // embedded CA. The handler must take the CA-injection path (no validation,
      // no error) here, not skip it on `tls.enabled`.
      const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
        toml: '[api]\nexternal_url = "https://127.0.0.1:54321"\n[storage.buckets.images]\npublic = true\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.every((r) => r.url.startsWith("https://127.0.0.1:54321"))).toBe(true);
      });
    },
  );

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

  it.live("brackets an IPv6 local host when building the gateway URL", () => {
    const previousHost = process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "::1";
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Go's net.JoinHostPort brackets IPv6: http://[::1]:54321, not http://::1:54321.
      expect(requests.every((r) => r.url.startsWith("http://[::1]:54321"))).toBe(true);
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

  // Root bypasses POSIX permission bits, so chmod 000 wouldn't block open() there
  // and the open-vs-stat distinction this test relies on would vanish.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.live.skipIf(isRoot)(
    "skips a symlink to an unreadable regular file and keeps seeding siblings (Go opens, not stats)",
    () => {
      // Go's isUploadableEntry OPENS the symlink target (batch.go:73), which needs
      // read permission; a stat-only check would queue this unreadable file and then
      // abort the whole run when uploadObject opens it to stream. Mode 000 makes
      // stat succeed (type File) but open fail — the entry must be skipped, not fatal.
      // The real unreadable file lives OUTSIDE the walked tree: a plain regular file
      // inside assets/ would (per Go parity) be queued without an open-probe and would
      // legitimately abort, so only the symlink may reach the unreadable target.
      mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
      mkdirSync(join(tmp.current, "supabase", "private"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "assets", "a.txt"), "hello");
      const secret = join(tmp.current, "supabase", "private", "secret.txt");
      writeFileSync(secret, "top secret");
      chmodSync(secret, 0o000);
      symlinkSync(
        "../private/secret.txt",
        join(tmp.current, "supabase", "assets", "link-to-secret"),
      );
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
        expect(out.stderrText).toContain(
          "Skipping non-regular file: supabase/assets/link-to-secret",
        );
        expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
        // Only the readable sibling is uploaded; the unreadable symlink target is not.
        const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
        expect(uploads).toHaveLength(1);
      });
    },
  );

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

  it.live("follows a symlinked objects_path root and uploads its files (Go fs.WalkDir)", () => {
    // Go's `io/fs.WalkDir` follows a symlinked ROOT ("if root itself is a
    // symbolic link, its target will be walked"); only NESTED symlinks are
    // skipped. fs.stat on the root follows the link, so the target dir is walked.
    mkdirSync(join(tmp.current, "supabase", "real-assets"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "real-assets", "a.txt"), "hello");
    symlinkSync("./real-assets", join(tmp.current, "supabase", "linked-assets"));
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./linked-assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Uploading: supabase/linked-assets/a.txt => images/a.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

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

  // ---------------------------------------------------------------------------
  // --linked remote path tests
  // ---------------------------------------------------------------------------

  it.live("--linked seeds the remote storage project", () => {
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      apiKeys: [
        {
          name: "service_role",
          api_key: "remote-service-role-key",
          type: "secret",
          secret_jwt_template: { role: "service_role" },
        },
      ],
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: test");
      expect(
        requests.some((r) => r.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`)),
      ).toBe(true);
      expect(requests.some((r) => r.headers["apikey"] === "remote-service-role-key")).toBe(true);
    });
  });

  it.live("--linked=false still takes the linked path (Go flag.Changed, not value)", () => {
    // Go selects the target from flag.Changed: `--linked=false` is still linked.
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked=false"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets({ linked: false, local: true }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Remote URL → the linked path ran despite the parsed value being false.
      expect(
        requests.every((r) => r.url.startsWith(`https://${LEGACY_VALID_REF}.supabase.co`)),
      ).toBe(true);
    });
  });

  it.live("--local=false stays on the local path", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      args: ["seed", "buckets", "--local=false"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets({ linked: false, local: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isSuccess(exit)).toBe(true);
      // Local path (not the remote https host) — `--local` changed selects local.
      // Asserting "not remote" keeps this independent of the loopback host env.
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.url.startsWith("http://"))).toBe(true);
      expect(requests.some((r) => r.url.includes("supabase.co"))).toBe(false);
    });
  });

  it.live("--linked fails before any Storage call when the api-keys list is empty", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      apiKeys: [],
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets({ linked: true, local: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      // Go's tenant.GetApiKeys → errMissingKey, before NewStorageAPI.
      expect(JSON.stringify(exit)).toContain("Anon key not found.");
      expect(requests.some((r) => r.url.includes("/storage/v1/"))).toBe(false);
    });
  });

  it.live("--linked surfaces tenant.GetApiKeys auth error on a non-200 api-keys response", () => {
    // Go resolves the service-role key via tenant.GetApiKeys (storage/client/api.go:22),
    // which maps a non-200 to `Authorization failed for the access token and project
    // ref pair: <body>` (tenant/client.go:15,77-78) — NOT the projects api-keys
    // helper's `unexpected get api keys status ...`.
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      apiKeysFail: legacyStatusCodeFailure(401),
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets({ linked: true, local: false }).pipe(
        Effect.provide(layer),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("LegacySeedAuthTokenError");
      expect(json).toContain("Authorization failed for the access token and project ref pair");
      expect(json).not.toContain("unexpected get api keys status");
      // Fails before any remote Storage call.
      expect(requests.some((r) => r.url.includes("/storage/v1/"))).toBe(false);
    });
  });

  it.live("caches the linked project on --linked but not on local", () => {
    // Mirrors Go's ensureProjectGroupsCached (cmd/root.go), gated on a non-empty
    // resolved ref: --linked writes the linked-project cache + group identify;
    // the local path must not.
    const linked = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    const local = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      yield* legacySeedBuckets({ linked: true, local: false }).pipe(
        Effect.provide(linked.layer),
        Effect.exit,
      );
      expect(linked.linkedCache.cached).toBe(true);
      expect(linked.linkedCache.cachedRef).toBe(LEGACY_VALID_REF);

      yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(local.layer), Effect.exit);
      expect(local.linkedCache.cached).toBe(false);
    });
  });

  it.live("--linked uses SUPABASE_AUTH_SERVICE_ROLE_KEY env var when set", () => {
    const prevKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-service-role-key";
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.headers["apikey"] === "env-service-role-key")).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prevKey === undefined) {
            delete process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
          } else {
            process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = prevKey;
          }
        }),
      ),
    );
  });

  it.live("upserts analytics buckets when analytics.enabled and --linked", () => {
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[storage.analytics]",
        "enabled = true",
        "[storage.analytics.buckets.analytics-bucket]",
        "[storage.buckets.test]",
        "public = true",
      ].join("\n"),
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
        { method: "GET", match: "/storage/v1/iceberg/bucket", body: [] },
        { method: "POST", match: "/storage/v1/iceberg/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Updating analytics buckets...");
      expect(out.stderrText).toContain("Creating analytics bucket: analytics-bucket");
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/iceberg/bucket")),
      ).toBe(true);
    });
  });

  it.live("does not upsert analytics buckets on local runs", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[storage.analytics]",
        "enabled = true",
        "[storage.analytics.buckets.analytics-bucket]",
        "[storage.buckets.test]",
        "public = true",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => !r.url.includes("/iceberg/"))).toBe(true);
    });
  });

  it.live("prunes a stale analytics bucket when the prompt is accepted", () => {
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[storage.analytics]",
        "enabled = true",
        "[storage.analytics.buckets.keep-analytics]",
        "[storage.buckets.test]",
        "public = true",
      ].join("\n"),
      projectRef: LEGACY_VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
        {
          method: "GET",
          match: "/storage/v1/iceberg/bucket",
          body: [
            { name: "keep-analytics", id: "keep-analytics" },
            { name: "stale-analytics", id: "stale-analytics" },
          ],
        },
        { method: "DELETE", match: "/storage/v1/iceberg/bucket/stale-analytics", body: {} },
      ],
      confirm: [true],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Pruning analytics bucket: stale-analytics");
      expect(
        requests.some(
          (r) => r.method === "DELETE" && r.url.includes("/iceberg/bucket/stale-analytics"),
        ),
      ).toBe(true);
    });
  });

  it.live("--linked fails when the project is not linked", () => {
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer } = setupLegacySeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      linkedFails: true,
      args: ["seed", "buckets", "--linked"],
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("succeeds on the TLS local path and uses an https base URL", () => {
    // The integration harness mocks HttpClient.HttpClient directly (bypassing fetch),
    // so real TLS cert verification cannot be exercised here. This test confirms
    // the TLS code path (embedded CA resolution + FetchHttpClient.Fetch override)
    // does not throw, and that the gateway is called with https:// URLs — matching
    // the existing "builds an https base URL" test but going through the full
    // CA-resolution branch in the handler.
    const previousHost = process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "localhost";
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.url.startsWith("https://localhost:54321"))).toBe(true);
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

  it.live("reads cert_path and key_path from disk when both api.tls paths are set", () => {
    // Writes a dummy CA PEM and key to disk. Both must be present and readable
    // for the handler to succeed (Go validateLocalKongTls parity).
    const certContent = "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n";
    const keyContent = "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----\n";
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "custom-ca.crt"), certContent);
    writeFileSync(join(tmp.current, "supabase", "custom-ca.key"), keyContent);
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api]\nport = 54321\n[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\nkey_path = "custom-ca.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live(
    "re-roots an absolute cert_path/key_path under supabase/ (Go path.Join, no IsAbs guard)",
    () => {
      // Go resolves api.tls.cert_path/key_path with path.Join(SupabaseDirPath, p)
      // and NO filepath.IsAbs guard (config.go:795-801), so an absolute-looking
      // "/tmp/kong.crt" is read from supabase/tmp/kong.crt — NOT from the real
      // /tmp. We only write the cert/key under supabase/tmp/; if the handler tried
      // the literal /tmp path it would fail to read and error out.
      const certContent = "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n";
      const keyContent = "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----\n";
      mkdirSync(join(tmp.current, "supabase", "tmp"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "tmp", "kong.crt"), certContent);
      writeFileSync(join(tmp.current, "supabase", "tmp", "kong.key"), keyContent);
      const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
        toml: '[api]\nport = 54321\n[api.tls]\nenabled = true\ncert_path = "/tmp/kong.crt"\nkey_path = "/tmp/kong.key"\n[storage.buckets.docs]\npublic = false\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(
          Effect.provide(layer),
          Effect.exit,
        );
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
        ).toBe(true);
      });
    },
  );

  // ---------------------------------------------------------------------------
  // Fix 1 — --linked merges [remotes.*] config overrides
  // ---------------------------------------------------------------------------

  it.live("--linked merges [remotes.*] storage config override before seeding", () => {
    // The base config has [storage.buckets.base] with public=true; the remote block
    // overrides it to public=false and adds [storage.buckets.remote]. Both buckets
    // appear after the merge (Go's mergeRemoteConfig merges subtrees recursively;
    // it does not wholesale replace [storage.buckets]).
    const remoteRef = LEGACY_VALID_REF; // "abcdefghijklmnopqrst"
    const flags: LegacyBucketsFlags = { linked: true, local: false };
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        'project_id = "test"',
        "[storage.buckets.base]",
        "public = true",
        `[remotes.production]`,
        `project_id = "${remoteRef}"`,
        "[remotes.production.storage.buckets.base]",
        "public = false",
        "[remotes.production.storage.buckets.remote]",
        "public = false",
      ].join("\n"),
      projectRef: remoteRef,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Go prints the override notice from inside config load (config.go:513).
      expect(out.stderrText).toContain("Loading config override: [remotes.production]");
      // Both base and remote are present after the merge; the remote override
      // changed base.public from true → false (but both are still seeded).
      expect(out.stderrText).toContain("Creating Storage bucket: base");
      expect(out.stderrText).toContain("Creating Storage bucket: remote");
      // Two POST /bucket calls — both buckets seeded.
      expect(
        requests.filter((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toHaveLength(2);
    });
  });

  it.live("local run uses base config (no [remotes.*] merge)", () => {
    // Without --linked, the base [storage.buckets.base] is used verbatim.
    const remoteRef = LEGACY_VALID_REF;
    const { layer, out, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        'project_id = "test"',
        "[storage.buckets.base]",
        "public = true",
        "[remotes.production]",
        `project_id = "${remoteRef}"`,
        "[remotes.production.storage.buckets.remote]",
        "public = false",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "base" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: base");
      expect(out.stderrText).not.toContain("Creating Storage bucket: remote");
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 2 — validate bucket names up front
  // ---------------------------------------------------------------------------

  it.live("fails with exact error message on an invalid bucket name", () => {
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      // "good-name" is valid; "bad/name" contains "/" which is not in Go's allowed set.
      toml: [
        "[storage.buckets.good-name]",
        "public = true",
        '[storage.buckets."bad/name"]',
        "public = false",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      // JSON.stringify escapes backslashes once more, so \\w in the message
      // becomes \\\\w in the JSON string — use the double-escaped form.
      expect(JSON.stringify(exit)).toContain(
        "Invalid Bucket name: bad/name. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (^(\\\\w|!|-|\\\\.|\\\\*|'|\\\\(|\\\\)| |&|\\\\$|@|=|;|:|\\\\+|,|\\\\?)*$)",
      );
      // Validation fails before any Storage call.
      expect(requests).toHaveLength(0);
    });
  });

  it.live("accepts valid bucket names that use allowed special characters", () => {
    // Bucket names with spaces, dots, underscores, etc. are valid per Go's regex.
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        '[storage.buckets."my.bucket"]',
        "public = true",
        '[storage.buckets."my-bucket"]',
        "public = true",
        '[storage.buckets."my_bucket"]',
        "public = true",
      ].join("\n"),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(3);
    });
  });

  // ---------------------------------------------------------------------------
  // Fix 3 — SUPABASE_AUTH_JWT_SECRET / SUPABASE_AUTH_SERVICE_ROLE_KEY for local
  // ---------------------------------------------------------------------------

  it.live("local run: SUPABASE_AUTH_JWT_SECRET overrides auth.jwt_secret", () => {
    const prevJwt = process.env["SUPABASE_AUTH_JWT_SECRET"];
    const prevKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    // Use a custom secret; the derived JWT will differ from the default secret's JWT.
    process.env["SUPABASE_AUTH_JWT_SECRET"] = "custom-jwt-secret-at-least-32-chars-long!";
    delete process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[auth]",
        'jwt_secret = "toml-secret-should-be-ignored-when-env-set-xxxxx"',
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
      // A derived JWT is sent (not opaque sb_ key), so Authorization is present.
      expect(
        requests.every((r) => (r.headers["authorization"] ?? "").startsWith("Bearer ey")),
      ).toBe(true);
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prevJwt === undefined) {
            delete process.env["SUPABASE_AUTH_JWT_SECRET"];
          } else {
            process.env["SUPABASE_AUTH_JWT_SECRET"] = prevJwt;
          }
          if (prevKey === undefined) {
            delete process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
          } else {
            process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = prevKey;
          }
        }),
      ),
    );
  });

  it.live("local run: SUPABASE_AUTH_SERVICE_ROLE_KEY overrides auth.service_role_key", () => {
    const prevJwt = process.env["SUPABASE_AUTH_JWT_SECRET"];
    const prevKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-local-service-role-key";
    delete process.env["SUPABASE_AUTH_JWT_SECRET"];
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: [
        "[auth]",
        'service_role_key = "toml-key-should-be-ignored"',
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
      expect(requests.every((r) => r.headers["apikey"] === "env-local-service-role-key")).toBe(
        true,
      );
    }).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          if (prevJwt === undefined) {
            delete process.env["SUPABASE_AUTH_JWT_SECRET"];
          } else {
            process.env["SUPABASE_AUTH_JWT_SECRET"] = prevJwt;
          }
          if (prevKey === undefined) {
            delete process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
          } else {
            process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = prevKey;
          }
        }),
      ),
    );
  });

  // ---------------------------------------------------------------------------
  // Fix 5 — validate api.tls cert/key pairing before seeding
  // ---------------------------------------------------------------------------

  it.live("fails when cert_path is set but key_path is missing", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "custom-ca.crt"),
      "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n",
    );
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Missing required field in config: api.tls.key_path");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when key_path is set but cert_path is missing", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "custom-ca.key"),
      "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----\n",
    );
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\nkey_path = "custom-ca.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Missing required field in config: api.tls.cert_path");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when cert_path points to an unreadable file", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "missing-cert.crt"\nkey_path = "missing-key.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to read TLS cert:");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when key_path points to an unreadable file", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    // cert is readable, key is missing.
    writeFileSync(
      join(tmp.current, "supabase", "custom-ca.crt"),
      "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n",
    );
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\nkey_path = "missing-key.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to read TLS key:");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("skips TLS validation when api.enabled is false (Go gates on c.Api.Enabled)", () => {
    // Go resolves and validates cert/key only inside `if c.Api.Enabled` blocks
    // (config.go:795, 841), so a config with [api] enabled=false, [api.tls]
    // enabled=true and only cert_path set is valid under the Go loader and must
    // NOT fail here on the missing key_path — it seeds normally instead.
    const { layer, requests } = setupLegacySeedBuckets(tmp.current, {
      toml: '[api]\nenabled = false\n[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\n[storage.buckets.docs]\npublic = false\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* legacySeedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });
});
