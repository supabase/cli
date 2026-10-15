import type { OrganizationResponseV1_Output, V1CreateAProjectOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Schema } from "effect";
import { CliError, CliOutput, Command } from "effect/cli";

import { mockOutput, mockTelemetryRuntime, mockTty } from "../../../../tests/helpers/mocks.ts";
import { ExperimentalRequiredError } from "../../../command-internal/experimental-gate.ts";
import { GLOBAL_FLAGS, ExperimentalFlag } from "../../../command-internal/global-flags.ts";
import { textCliOutputFormatter } from "../../../shared/output/text-formatter.ts";
import {
  type ApiResponse,
  type HttpMethod,
  buildTestRuntime,
  jsonResponse,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withConfigEnv,
} from "../../../../tests/helpers/command-mocks.ts";
import {
  assertBlockDrift,
  assertPermissionDrift,
} from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { organizationPicker } from "../../../command-internal/organization-picker.ts";
import { projectsCreateCommand, type ProjectsCreateFlags } from "./create.command.ts";
import { projectsCreate } from "./create.handler.ts";

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

const ORGS: ReadonlyArray<typeof OrganizationResponseV1_Output.Type> = [
  { id: "org-abc", slug: "acme", name: "Acme Inc" },
];

const BASE_FLAGS: ProjectsCreateFlags = {
  name: Option.none(),
  orgId: Option.none(),
  dbPassword: Option.none(),
  region: Option.none(),
  size: Option.none(),
  highAvailability: Option.none(),
  releaseChannel: Option.none(),
  postgresEngine: Option.none(),
  interactive: Option.none(),
  plan: Option.none(),
};

const tempRoot = useTempWorkdir("supabase-projects-create-int-");

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const API = "https://api.supabase.com";

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  readonly stdinIsTty?: boolean;
  readonly byMethod?: Partial<Record<HttpMethod, ApiResponse>>;
  readonly network?: "fail";
  readonly promptTextResponses?: ReadonlyArray<string>;
  readonly promptSelectResponses?: ReadonlyArray<string>;
  readonly promptPasswordResponses?: ReadonlyArray<string>;
  readonly tracked?: boolean;
  readonly experimental?: boolean;
}

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({
    format: opts.format ?? "text",
    promptTextResponses: opts.promptTextResponses,
    promptSelectResponses: opts.promptSelectResponses,
    promptPasswordResponses: opts.promptPasswordResponses,
  });
  const api = mockCommandPlatformApi({
    network: opts.network,
    byMethod: opts.byMethod ?? {
      POST: { status: 201, body: CREATED },
      GET: { status: 200, body: ORGS },
    },
  });
  const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
  const tty = mockTty({
    stdinIsTty: opts.stdinIsTty ?? false,
    stdoutIsTty: opts.stdinIsTty ?? false,
  });
  const telemetry = mockTelemetryStateTracked();
  const cache = mockLinkedProjectCacheTracked();
  const runtime = buildTestRuntime({
    out,
    api,
    cliSettings,
    tty,
    telemetry: telemetry.layer,
    linkedProjectCache: cache.layer,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  const layer = Layer.mergeAll(
    runtime,
    Layer.succeed(ExperimentalFlag, opts.experimental ?? false),
  );
  return { layer, out, api, telemetry, cache };
}

function postBody(api: { requests: ReadonlyArray<{ method: string; body?: unknown }> }) {
  return api.requests.find((r) => r.method === "POST")?.body;
}

describe("projects create integration", () => {
  it.effect("creates a project non-interactively from flags", () => {
    const { layer, out, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
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
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST ${API}/v1/projects`,
      ]);
      assertPermissionDrift({
        command: "projects create",
        activeFlags: { "org-id": true, "db-password": true, region: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("includes desired_instance_size only when --size is set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        size: Option.some("medium"),
      });
      expect(postBody(api)).toMatchObject({ desired_instance_size: "medium" });
    }).pipe(Effect.provide(layer));
  });

  it.effect("includes high_availability only when --high-availability is set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        highAvailability: Option.some(true),
      });
      expect(postBody(api)).toMatchObject({ high_availability: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("forwards --high-availability=false when explicitly set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        highAvailability: Option.some(false),
      });
      expect(postBody(api)).toMatchObject({ high_availability: false });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "sends both release_channel and postgres_engine when both flags and --experimental are set",
    () => {
      const { layer, api } = setup({ experimental: true });
      return Effect.gen(function* () {
        yield* projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
          releaseChannel: Option.some("internal"),
          postgresEngine: Option.some("17-oriole"),
        });
        expect(postBody(api)).toMatchObject({
          release_channel: "internal",
          postgres_engine: "17-oriole",
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "sends only postgres_engine when only --postgres-engine is set (with --experimental)",
    () => {
      const { layer, api } = setup({ experimental: true });
      return Effect.gen(function* () {
        yield* projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
          postgresEngine: Option.some("17-oriole"),
        });
        expect(postBody(api)).toMatchObject({ postgres_engine: "17-oriole" });
        expect(postBody(api)).not.toHaveProperty("release_channel");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "fails with ExperimentalRequiredError when --release-channel is set without --experimental",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          projectsCreate({
            ...BASE_FLAGS,
            name: Option.some("alpha"),
            orgId: Option.some("acme"),
            dbPassword: Option.some("s3cret-pass"),
            region: Option.some("us-east-1"),
            releaseChannel: Option.some("internal"),
          }),
        );
        expect(error).toBeInstanceOf(ExperimentalRequiredError);
        expect(error.message).toBe("must set the --experimental flag to run this command");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "fails with ExperimentalRequiredError when --postgres-engine is set without --experimental",
    () => {
      const { layer, api } = setup();
      return Effect.gen(function* () {
        const error = yield* Effect.flip(
          projectsCreate({
            ...BASE_FLAGS,
            name: Option.some("alpha"),
            orgId: Option.some("acme"),
            dbPassword: Option.some("s3cret-pass"),
            region: Option.some("us-east-1"),
            postgresEngine: Option.some("15"),
          }),
        );
        expect(error).toBeInstanceOf(ExperimentalRequiredError);
        expect(error.message).toBe("must set the --experimental flag to run this command");
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "accepts --release-channel and --postgres-engine when only SUPABASE_EXPERIMENTAL is set",
    () => {
      const { layer, api } = setup();
      return withConfigEnv(
        { SUPABASE_EXPERIMENTAL: "true" },
        Effect.gen(function* () {
          yield* projectsCreate({
            ...BASE_FLAGS,
            name: Option.some("alpha"),
            orgId: Option.some("acme"),
            dbPassword: Option.some("s3cret-pass"),
            region: Option.some("us-east-1"),
            releaseChannel: Option.some("internal"),
            postgresEngine: Option.some("17-oriole"),
          });
          expect(postBody(api)).toMatchObject({
            release_channel: "internal",
            postgres_engine: "17-oriole",
          });
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.effect("excludes release_channel and postgres_engine when neither flag is set", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(postBody(api)).not.toHaveProperty("release_channel");
      expect(postBody(api)).not.toHaveProperty("postgres_engine");
    }).pipe(Effect.provide(layer));
  });

  it.effect("ignores the hidden --plan flag (no-op)", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
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

  it.effect("fails non-interactively when required flags are missing", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsCreate({ ...BASE_FLAGS, name: Option.some("alpha") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ProjectsCreateMissingArgError");
        expect(causeText).toContain("--org-id");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("treats --interactive=false as non-interactive even on a TTY", () => {
    const { layer, api } = setup({ stdinIsTty: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          interactive: Option.some(false),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectsCreateMissingArgError");
      }
      expect(api.requests.some((r) => r.method === "GET")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("prompts for name, org, region and password when interactive", () => {
    const { layer, out, api } = setup({
      stdinIsTty: true,
      promptTextResponses: ["my-proj"],
      promptSelectResponses: ["org-abc", "us-west-2"],
      promptPasswordResponses: [""],
    });
    return Effect.gen(function* () {
      yield* projectsCreate({ ...BASE_FLAGS });
      expect(api.requests.some((r) => r.method === "GET")).toBe(true);
      expect(postBody(api)).toMatchObject({
        name: "my-proj",
        organization_slug: "org-abc",
        region: "us-west-2",
        db_pass: expect.stringMatching(/^.{16}$/),
      });
      expect(out.stderrText).toContain("Selected org-id:");
      expect(out.stderrText).toContain("Selected region:");
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${API}/v1/organizations`,
        `POST ${API}/v1/projects`,
      ]);
      assertPermissionDrift({ command: "projects create", requests: api.requests });
      assertBlockDrift(organizationPicker, { requests: api.requests.slice(0, 1), exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "lists the organizations when --interactive is passed on a TTY without --org-id",
    () => {
      const { layer, api } = setup({
        stdinIsTty: true,
        promptSelectResponses: ["org-abc"],
      });
      return Effect.gen(function* () {
        yield* projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
          interactive: Option.some(true),
        });
        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET ${API}/v1/organizations`,
          `POST ${API}/v1/projects`,
        ]);
        assertPermissionDrift({
          command: "projects create",
          activeFlags: { interactive: true, "db-password": true, region: true },
          requests: api.requests,
          exact: true,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("fails with ProjectsCreateNameEmptyError when the name prompt is blank", () => {
    const { layer } = setup({ stdinIsTty: true, promptTextResponses: [""] });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(projectsCreate({ ...BASE_FLAGS }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectsCreateNameEmptyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails when the interactive organization list request errors", () => {
    const { layer, api } = setup({
      stdinIsTty: true,
      byMethod: { GET: { status: 500, body: {} }, POST: { status: 201, body: CREATED } },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsCreate({ ...BASE_FLAGS, name: Option.some("alpha") }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectsOrgsListUnexpectedStatusError");
      }
      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `GET ${API}/v1/organizations`,
      ]);
      assertPermissionDrift({ command: "projects create", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits a success event for --output-format json", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* projectsCreate({
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

  it.effect("encodes the created project for --output env", () => {
    const { layer, out } = setup({ goOutput: "env" });
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('NAME="alpha"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("encodes the created project for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml" });
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain("name: alpha");
    }).pipe(Effect.provide(layer));
  });

  it.effect("emits Go-byte-exact indented JSON for --output json", () => {
    const { layer, out } = setup({ goOutput: "json" });
    return Effect.gen(function* () {
      yield* projectsCreate({
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

  it.effect("wraps the created project under [project]-style toml output", () => {
    const { layer, out } = setup({ goOutput: "toml" });
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('Name = "alpha"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectsCreateNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ProjectsCreateNetworkError");
        expect(causeText).toContain("failed to create project");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("fails with ProjectsCreateUnexpectedStatusError on HTTP 500", () => {
    const { layer } = setup({ byMethod: { POST: { status: 500, body: {} } } });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        projectsCreate({
          ...BASE_FLAGS,
          name: Option.some("alpha"),
          orgId: Option.some("acme"),
          dbPassword: Option.some("s3cret-pass"),
          region: Option.some("us-east-1"),
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ProjectsCreateUnexpectedStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("sends the request body with Go-sorted keys", () => {
    const { layer, api } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
        size: Option.some("micro"),
      });
      // JSON encoding preserves key order, so this pins the exact wire order rather than
      // just deep-equality.
      const body = api.requests.find((r) => r.method === "POST")?.body;
      const wire = yield* jsonText(body);
      expect(wire).toBe(
        '{"db_pass":"s3cret-pass","desired_instance_size":"micro","name":"alpha","organization_slug":"acme","region":"us-east-1"}',
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("passes through created-project fields the schema does not declare", () => {
    const { layer, out } = setup({
      goOutput: "json",
      byMethod: { POST: { status: 201, body: { ...CREATED, undeclared_field: "kept" } } },
    });
    return Effect.gen(function* () {
      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });
      expect(out.stdoutText).toContain('"undeclared_field": "kept"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes linked-project cache + telemetry state on success", () => {
    const { layer, telemetry, cache } = setup();
    return Effect.gen(function* () {
      yield* projectsCreate({
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

  it.effect("fills the real linked-project cache with the created project", () => {
    const api = mockCommandPlatformApi({
      handler: (request) =>
        Effect.sync(() => {
          if (request.method === "POST" && request.url === `${API}/v1/projects`) {
            return jsonResponse(request, 201, CREATED);
          }
          if (request.method === "GET" && request.url === `${API}/v1/projects/${CREATED.ref}`) {
            return jsonResponse(request, 200, {
              ...CREATED,
              database: {
                host: "db.alpha.supabase.co",
                version: "15.1",
                postgres_engine: "15",
                release_channel: "ga",
              },
            });
          }
          return jsonResponse(request, 404, { message: "unexpected request" });
        }),
    });
    const cliSettings = mockCommandSettings({ workdir: tempRoot.current });
    const layer = Layer.mergeAll(
      buildTestRuntime({
        out: mockOutput({ format: "text" }),
        api,
        cliSettings,
        linkedProjectCache: realLinkedProjectCache({
          httpClient: api.httpClientLayer,
          cliSettings,
        }),
      }),
      Layer.succeed(ExperimentalFlag, false),
    );
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
      expect(yield* fs.exists(cachePath)).toBe(false);

      yield* projectsCreate({
        ...BASE_FLAGS,
        name: Option.some("alpha"),
        orgId: Option.some("acme"),
        dbPassword: Option.some("s3cret-pass"),
        region: Option.some("us-east-1"),
      });

      expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
        `POST ${API}/v1/projects`,
        `GET ${API}/v1/projects/${CREATED.ref}`,
      ]);
      expect(yield* decodeJson(yield* fs.readFileString(cachePath))).toMatchObject({
        ref: CREATED.ref,
      });
      assertPermissionDrift({
        command: "projects create",
        activeFlags: { "org-id": true, "db-password": true, region: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("flushes telemetry but skips cache when creation fails", () => {
    const { layer, telemetry, cache } = setup({ network: "fail" });
    return Effect.gen(function* () {
      yield* Effect.exit(
        projectsCreate({
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

  it.effect("rejects --size nano at flag-parse time, matching Go's 18-value enum", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([projectsCreateCommand]),
      Command.withGlobalFlags(GLOBAL_FLAGS),
    );
    const { layer } = setup();
    // `Command.runWith` keeps the leaf handler's services in the effect type even though the
    // parse error fires before the handler body runs, so the whole pipeline is provided.
    const commandLayer = Layer.mergeAll(
      layer,
      CliOutput.layer(textCliOutputFormatter()),
      mockTelemetryRuntime({
        configDir: `${tempRoot.current}/.supabase`,
      }),
    );

    return Effect.gen(function* () {
      const error = yield* Effect.flip(
        Command.runWith(root, { version: "0.0.0-test" })([
          "create",
          "alpha",
          "--org-id",
          "acme",
          "--db-password",
          "s3cret-pass",
          "--region",
          "us-east-1",
          "--size",
          "nano",
        ]),
      );
      expect(rejectsInvalidSizeChoice(error)).toBe(true);
    }).pipe(Effect.provide(commandLayer));
  });
});

// Confirms the failure came from the `--size` flag itself, not an unrelated error, so the
// regression test can't pass for the wrong reason.
function rejectsInvalidSizeChoice(error: unknown): boolean {
  return (
    Schema.is(CliError.ShowHelp)(error) &&
    error.errors.some(
      (candidate) => Schema.is(CliError.InvalidValue)(candidate) && candidate.option === "size",
    )
  );
}
