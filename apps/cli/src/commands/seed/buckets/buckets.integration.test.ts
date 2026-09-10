import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach } from "vitest";
import { loadCliConfig } from "@supabase/config/internal";
import { Effect, Exit, Layer, Option } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import type * as HttpClientError from "effect/unstable/http/HttpClientError";

import { mockOutput, mockStdin, mockTty } from "../../../../tests/helpers/mocks.ts";
import {
  VALID_REF,
  jsonResponse,
  statusCodeFailure,
  transportFailure,
  withEnvVar,
  mockCommandSettings,
  mockCommandPlatformApiService,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../../tests/helpers/command-mocks.ts";
import { CliArgs } from "../../../shared/cli/cli-args.service.ts";
import { YesFlag } from "../../../command-internal/global-flags.ts";
import type { OutputFormat } from "../../../shared/output/types.ts";
import { ProjectRefResolver } from "../../../config/project-ref.service.ts";
import { ProjectRefNotLinkedError } from "../../../config/project-ref.errors.ts";
import { generateGoJwt } from "../../../command-internal/go-jwt.ts";
import { seedBucketsRun } from "../../../command-internal/seed-buckets.ts";
import { seedBuckets } from "./buckets.handler.ts";
import type { BucketsFlags } from "./buckets.command.ts";
import { CommandPlatformApi } from "../../../auth/command-platform-api.service.ts";
import { CommandPlatformApiFactory } from "../../../auth/command-platform-api-factory.service.ts";

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

const DEFAULT_FLAGS: BucketsFlags = { linked: false, local: true, projectRef: Option.none() };

function setupSeedBuckets(
  workdir: string,
  opts: {
    readonly toml?: string;
    readonly routes?: ReadonlyArray<MockRoute>;
    readonly files?: Readonly<Record<string, string>>;
    readonly format?: OutputFormat;
    readonly confirm?: ReadonlyArray<boolean>;
    readonly promptConfirmFail?: boolean;
    /** Piped (non-TTY) stdin answers, one consumed per confirmation prompt. */
    readonly pipedAnswers?: ReadonlyArray<string>;
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
    /** When true, loadProjectRef fails with ProjectRefNotLinkedError. */
    readonly linkedFails?: boolean;
    /** When set, the Management API `getProjectApiKeys` call fails with this error. */
    readonly apiKeysFail?: HttpClientError.HttpClientError;
    /** cliSettings.explicitWorkdir override — true iff --workdir/SUPABASE_WORKDIR was set verbatim. */
    readonly explicitWorkdir?: boolean;
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
        return Effect.succeed(jsonResponse(request, 404, { message: "no mock route" }));
      }
      if (route.transport === true) {
        return Effect.fail(transportFailure(request, route.transportDescription));
      }
      return Effect.succeed(jsonResponse(request, route.status ?? 200, route.body ?? {}));
    }),
  );

  const telemetry = mockTelemetryStateTracked();
  const linkedCache = mockLinkedProjectCacheTracked();

  const projectRefRef = opts.projectRef ?? VALID_REF;
  const projectRefLayer = Layer.succeed(ProjectRefResolver, {
    resolve: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(projectRefRef),
    resolveForLink: () =>
      opts.linkedFails === true
        ? Effect.fail(
            new ProjectRefNotLinkedError({
              message: "Cannot find project ref. Have you run supabase link?",
            }),
          )
        : Effect.succeed(projectRefRef),
    resolveOptional: () => Effect.succeed(Option.some(projectRefRef)),
    // An explicit `--project-ref` flag takes precedence and short-circuits
    // before `linkedFails`, so a test can prove the flag resolves a ref even
    // for an "unlinked" workdir.
    loadProjectRef: (flagValue: Option.Option<string>) =>
      Option.isSome(flagValue) && flagValue.value.length > 0
        ? Effect.succeed(flagValue.value)
        : opts.linkedFails === true
          ? Effect.fail(
              new ProjectRefNotLinkedError({
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
  const managementApi = mockCommandPlatformApiService({
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
    mockCommandSettings({ workdir, explicitWorkdir: opts.explicitWorkdir ?? false }),
    BunServices.layer,
    // Seed-bucket prompts model an interactive user answering via `confirm`.
    mockTty({ stdinIsTty: true, stdoutIsTty: false }),
    mockStdin(true, opts.pipedAnswers ? `${opts.pipedAnswers.join("\n")}\n` : undefined),
    Layer.succeed(CliArgs, { args: opts.args ?? ["seed", "buckets"] }),
    Layer.succeed(YesFlag, opts.yes ?? false),
    projectRefLayer,
    Layer.succeed(CommandPlatformApiFactory, {
      make: CommandPlatformApi.pipe(Effect.provide(managementApi.layer)),
    }),
    linkedCache.layer,
  );

  return { layer, out, requests, telemetry, linkedCache };
}

const VECTOR_LIST = "/storage/v1/vector/ListVectorBuckets";
const VECTOR_CREATE = "/storage/v1/vector/CreateVectorBucket";
const VECTOR_DELETE = "/storage/v1/vector/DeleteVectorBucket";

// A known-good dotenvx test vector: this ciphertext decrypts to "value" under the keypair below.
const VAULT_PRIVATE_KEY = "7fd7210cef8f331ee8c55897996aaaafd853a2b20a4dc73d6d75759f65d2a7eb";
const VAULT_ENCRYPTED =
  "encrypted:BKiXH15AyRzeohGyUrmB6cGjSklCrrBjdesQlX1VcXo/Xp20Bi2gGZ3AlIqxPQDmjVAALnhZamKnuY73l8Dz1P+BYiZUgxTSLzdCvdYUyVbNekj2UudbdUizBViERtZkuQwZHIv/";

describe("seed buckets", () => {
  const tmp = useTempWorkdir("supabase-seed-buckets-");

  // Ambient SUPABASE_API_*/SUPABASE_AUTH_* values and the dotenvx private-key
  // env vars would shadow the dotenv fixtures below, so pin them unset for
  // every test here (the ambient-override test restores its own via `withEnvVar`).
  const OVERRIDE_ENV_KEYS = [
    "SUPABASE_API_ENABLED",
    "SUPABASE_API_EXTERNAL_URL",
    "SUPABASE_API_PORT",
    "SUPABASE_API_TLS_ENABLED",
    "SUPABASE_API_TLS_CERT_PATH",
    "SUPABASE_API_TLS_KEY_PATH",
    "SUPABASE_AUTH_JWT_SECRET",
    "SUPABASE_AUTH_SERVICE_ROLE_KEY",
    "DOTENV_PRIVATE_KEY",
    "DOTENV_PRIVATE_KEY_LOCAL",
  ] as const;
  let savedOverrideEnv: Record<string, string | undefined> = {};
  beforeEach(() => {
    savedOverrideEnv = {};
    for (const key of OVERRIDE_ENV_KEYS) {
      savedOverrideEnv[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of OVERRIDE_ENV_KEYS) {
      const previous = savedOverrideEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it.live("short-circuits with no output when nothing is configured", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: 'project_id = "test"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      expect(out.stderrText).toBe("");
    });
  });

  it.live(
    "hard-fails a malformed SUPABASE_API_PORT even when nothing is configured to seed",
    () => {
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: 'project_id = "test"\n',
        files: { "supabase/.env": "SUPABASE_API_PORT=not-a-port\n" },
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("Invalid config for api.port: cannot parse");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "hard-fails a broken TLS cert/key pairing even when nothing is configured to seed",
    () => {
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: 'project_id = "test"\n[api.tls]\nenabled = true\ncert_path = "kong.crt"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain(
          "Missing required field in config: api.tls.key_path",
        );
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "hard-fails an undecryptable encrypted: service_role_key even when nothing is configured to seed",
    () => {
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: 'project_id = "test"\n[auth]\nservice_role_key = "encrypted:not-a-real-ciphertext"\n',
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("failed to parse config");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("emits an empty JSON result for a no-op run (json mode)", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: 'project_id = "test"\n',
      format: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["buckets_created"]).toEqual([]);
      expect(success?.data?.["objects_uploaded"]).toEqual([]);
    });
  });

  // --local/--linked mutual exclusivity is enforced at the command level, so it
  // doesn't reach this handler; see `assertSeedTargetsExclusive` in
  // buckets.flags.unit.test.ts for that coverage.

  it.live("tolerates null string fields in 200 responses (Go encoding/json zero value)", () => {
    // A JSON `null` for a string field decodes to "" and must not abort — a
    // list entry with `name: null` and a create response with `message: null`
    // are both tolerated, not treated as a parse failure.
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.docs]\npublic = false\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: null, id: "legacy" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { message: null } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: docs");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("tolerates a null element in a bucket list (Go zero-value struct)", () => {
    // A null array element decodes to an empty-name entry and must not abort
    // the run; the configured bucket is still created. A genuine type mismatch
    // (string/number element) still aborts — see the malformed-response test.
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.docs]\npublic = false\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [null, { name: "other", id: "o" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: docs");
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("creates a new bucket and updates an existing one (overwrite default yes)", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
      ],
      confirm: [false],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).not.toContain("Updating Storage bucket");
      expect(requests.some((r) => r.method === "PUT")).toBe(false);
    });
  });

  it.live(
    "honors a piped decline for the overwrite prompt when non-interactive (db reset path)",
    () => {
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
        toml: "[storage.buckets.test]\npublic = true\n",
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
        ],
        pipedAnswers: ["n"],
      });
      return Effect.gen(function* () {
        // interactive: false doesn't silently take the default — the prompt
        // still prints its label, scans one line, and honors the parsed
        // answer, so the piped "n" skips the overwrite (default is yes).
        const exit = yield* seedBucketsRun({
          projectRef: "",
          emitSummary: false,
          interactive: false,
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(
          "already exists. Do you want to overwrite its properties?",
        );
        expect(out.stderrText).not.toContain("Updating Storage bucket");
        expect(requests.some((r) => r.method === "PUT")).toBe(false);
      });
    },
  );

  it.live("creates configured vector buckets and leaves stale ones (prune default no)", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Updating vector buckets...");
      expect(out.stderrText).toContain("Creating vector bucket: documents-openai");
      expect(out.stderrText).toContain("Bucket already exists: existing-vec");
      expect(requests.some((r) => r.url.includes(VECTOR_CREATE))).toBe(true);
      expect(requests.some((r) => r.url.includes(VECTOR_DELETE))).toBe(false);
    });
  });

  it.live("treats a null vectorBuckets list as empty (Go nil slice)", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: VECTOR_LIST, body: { vectorBuckets: null } },
        { method: "POST", match: VECTOR_CREATE, body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating vector bucket: documents-openai");
      expect(requests.some((r) => r.url.includes(VECTOR_CREATE))).toBe(true);
    });
  });

  it.live("prunes a stale vector bucket when the prompt is accepted", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Pruning vector bucket: stale-vec");
      expect(requests.some((r) => r.url.includes(VECTOR_DELETE))).toBe(true);
    });
  });

  it.live(
    "prunes a stale vector bucket when the caller passes yes (db reset project-env path)",
    () => {
      // db reset resolves `yes` from the nested project `.env` and passes it with
      // `interactive: false`; the pre-resolved `yes` must drive pruning even
      // though no prompt is answered and resolveYes would otherwise default to false.
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
        // No `confirm` and no `--yes` flag — pruning is driven solely by the passed `yes`.
      });
      return Effect.gen(function* () {
        yield* seedBucketsRun({
          projectRef: "",
          emitSummary: false,
          interactive: false,
          yes: true,
        }).pipe(Effect.provide(layer));
        expect(out.stderrText).toContain("Pruning vector bucket: stale-vec");
        expect(requests.some((r) => r.url.includes(VECTOR_DELETE))).toBe(true);
      });
    },
  );

  it.live("warns and continues when vector buckets are unavailable in the region", () => {
    const { layer, out } = setupSeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: VECTOR_LIST, status: 400, body: { code: "FeatureNotEnabled" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("WARNING:");
      expect(out.stderrText).toContain(
        "Vector buckets are not available in this project's region yet",
      );
    });
  });

  it.live("warns and continues when the local vector service is unavailable", () => {
    const { layer, out } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain(
        "Vector buckets are not available in the local storage service",
      );
      expect(out.stderrText).toContain("supabase link");
      expect(out.stderrText).toContain("restart the local stack");
    });
  });

  it.live("propagates an unclassified vector error", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.vector.buckets.documents-openai]\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: VECTOR_LIST, status: 500, body: { message: "boom" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("uploads objects from a bucket's objects_path", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      // Relative objects_path resolves under supabase/.
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
      expect(out.stderrText).toContain("Uploading: supabase/assets/sub/b.txt => images/sub/b.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(2);
    });
  });

  it.live("sets the object Content-Type from the file bytes, not the extension", () => {
    // Content-type is sniffed from the first 512 bytes; only a generic
    // text/plain sniff is refined by extension. A PNG named `.txt` uploads as
    // image/png (bytes win), and a JSON text file refines to application/json.
    mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
    // Real PNG magic bytes — written raw (a UTF-8 string would mangle 0x89).
    writeFileSync(
      join(tmp.current, "supabase", "assets", "logo.txt"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]),
    );
    writeFileSync(join(tmp.current, "supabase", "assets", "data.json"), '{"a":1}');
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      const byKey = (suffix: string) => uploads.find((r) => r.url.endsWith(suffix));
      expect(byKey("images/logo.txt")?.headers["content-type"]).toBe("image/png");
      expect(byKey("images/data.json")?.headers["content-type"]).toBe("application/json");
    });
  });

  it.live("resolves an absolute objects_path as-is (Go IsAbs guard)", () => {
    const absRoot = join(tmp.current, "external-assets");
    mkdirSync(absRoot, { recursive: true });
    writeFileSync(join(absRoot, "a.txt"), "hello");
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      // An absolute objects_path is left untouched — no supabase/ prefix.
      toml: `[storage.buckets.images]\npublic = true\nobjects_path = "${absRoot}"\n`,
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain(`Uploading: ${join(absRoot, "a.txt")} => images/a.txt`);
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live("fails with a config-load error on malformed config.toml", () => {
    const { layer } = setupSeedBuckets(tmp.current, { toml: "[storage\n" });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("emits a structured result and suppresses prompts in json mode", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "test", id: "test" }] },
        { method: "PUT", match: "/storage/v1/bucket/test", body: {} },
      ],
      format: "json",
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.promptConfirmCalls).toHaveLength(0);
      expect(requests.some((r) => r.method === "PUT" && r.url.includes("/bucket/test"))).toBe(true);
    });
  });

  it.live("treats a missing config file as embedded defaults: local no-op, no text output", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {});
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      expect(out.stderrText).toBe("");
    });
  });

  it.live("emits an empty JSON result for a missing config file (local no-op, json mode)", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, { format: "json" });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests).toHaveLength(0);
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data?.["buckets_created"]).toEqual([]);
      expect(success?.data?.["objects_uploaded"]).toEqual([]);
    });
  });

  it.live("does not skip a --linked run when the config file is absent", () => {
    // A linked run never short-circuits on empty config: even with no config
    // file, the remote client is built, the service-role key fetched, and
    // buckets listed — failures surface instead of a silent success.
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      projectRef: VALID_REF,
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
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some(
          (r) =>
            r.method === "GET" &&
            r.url.startsWith(`https://${VALID_REF}.supabase.co`) &&
            r.url.includes("/storage/v1/bucket"),
        ),
      ).toBe(true);
    });
  });

  it.live("honors an explicit external_url and service_role_key", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.url.startsWith("http://gateway.test:9999"))).toBe(true);
      expect(requests.every((r) => r.headers["apikey"] === "explicit-key")).toBe(true);
      expect(requests.every((r) => r.headers["authorization"] === "Bearer explicit-key")).toBe(
        true,
      );
    });
  });

  it.live("omits the Authorization header for an opaque sb_ service key", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.headers["apikey"] === "sb_secret_localkey")).toBe(true);
      expect(requests.every((r) => r.headers["authorization"] === undefined)).toBe(true);
    });
  });

  it.live("regenerates the service-role key when it is set to an empty string", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: ["[auth]", 'service_role_key = ""', "[storage.buckets.media]", "public = true"].join(
        "\n",
      ),
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.every((r) => (r.headers["authorization"] ?? "").startsWith("Bearer ey")),
      ).toBe(true);
    });
  });

  it.live("rejects a jwt_secret shorter than 16 characters", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[auth]\njwt_secret = "tooshort"\n[storage.buckets.media]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        "Invalid config for auth.jwt_secret. Must be at least 16 characters",
      );
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails on an invalid bucket file_size_limit before any Storage call", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // First bucket is valid; the second has an unparseable size — all sizes
      // are parsed at config-load, before any Storage call, so nothing is mutated.
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("rejects a malformed file_size_limit numeral (Go strconv.ParseFloat)", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // parseFloat would parse "1.2.3" as 1.2; the whole config must be
      // rejected instead.
      toml: '[storage.buckets.media]\npublic = true\nfile_size_limit = "1.2.3MiB"\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails on an invalid storage-level file_size_limit (only vector buckets)", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // No storage buckets inherit it, only a vector bucket is configured — the
      // storage-level file_size_limit is still validated at config-load and aborts.
      toml: [
        '[storage]\nfile_size_limit = "bogus"',
        "[storage.vector]\nenabled = true",
        "[storage.vector.buckets.docs-openai]",
      ].join("\n"),
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails on an invalid storage-level file_size_limit even with nothing to seed", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // No buckets and no vector buckets — the storage-level file_size_limit is
      // still validated at config-load, before the no-op short-circuit, so it
      // still aborts.
      toml: '[storage]\nfile_size_limit = "bogus"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("invalid size");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("inherits the storage-level file_size_limit when a bucket omits it", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // Custom storage-level limit; the bucket omits file_size_limit, so the
      // storage-level value (5MiB) is inherited.
      toml: '[storage]\nfile_size_limit = "5MiB"\n[storage.buckets.media]\npublic = true\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "media" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  it.live("propagates a transport failure from the Storage gateway", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("appends Go's port-conflict hint on a malformed local response", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const s = JSON.stringify(exit);
      expect(s).toContain("Another process may be listening on the configured API port 7654");
      expect(s).toContain("lsof -nP -iTCP:7654 -sTCP:LISTEN");
    });
  });

  it.live("omits the port-conflict hint on a connection-refused local failure", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      // Stack simply stopped → ECONNREFUSED. The local-gateway hint only fires
      // for malformed/timeout failures, not connection-refused.
      toml: "[api]\nport = 7654\n[storage.buckets.test]\npublic = true\n",
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("reports the external_url port (not api.port) in the local hint", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      // external_url overrides the host:port the gateway targets, so the hint
      // reports 9999, not 7654.
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const s = JSON.stringify(exit);
      expect(s).toContain("configured API port 9999");
      expect(s).not.toContain("port 7654");
    });
  });

  it.live("omits the port-conflict hint for a non-loopback external_url", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: '[api]\nexternal_url = "http://gateway.test:9999"\n[storage.buckets.test]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("omits the port-conflict hint on a --linked (remote) transport failure", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", transport: true }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: true,
        local: false,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).not.toContain("Another process may be listening");
    });
  });

  it.live("fails when a bucket create returns a non-object body (Go ParseJSON)", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        // Go decodes the create 200 body into {name}; a non-object body fails.
        { method: "POST", match: "/storage/v1/bucket", body: [] },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse response body");
    });
  });

  it.live("skips vector seeding when enabled but no vector buckets are configured", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.vector]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).not.toContain("Updating vector buckets...");
      expect(requests.some((r) => r.url.includes("/vector/"))).toBe(false);
    });
  });

  it.live("falls back to the default host when external_url is empty", () => {
    // Clear both host overrides so getHostname resolves to loopback
    // deterministically, regardless of the test environment's DOCKER_HOST.
    const previousServices = process.env["SUPABASE_SERVICES_HOSTNAME"];
    const previousDocker = process.env["DOCKER_HOST"];
    delete process.env["SUPABASE_SERVICES_HOSTNAME"];
    delete process.env["DOCKER_HOST"];
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api]\nexternal_url = ""\n[storage.buckets.images]\npublic = true\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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

  it.live("calls the gateway on the SUPABASE_API_PORT override, not the config.toml port", () => {
    // Setup runs before the env mutation so a throwing mkdir/write can never
    // leak the override into later tests.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return withEnvVar(
      "SUPABASE_API_PORT",
      "55511",
      Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.length).toBeGreaterThan(0);
        expect([...new Set(requests.map((r) => new URL(r.url).port))]).toEqual(["55511"]);
      }),
    );
  });

  it.live("honors a SUPABASE_API_PORT set only in supabase/.env", () => {
    // The dotenv walk participates in the override, same as the other
    // `projectEnvValues` consumers — no ambient env needed.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_PORT=55512\n" },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect([...new Set(requests.map((r) => new URL(r.url).port))]).toEqual(["55512"]);
    });
  });

  it.live(
    "switches the gateway to https when SUPABASE_API_TLS_ENABLED overrides the config",
    () => {
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
        files: { "supabase/.env": "SUPABASE_API_TLS_ENABLED=true\n" },
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every((r) => r.url.startsWith("https:"))).toBe(true);
      });
    },
  );

  it.live("rejects SUPABASE_API_PORT=0 with the canonical missing-field error", () => {
    // `api.enabled` with a zero port is invalid config (`validateResolvedConfig`);
    // the override must not smuggle a zero port into the gateway URL.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_PORT=0\n" },
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Missing required field in config: api.port");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("allows a zero api.port when the API is disabled, matching config validation", () => {
    // The canonical zero-port rejection is gated on `api.enabled`
    // (`validateResolvedConfig`); a disabled API with port 0 proceeds.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nenabled = false\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_PORT=0\n" },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
    });
  });

  it.live("hard-fails on a malformed SUPABASE_API_PORT override before any gateway call", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_PORT=not-a-port\n" },
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Invalid config for api.port: cannot parse");
      expect(JSON.stringify(exit)).toContain("not-a-port");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("honors a SUPABASE_API_EXTERNAL_URL set only in supabase/.env", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_EXTERNAL_URL=http://127.0.0.1:55513\n" },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.url.startsWith("http://127.0.0.1:55513/"))).toBe(true);
    });
  });

  it.live("lets an external_url override win over a port override", () => {
    // `resolveApiExternalUrl`: a non-empty external_url short-circuits
    // the scheme://host:port derivation, so the port override is inert here.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      files: {
        "supabase/.env":
          "SUPABASE_API_EXTERNAL_URL=http://127.0.0.1:55514\nSUPABASE_API_PORT=59999\n",
      },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect([...new Set(requests.map((r) => new URL(r.url).port))]).toEqual(["55514"]);
    });
  });

  it.live(
    "turns TLS cert validation on when SUPABASE_API_ENABLED=true overrides the config",
    () => {
      // The override works in both directions: a config with `enabled = false`
      // skips the cert/key pairing check, so flipping it on via env must restore
      // the established missing-field rejection.
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: '[api]\nenabled = false\n[api.tls]\nenabled = true\ncert_path = "kong.crt"\n[storage.buckets.images]\npublic = true\n',
        files: { "supabase/.env": "SUPABASE_API_ENABLED=true\n" },
        routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain(
          "Missing required field in config: api.tls.key_path",
        );
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live("skips TLS cert validation when SUPABASE_API_ENABLED=false overrides the config", () => {
    // cert_path without key_path fails validation when the gate is on; the
    // env-overridden `api.enabled` must switch that gate off, exactly like the
    // raw config value would.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "kong.crt"\n[storage.buckets.images]\npublic = true\n',
      files: { "supabase/.env": "SUPABASE_API_ENABLED=false\n" },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      // tls.enabled still picks the scheme; only the cert/key validation is gated.
      expect(requests.every((r) => r.url.startsWith("https:"))).toBe(true);
    });
  });

  it.live("reads TLS cert/key paths supplied through env overrides", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      files: {
        "supabase/.env":
          "SUPABASE_API_TLS_CERT_PATH=kong.crt\nSUPABASE_API_TLS_KEY_PATH=kong.key\n",
        "supabase/kong.crt": "-----BEGIN CERTIFICATE-----\nstub\n-----END CERTIFICATE-----\n",
        "supabase/kong.key": "-----BEGIN PRIVATE KEY-----\nstub\n-----END PRIVATE KEY-----\n",
      },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.url.startsWith("https:"))).toBe(true);
    });
  });

  it.live("fails on an env-supplied cert path without a key path", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_TLS_CERT_PATH=kong.crt\n" },
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Missing required field in config: api.tls.key_path");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("hard-fails on a malformed SUPABASE_API_TLS_ENABLED override", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_API_TLS_ENABLED=notabool\n" },
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Invalid config for api.tls.enabled: cannot parse");
      expect(JSON.stringify(exit)).toContain("notabool");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("sends a SUPABASE_AUTH_SERVICE_ROLE_KEY set only in supabase/.env as the api key", () => {
    // The auth vars go through the same env/dotenv override composition as the
    // SUPABASE_API_* family.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": "SUPABASE_AUTH_SERVICE_ROLE_KEY=sb_secret_dotenv_only_key\n" },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.headers["apikey"] === "sb_secret_dotenv_only_key")).toBe(true);
    });
  });

  it.live("derives the api key from a SUPABASE_AUTH_JWT_SECRET set only in supabase/.env", () => {
    const secret = "a-dotenv-only-secret-at-least-16-chars";
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      files: { "supabase/.env": `SUPABASE_AUTH_JWT_SECRET=${secret}\n` },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      const apiKey = generateGoJwt(secret, "service_role");
      expect(requests.every((r) => r.headers["apikey"] === apiKey)).toBe(true);
    });
  });

  it.live("decrypts an encrypted: service_role_key with the private key from supabase/.env", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: `[auth]\nservice_role_key = "${VAULT_ENCRYPTED}"\n[storage.buckets.images]\npublic = true\n`,
      files: { "supabase/.env": `DOTENV_PRIVATE_KEY=${VAULT_PRIVATE_KEY}\n` },
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.headers["apikey"] === "value")).toBe(true);
    });
  });

  it.live("hard-fails an undecryptable encrypted: service_role_key before any gateway call", () => {
    // An undecryptable `encrypted:` value aborts instead of being sent as
    // literal key material.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[auth]\nservice_role_key = "encrypted:not-a-real-ciphertext"\n[storage.buckets.images]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse config");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("hard-fails an undecryptable encrypted: jwt_secret before any gateway call", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[auth]\njwt_secret = "encrypted:not-a-real-ciphertext"\n[storage.buckets.images]\npublic = true\n',
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse config");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("tolerates bucket entries with a missing field (Go zero value)", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        // A missing `name` decodes to "" and is tolerated (non-object elements
        // and wrong-typed fields are not — see below).
        { method: "GET", match: "/storage/v1/bucket", body: [{ id: "x" }] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.some((r) => r.method === "POST")).toBe(true);
    });
  });

  it.live("fails on a malformed bucket-list response before any mutation", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        // A non-object element or wrong-typed field aborts parsing before any
        // create.
        {
          method: "GET",
          match: "/storage/v1/bucket",
          body: [{ id: "x" }, "not-an-object", { name: 42, id: "y" }],
        },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to parse response body");
      expect(requests.some((r) => r.method === "POST")).toBe(false);
    });
  });

  it.live("fails on a non-array bucket-list response (misrouted gateway)", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: { message: "not an array" } },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(requests.some((r) => r.method === "POST")).toBe(false);
    });
  });

  it.live("treats a non-200 2xx gateway response as an error (Go expects exactly 200)", () => {
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", status: 201, body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Error status 201");
    });
  });

  it.live(
    "trusts the Kong CA for an explicit https external_url even when tls.enabled is false",
    () => {
      // An https external_url always takes the CA-injection path (no
      // validation, no error), regardless of `tls.enabled`.
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: '[api]\nexternal_url = "https://127.0.0.1:54321"\n[storage.buckets.images]\npublic = true\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(requests.every((r) => r.url.startsWith("https://127.0.0.1:54321"))).toBe(true);
      });
    },
  );

  it.live("builds an https base URL with a host override when tls is enabled", () => {
    const previousHost = process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "docker.host";
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 7654\n[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // IPv6 hosts are bracketed: http://[::1]:54321, not http://::1:54321.
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
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Dials the TCP daemon host, not loopback, when only DOCKER_HOST is set.
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
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Skipping non-regular file: supabase/assets/dangling");
      expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live("skips OS metadata files during the object walk (CLI-1950)", () => {
    // These files must never even be attempted for upload — covering the
    // "silently becomes a public object" failure mode, not just an
    // upload-time abort.
    mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "assets", "a.txt"), "hello");
    writeFileSync(join(tmp.current, "supabase", "assets", ".DS_Store"), "junk");
    writeFileSync(join(tmp.current, "supabase", "assets", "Thumbs.db"), "junk");
    writeFileSync(join(tmp.current, "supabase", "assets", "desktop.ini"), "junk");
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Skipping OS metadata file: supabase/assets/.DS_Store");
      expect(out.stderrText).toContain("Skipping OS metadata file: supabase/assets/Thumbs.db");
      expect(out.stderrText).toContain("Skipping OS metadata file: supabase/assets/desktop.ini");
      expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live(
    "skips a .DS_Store file in a MIME-restricted bucket instead of uploading it (CLI-1950)",
    () => {
      // The mock HTTP route doesn't enforce allowed_mime_types server-side
      // (real Storage-service behavior), so this doesn't simulate a 415 — it
      // only asserts the junk file is skipped client-side while the real image
      // still uploads.
      mkdirSync(join(tmp.current, "supabase", "assets"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "assets", "logo.png"), "fake-png-bytes");
      writeFileSync(join(tmp.current, "supabase", "assets", ".DS_Store"), "junk");
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
        toml: [
          "[storage.buckets.images]",
          "public = true",
          'allowed_mime_types = ["image/png"]',
          'objects_path = "./assets"',
        ].join("\n"),
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/object/", body: {} },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain("Skipping OS metadata file: supabase/assets/.DS_Store");
        expect(out.stderrText).toContain("Uploading: supabase/assets/logo.png => images/logo.png");
        const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
        expect(uploads).toHaveLength(1);
      });
    },
  );

  it.live("skips a .DS_Store file when objects_path points directly at it (CLI-1950)", () => {
    // Covers collectFiles' single-file branch: objects_path resolves directly to
    // a junk-named file rather than a directory.
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", ".DS_Store"), "junk");
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./.DS_Store"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Skipping OS metadata file: supabase/.DS_Store");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(0);
    });
  });

  // Root bypasses POSIX permission bits, so chmod 000 wouldn't block open() there
  // and the open-vs-stat distinction this test relies on would vanish.
  const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
  it.live.skipIf(isRoot)(
    "skips a symlink to an unreadable regular file and keeps seeding siblings (Go opens, not stats)",
    () => {
      // The symlink target is opened, not just stat'd, so mode 000 (stat
      // succeeds, open fails) is skipped rather than aborting the run. The
      // unreadable file must live outside the walked tree — a plain file there
      // would be queued and legitimately abort.
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
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
        toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/object/", body: {} },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(
          "Skipping non-regular file: supabase/assets/link-to-secret",
        );
        expect(out.stderrText).toContain("Uploading: supabase/assets/a.txt => images/a.txt");
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
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
        toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./assets"\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/object/", body: {} },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    // A symlinked root is followed and its target walked; only nested
    // symlinks are skipped.
    mkdirSync(join(tmp.current, "supabase", "real-assets"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "real-assets", "a.txt"), "hello");
    symlinkSync("./real-assets", join(tmp.current, "supabase", "linked-assets"));
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: '[storage.buckets.images]\npublic = true\nobjects_path = "./linked-assets"\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/object/", body: {} },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Uploading: supabase/linked-assets/a.txt => images/a.txt");
      const uploads = requests.filter((r) => r.url.includes("/storage/v1/object/"));
      expect(uploads).toHaveLength(1);
    });
  });

  it.live("--yes overwrites an existing bucket and echoes Go's prompt line", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.assets]\npublic = true\n",
      yes: true,
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [{ name: "assets", id: "assets" }] },
        { method: "PUT", match: "/storage/v1/bucket/assets", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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

  it.live(
    "auto-confirms the overwrite from SUPABASE_YES in the project .env (Go loadNestedEnv, CLI-1878)",
    () => {
      // SUPABASE_YES lives only in supabase/.env, not the shell or --yes flag.
      // The standalone command must resolve it itself, not rely on the
      // `db reset`-passed `opts.yes`.
      const { layer, out, requests } = setupSeedBuckets(tmp.current, {
        toml: "[storage.buckets.assets]\npublic = true\n",
        files: { "supabase/.env": "SUPABASE_YES=true\n" },
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [{ name: "assets", id: "assets" }] },
          { method: "PUT", match: "/storage/v1/bucket/assets", body: {} },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain(
          "already exists. Do you want to overwrite its properties? [Y/n] y",
        );
        expect(out.stderrText).toContain("Updating Storage bucket: assets");
        expect(requests.some((r) => r.method === "PUT")).toBe(true);
      });
    },
  );

  it.live("--yes prunes a stale vector bucket and echoes Go's prompt line", () => {
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Bucket name + config path are bold-rendered, so assert the stable suffix.
      expect(out.stderrText).toContain("Do you want to prune it? [y/N] y");
      expect(requests.some((r) => r.url.endsWith(VECTOR_DELETE))).toBe(true);
    });
  });

  it.live("--linked seeds the remote storage project", () => {
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
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
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: test");
      expect(requests.some((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(true);
      expect(requests.some((r) => r.headers["apikey"] === "remote-service-role-key")).toBe(true);
    });
  });

  it.live(
    "--project-ref --linked seeds the project given by the flag, overriding VALID_REF",
    () => {
      // `opts.projectRef` (the fake's own fallback) is left at its default
      // (VALID_REF) — the flag must win over it and drive the storage
      // gateway host.
      const FLAG_REF = "flagflagflagflagflag";
      const { layer, out, requests, linkedCache } = setupSeedBuckets(tmp.current, {
        toml: "[storage.buckets.test]\npublic = true\n",
        args: ["seed", "buckets", "--linked"],
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets({
          linked: true,
          local: false,
          projectRef: Option.some(FLAG_REF),
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(out.stderrText).toContain("Creating Storage bucket: test");
        expect(requests.some((r) => r.url.startsWith(`https://${FLAG_REF}.supabase.co`))).toBe(
          true,
        );
        expect(requests.some((r) => r.url.includes(VALID_REF))).toBe(false);
        expect(linkedCache.cached).toBe(true);
        expect(linkedCache.cachedRef).toBe(FLAG_REF);
      });
    },
  );

  it.live("rejects --project-ref on the default local target", () => {
    // seed buckets defaults to local when no target flag is set — the guard
    // must fire from the flag alone, with no explicit --local needed.
    const FLAG_REF = "flagflagflagflagflag";
    const { layer, requests, linkedCache } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: false,
        local: true,
        projectRef: Option.some(FLAG_REF),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain(
          "--project-ref only applies when targeting the linked project; use it with --linked (not --local)",
        );
      }
      expect(requests).toEqual([]);
      expect(linkedCache.cached).toBe(false);
    });
  });

  it.live("--linked=false still takes the linked path (Go flag.Changed, not value)", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      args: ["seed", "buckets", "--linked=false"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: false,
        local: true,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => r.url.startsWith(`https://${VALID_REF}.supabase.co`))).toBe(
        true,
      );
    });
  });

  it.live("--local=false stays on the local path", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      args: ["seed", "buckets", "--local=false"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: false,
        local: false,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      // Asserts "some request happened, not the remote host" — keeps this
      // independent of the loopback host env.
      expect(requests.length).toBeGreaterThan(0);
      expect(requests.every((r) => r.url.startsWith("http://"))).toBe(true);
      expect(requests.some((r) => r.url.includes("supabase.co"))).toBe(false);
    });
  });

  it.live("--linked fails before any Storage call when the api-keys list is empty", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      apiKeys: [],
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: true,
        local: false,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Anon key not found.");
      expect(requests.some((r) => r.url.includes("/storage/v1/"))).toBe(false);
    });
  });

  it.live("--linked surfaces tenant.GetApiKeys auth error on a non-200 api-keys response", () => {
    // A non-200 api-keys response maps to `StorageAuthTokenError` with
    // "Authorization failed for the access token and project ref pair", not
    // the generic "unexpected get api keys status" message.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      apiKeysFail: statusCodeFailure(401),
      args: ["seed", "buckets", "--linked"],
      routes: [{ method: "GET", match: "/storage/v1/bucket", body: [] }],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets({
        linked: true,
        local: false,
        projectRef: Option.none(),
      }).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      const json = JSON.stringify(exit);
      expect(json).toContain("StorageAuthTokenError");
      expect(json).toContain("Authorization failed for the access token and project ref pair");
      expect(json).not.toContain("unexpected get api keys status");
      expect(requests.some((r) => r.url.includes("/storage/v1/"))).toBe(false);
    });
  });

  it.live("caches the linked project on --linked but not on local", () => {
    // Gated on a non-empty resolved ref: --linked writes the linked-project
    // cache and group identify; the local path does not.
    const linked = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    const local = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      yield* seedBuckets({ linked: true, local: false, projectRef: Option.none() }).pipe(
        Effect.provide(linked.layer),
        Effect.exit,
      );
      expect(linked.linkedCache.cached).toBe(true);
      expect(linked.linkedCache.cachedRef).toBe(VALID_REF);

      yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(local.layer), Effect.exit);
      expect(local.linkedCache.cached).toBe(false);
    });
  });

  it.live("--linked uses SUPABASE_AUTH_SERVICE_ROLE_KEY env var when set", () => {
    const prevKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"] = "env-service-role-key";
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      projectRef: VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
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
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: [
        "[storage.analytics]",
        "enabled = true",
        "[storage.analytics.buckets.analytics-bucket]",
        "[storage.buckets.test]",
        "public = true",
      ].join("\n"),
      projectRef: VALID_REF,
      args: ["seed", "buckets", "--linked"],
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
        { method: "GET", match: "/storage/v1/iceberg/bucket", body: [] },
        { method: "POST", match: "/storage/v1/iceberg/bucket", body: {} },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Updating analytics buckets...");
      expect(out.stderrText).toContain("Creating analytics bucket: analytics-bucket");
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/iceberg/bucket")),
      ).toBe(true);
    });
  });

  it.live("does not upsert analytics buckets on local runs", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.every((r) => !r.url.includes("/iceberg/"))).toBe(true);
    });
  });

  it.live("prunes a stale analytics bucket when the prompt is accepted", () => {
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
      toml: [
        "[storage.analytics]",
        "enabled = true",
        "[storage.analytics.buckets.keep-analytics]",
        "[storage.buckets.test]",
        "public = true",
      ].join("\n"),
      projectRef: VALID_REF,
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
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
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
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer } = setupSeedBuckets(tmp.current, {
      toml: "[storage.buckets.test]\npublic = true\n",
      linkedFails: true,
      args: ["seed", "buckets", "--linked"],
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });

  it.live("succeeds on the TLS local path and uses an https base URL", () => {
    // The mock replaces HttpClient.HttpClient directly (bypassing fetch), so
    // real TLS cert verification isn't exercised here — this only confirms the
    // embedded-CA resolution path doesn't throw and the gateway is called with
    // https:// URLs.
    const previousHost = process.env["SUPABASE_SERVICES_HOSTNAME"];
    process.env["SUPABASE_SERVICES_HOSTNAME"] = "localhost";
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: "[api]\nport = 54321\n[api.tls]\nenabled = true\n[storage.buckets.images]\npublic = true\n",
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "images" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    // Writes a dummy CA PEM and key to disk; both must be present and readable
    // for the handler to succeed.
    const certContent = "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n";
    const keyContent = "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----\n";
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(join(tmp.current, "supabase", "custom-ca.crt"), certContent);
    writeFileSync(join(tmp.current, "supabase", "custom-ca.key"), keyContent);
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api]\nport = 54321\n[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\nkey_path = "custom-ca.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live(
    "re-roots an absolute cert_path/key_path under supabase/ (Go path.Join, no IsAbs guard)",
    () => {
      // An absolute-looking "/tmp/kong.crt" is resolved relative to supabase/,
      // not the real /tmp — we only write the cert/key under supabase/tmp/, so
      // a handler that read the literal /tmp path would fail here.
      const certContent = "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n";
      const keyContent = "-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----\n";
      mkdirSync(join(tmp.current, "supabase", "tmp"), { recursive: true });
      writeFileSync(join(tmp.current, "supabase", "tmp", "kong.crt"), certContent);
      writeFileSync(join(tmp.current, "supabase", "tmp", "kong.key"), keyContent);
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        toml: '[api]\nport = 54321\n[api.tls]\nenabled = true\ncert_path = "/tmp/kong.crt"\nkey_path = "/tmp/kong.key"\n[storage.buckets.docs]\npublic = false\n',
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
        ],
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
        ).toBe(true);
      });
    },
  );

  it.live("--linked merges [remotes.*] storage config override before seeding", () => {
    // The remote block overrides `base.public` to false and adds a `remote`
    // bucket; `mergeRemoteConfig` merges subtrees recursively rather than
    // replacing [storage.buckets] wholesale, so both buckets are seeded.
    const remoteRef = VALID_REF;
    const flags: BucketsFlags = { linked: true, local: false, projectRef: Option.none() };
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(flags).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Loading config override: [remotes.production]");
      expect(out.stderrText).toContain("Creating Storage bucket: base");
      expect(out.stderrText).toContain("Creating Storage bucket: remote");
      expect(
        requests.filter((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toHaveLength(2);
    });
  });

  it.live("local run uses base config (no [remotes.*] merge)", () => {
    const remoteRef = VALID_REF;
    const { layer, out, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(out.stderrText).toContain("Creating Storage bucket: base");
      expect(out.stderrText).not.toContain("Creating Storage bucket: remote");
      expect(
        requests.some((r) => r.method === "POST" && r.url.includes("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live("fails with exact error message on an invalid bucket name", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      // "good-name" is valid; "bad/name" contains "/" which is not in the allowed set.
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      // JSON.stringify escapes backslashes once more, so \\w in the message
      // becomes \\\\w in the JSON string — use the double-escaped form.
      expect(JSON.stringify(exit)).toContain(
        "Invalid Bucket name: bad/name. Only lowercase letters, numbers, dots, hyphens, and spaces are allowed. (^(\\\\w|!|-|\\\\.|\\\\*|'|\\\\(|\\\\)| |&|\\\\$|@|=|;|:|\\\\+|,|\\\\?)*$)",
      );
      expect(requests).toHaveLength(0);
    });
  });

  it.live("accepts valid bucket names that use allowed special characters", () => {
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(requests.filter((r) => r.method === "POST")).toHaveLength(3);
    });
  });

  it.live("local run: SUPABASE_AUTH_JWT_SECRET overrides auth.jwt_secret", () => {
    const prevJwt = process.env["SUPABASE_AUTH_JWT_SECRET"];
    const prevKey = process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    // Use a custom secret; the derived JWT will differ from the default secret's JWT.
    process.env["SUPABASE_AUTH_JWT_SECRET"] = "custom-jwt-secret-at-least-32-chars-long!";
    delete process.env["SUPABASE_AUTH_SERVICE_ROLE_KEY"];
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
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
    const { layer, requests } = setupSeedBuckets(tmp.current, {
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
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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

  it.live("fails when cert_path is set but key_path is missing", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    writeFileSync(
      join(tmp.current, "supabase", "custom-ca.crt"),
      "-----BEGIN CERTIFICATE-----\nZHVtbXk=\n-----END CERTIFICATE-----\n",
    );
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\nkey_path = "custom-ca.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("Missing required field in config: api.tls.cert_path");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("fails when cert_path points to an unreadable file", () => {
    mkdirSync(join(tmp.current, "supabase"), { recursive: true });
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "missing-cert.crt"\nkey_path = "missing-key.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
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
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\nkey_path = "missing-key.key"\n[storage.buckets.docs]\npublic = false\n',
      routes: [],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain("failed to read TLS key:");
      expect(requests).toHaveLength(0);
    });
  });

  it.live("skips TLS validation when api.enabled is false (Go gates on c.Api.Enabled)", () => {
    // Cert/key pairing is validated only when api.enabled is true, so a config
    // with api.enabled=false and only cert_path set must not fail on the
    // missing key_path — it seeds normally.
    const { layer, requests } = setupSeedBuckets(tmp.current, {
      toml: '[api]\nenabled = false\n[api.tls]\nenabled = true\ncert_path = "custom-ca.crt"\n[storage.buckets.docs]\npublic = false\n',
      routes: [
        { method: "GET", match: "/storage/v1/bucket", body: [] },
        { method: "POST", match: "/storage/v1/bucket", body: { name: "docs" } },
      ],
    });
    return Effect.gen(function* () {
      const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(
        requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
      ).toBe(true);
    });
  });

  it.live(
    "fails before the api-keys fetch when --workdir names a config-less subdirectory of a real ancestor project",
    () => {
      // The ancestor project has a valid config.toml declaring a bucket; the
      // subdirectory has none of its own — an explicit --workdir must never
      // silently climb to the ancestor's config.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        'project_id = "test"\n[storage.buckets.test]\npublic = true\n',
      );
      const sub = join(tmp.current, "nested", "dir");
      mkdirSync(sub, { recursive: true });
      const { layer, requests, telemetry } = setupSeedBuckets(sub, {
        explicitWorkdir: true,
      });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("SeedMissingProjectConfigError");
        expect(requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
      });
    },
  );

  it.live(
    "an explicit --workdir naming a directory that does not exist at all fails before any credential resolution",
    () => {
      const missing = join(tmp.current, "does-not-exist");
      const { layer, requests } = setupSeedBuckets(missing, { explicitWorkdir: true });
      return Effect.gen(function* () {
        const exit = yield* seedBuckets(DEFAULT_FLAGS).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(JSON.stringify(exit)).toContain("SeedWorkdirError");
        expect(JSON.stringify(exit)).toContain("failed to change workdir: chdir");
        expect(requests).toHaveLength(0);
      });
    },
  );

  it.live(
    "seedBucketsRun succeeds with a caller-supplied resolvedConfig even when cliSettings.explicitWorkdir is true",
    () => {
      // `start`/`db reset` call `seedBucketsRun` directly with an
      // already-resolved `resolvedConfig`, bypassing `buckets.handler.ts`'s
      // `requireExplicitWorkdirProject` guard entirely — this proves that
      // reuse path stays untouched even when `explicitWorkdir` is true.
      mkdirSync(join(tmp.current, "supabase"), { recursive: true });
      writeFileSync(
        join(tmp.current, "supabase", "config.toml"),
        'project_id = "test"\n[storage.buckets.test]\npublic = true\n',
      );
      const { layer, requests } = setupSeedBuckets(tmp.current, {
        explicitWorkdir: true,
        routes: [
          { method: "GET", match: "/storage/v1/bucket", body: [] },
          { method: "POST", match: "/storage/v1/bucket", body: { name: "test" } },
        ],
      });
      return Effect.gen(function* () {
        const loaded = yield* loadCliConfig(tmp.current, {
          goViperCompat: true,
          search: false,
        }).pipe(Effect.provide(BunServices.layer));
        if (loaded === null) {
          throw new Error("test setup: config.toml failed to load");
        }
        const exit = yield* seedBucketsRun({
          projectRef: "",
          emitSummary: false,
          interactive: false,
          resolvedConfig: { config: loaded.config, document: loaded.document },
        }).pipe(Effect.provide(layer), Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(true);
        expect(
          requests.some((r) => r.method === "POST" && r.url.endsWith("/storage/v1/bucket")),
        ).toBe(true);
      });
    },
  );
});
