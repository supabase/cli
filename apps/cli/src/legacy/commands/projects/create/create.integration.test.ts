import type { OrganizationResponseV1, V1CreateAProjectOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { mockOutput, mockTty } from "../../../../../tests/helpers/mocks.ts";
import {
  type LegacyApiResponse,
  type LegacyHttpMethod,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyLinkedProjectCacheTracked,
  mockLegacyPlatformApi,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyProjectsCreateFlags } from "./create.command.ts";
import { legacyProjectsCreate } from "./create.handler.ts";

const CREATED: typeof V1CreateAProjectOutput.Type = {
  id: "abcdefghijklmnopqrst",
  ref: "abcdefghijklmnopqrst",
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "COMING_UP",
};

const ORGS: ReadonlyArray<typeof OrganizationResponseV1.Type> = [
  { id: "org-abc", slug: "acme", name: "Acme Inc" },
];

const BASE_FLAGS: LegacyProjectsCreateFlags = {
  name: Option.none(),
  orgId: Option.none(),
  dbPassword: Option.none(),
  region: Option.none(),
  size: Option.none(),
  interactive: Option.none(),
  plan: Option.none(),
};

const tempRoot = useLegacyTempWorkdir("supabase-projects-create-int-");

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly stdinIsTty?: boolean;
  readonly byMethod?: Partial<Record<LegacyHttpMethod, LegacyApiResponse>>;
  readonly network?: "fail";
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly promptPasswordResponses?: ReadonlyArray<string>;
  readonly tracked?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptTextResponses: opts.promptTextResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptPasswordResponses: opts.promptPasswordResponses,
  });
  const api = mockLegacyPlatformApi({
    network: opts.network,
    byMethod: opts.byMethod ?? {
      POST: { status: 201, body: CREATED },
      GET: { status: 200, body: ORGS },
    },
  });
  const cliConfig = mockLegacyCliConfig({ workdir: tempRoot.current });
  const tty = mockTty({
    stdinIsTty: opts.stdinIsTty ?? false,
    stdoutIsTty: opts.stdinIsTty ?? false,
  });
  const telemetry = mockLegacyTelemetryStateTracked();
  const cache = mockLegacyLinkedProjectCacheTracked();
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    tty,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api, telemetry, cache };
}

function postBody(api: { requests: ReadonlyArray<{ method: string; body?: unknown }> }) {
  return api.requests.find((r) => r.method === "POST")?.body as Record<string, unknown> | undefined;
}

describe("legacy projects create integration", () => {
  it.live("creates a project non-interactively from flags", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(postBody(api)).toEqual({
        name: "alpha",
        organization_slug: "acme",
        db_pass: "s3cret-pass",
        region: "us-east-1",
      });
      expect(out.stderrText).toContain("Creating project:");
      expect(out.stderrText).toContain(
        "Created a new project at https://supabase.com/dashboard/project/abcdefghijklmnopqrst",
      );
      expect(out.stdoutText).toContain("REFERENCE ID");
      expect(out.stdoutText).toContain("East US (North Virginia)");
    }).pipe(Effect.provide(layer));
  });

  it.live("includes desired_instance_size only when --size is set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        size: Option.some("medium"),
      });
      expect(postBody(api)?.desired_instance_size).toBe("medium");
    }).pipe(Effect.provide(layer));
  });

  it.live("ignores the hidden --plan flag (no-op)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        plan: Option.some("pro"),
      });
      expect(postBody(api)).not.toHaveProperty("plan");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails non-interactively when required flags are missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyProjectsCreate({ ...BASE_FLAGS, name: Option.some("alpha") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsCreateMissingArgError");
        expect(json).toContain("--org-id");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --interactive=false as non-interactive even on a TTY", () => {
    const { layer, api } = setup({ stdinIsTty: true });
    return Effect.gen(function* () {
      // On a TTY but with --interactive=false and a required flag missing, Go's
      // PreRunE marks the flags required and never prompts.
      const exit = yield* Effect.exit(
        legacyProjectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          interactive: Option.some(false),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsCreateMissingArgError");
      }
      // No prompts and no org fetch happened.
      expect(api.requests.some((r) => r.method === "GET")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("prompts for name, org, region and password when interactive", () => {
    const { layer, out, api } = setup({
      stdinIsTty: true,
      promptTextResponses: ["my-proj"],
      promptSelectResponses: ["org-abc", "us-west-2"],
      promptPasswordResponses: [""],
    });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({ ...BASE_FLAGS });
      // org list was fetched for the interactive prompt
      expect(api.requests.some((r) => r.method === "GET")).toBe(true);
      const body = postBody(api);
      expect(body?.name).toBe("my-proj");
      expect(body?.organization_slug).toBe("org-abc");
      expect(body?.region).toBe("us-west-2");
      // blank password prompt generates a 16-char password
      expect(String(body?.db_pass)).toHaveLength(16);
      expect(out.stderrText).toContain("Selected org-id:");
      expect(out.stderrText).toContain("Selected region:");
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsCreateNameEmptyError when the name prompt is blank", () => {
    const { layer } = setup({ stdinIsTty: true, promptTextResponses: [""] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyProjectsCreate({ ...BASE_FLAGS }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsCreateNameEmptyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the interactive organization list request errors", () => {
    const { layer } = setup({
      stdinIsTty: true,
      byMethod: { GET: { status: 500, body: {} }, POST: { status: 201, body: CREATED } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyProjectsCreate({ ...BASE_FLAGS, name: Option.some("alpha") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsOrgsListUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a success event for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.message).toBe("Created project");
      expect(success?.data).toMatchObject({ id: "abcdefghijklmnopqrst", name: "alpha" });
    }).pipe(Effect.provide(layer));
  });

  it.live("encodes the created project for --output env", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('NAME="alpha"');
    }).pipe(Effect.provide(layer));
  });

  it.live("encodes the created project for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain("name: alpha");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('"name": "alpha"');
      expect(out.stdoutText.endsWith("}\n")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("wraps the created project under [project]-style toml output", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('name = "alpha"');
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyProjectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const json = JSON.stringify(exit.cause);
        expect(json).toContain("LegacyProjectsCreateNetworkError");
        expect(json).toContain("failed to create project");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyProjectsCreateUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ byMethod: { POST: { status: 500, body: {} } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyProjectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectsCreateUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("sends the request body with Go-sorted keys", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        size: Option.some("micro"),
      });
      // Go's `json.Marshal` serializes struct fields alphabetically; the
      // cli-e2e replay server byte-compares the request body. JSON.parse →
      // stringify round-trips key order, so this asserts the on-the-wire order.
      const body = api.requests.find((r) => r.method === "POST")?.body;
      expect(JSON.stringify(body)).toBe(
        '{"db_pass":"s3cret-pass","desired_instance_size":"micro","name":"alpha","organization_slug":"acme","region":"us-east-1"}',
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("tolerates a 201 response with a placeholder/short ref (lenient parse)", () => {
    // The typed client rejects refs shorter than 20 chars; `executeRaw` must
    // render the placeholder verbatim (cli-e2e fixtures embed `__PROJECT_REF__`).
    const { layer, out } = setup({
      byMethod: {
        POST: { status: 201, body: { ...CREATED, id: "__PROJECT_REF__", ref: "__PROJECT_REF__" } },
      },
    });
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stderrText).toContain(
        "Created a new project at https://supabase.com/dashboard/project/__PROJECT_REF__",
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* legacyProjectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry but skips cache when creation fails", () => {
    const { layer, telemetry, cache } = setup({ network: "fail" });
    return Effect.gen(function* () {
      yield* Effect.exit(
        legacyProjectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
        }),
      );
      expect(telemetry.flushed).toBe(true);
      expect(cache.cached).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});
