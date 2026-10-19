import { BunServices } from "@effect/platform-bun";
import { type V1ListAllProjectsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect";

import { cliConfigValuesTestLayer } from "../../../../tests/helpers/config-values-layer.ts";
import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
  mockTty,
} from "../../../../tests/helpers/mocks.ts";
import { v2ProjectConfigResponse } from "../../../../tests/helpers/config-fixtures.ts";
import {
  buildTestRuntime,
  DEFAULT_API_URL,
  VALID_REF,
  jsonResponse,
  transportFailure,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockCommandPlatformApi,
  mockTelemetryStateTracked,
  useTempWorkdir,
  withEnvVar,
} from "../../../../tests/helpers/command-mocks.ts";
import { assertPermissionDrift } from "../../../../tests/helpers/permission-drift.ts";
import { realLinkedProjectCache } from "../../../../tests/helpers/permission-real-layers.ts";
import { resolveWorkdir } from "../../../config/command-settings.layer.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import type { RemoteValue } from "../../../command-internal/target/remote-value.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { configDiffHandler } from "./diff.command.ts";
import { CONFIG_DIFF_PAYLOAD_VERSION } from "./diff.format.ts";
import { configDiff } from "./diff.handler.ts";
import { warningsOf } from "../../../../tests/helpers/remote-selection.ts";

const tempRoot = useTempWorkdir("supabase-config-diff-int-");

// A past mtime for "untouched file" checks, so a rewrite within the same millisecond still shows.
const BACKDATED_MTIME_SECONDS = 1_577_836_800;

const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_REF = "cccccccccccccccccccc";
const API = "https://api.supabase.com";

const writeProjectFile = Effect.fnUntraced(function* (name: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(tempRoot.current, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), contents);
});

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeJsonText = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Schema-valid v2 project-config body whose managed values all sit at the local schema
 *  defaults, so an empty config.toml diffs clean against it. */
const v2Response = v2ProjectConfigResponse;

const jsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const asJsonRecord = Schema.decodeUnknownSync(jsonRecord);
const decodeJsonRecord = Schema.decodeUnknownEffect(jsonRecord);
const decodeChanges = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.StructWithRest(Schema.Struct({ path: Schema.Array(Schema.String) }), [jsonRecord]),
  ),
);

const PROJECT: (typeof V1ListAllProjectsOutput.Type)[number] = {
  id: VALID_REF,
  ref: VALID_REF,
  organization_id: "org-123",
  organization_slug: "acme",
  name: "alpha",
  region: "us-east-1",
  created_at: "2026-05-27T01:02:03Z",
  status: "ACTIVE_HEALTHY",
  database: {
    host: "db.alpha.supabase.co",
    version: "15.1",
    postgres_engine: "15",
    release_channel: "ga",
  },
};

/** A branch row of the linked project's branch list, which every branch `--remote` is looked up in. */
const BRANCH_BY_NAME = {
  id: BRANCH_UUID,
  name: "staging",
  project_ref: BRANCH_REF,
  parent_project_ref: VALID_REF,
  is_default: false,
  persistent: true,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-05-27T01:02:03Z",
  updated_at: "2026-05-27T01:02:04Z",
  with_data: false,
};

/** V1GetABranchConfig body for the UUID `--remote` lookup. */
const BRANCH_CONFIG = {
  ref: BRANCH_REF,
  postgres_version: "15",
  postgres_engine: "15",
  release_channel: "ga",
  status: "ACTIVE_HEALTHY",
  db_host: "h",
  db_port: 5432,
};

interface SetupOpts {
  readonly toml?: string;
  readonly dotenv?: string;
  readonly format?: "text" | "json" | "stream-json";
  readonly outputFlag?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly v2?: { status: number; body: unknown } | "fail";
  readonly branchList?: { status: number; body: unknown };
  readonly branchByUuid?: { status: number; body: unknown };
  /** `false` simulates a directory with no linked project. */
  readonly linked?: boolean;
  /** Overrides `cliSettings.projectId` directly — takes precedence over `linked`. */
  readonly projectId?: Option.Option<string>;
  /** Overrides the process cwd (defaults to the temp workdir). */
  readonly cwd?: string;
  /** cliSettings.workdir override (what `--workdir` resolves to); defaults to the temp project root. */
  readonly workdir?: string;
  /** cliSettings.explicitWorkdir override — true iff --workdir/SUPABASE_WORKDIR was set verbatim. */
  readonly explicitWorkdir?: boolean;
  readonly analytics?: ReturnType<typeof mockContextualAnalytics>;
  /** The argv the deprecation warnings render their replacement command from. */
  readonly cliArgs?: ReadonlyArray<string>;
}

function setup(opts: SetupOpts = {}) {
  const projectFiles = Layer.effectDiscard(
    Effect.all([
      opts.toml === undefined ? Effect.void : writeProjectFile("config.toml", opts.toml),
      opts.dotenv === undefined ? Effect.void : writeProjectFile(".env", opts.dotenv),
    ]),
  ).pipe(Layer.provide(BunServices.layer));
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockCommandPlatformApi({
    handler: (request) => {
      const url = request.url;
      if (url.includes("/v2/projects/")) {
        if (opts.v2 === "fail") {
          return Effect.fail(transportFailure(request));
        }
        const v2 = opts.v2 ?? { status: 200, body: v2Response() };
        return Effect.succeed(jsonResponse(request, v2.status, v2.body));
      }
      if (url.includes("/v1/branches/")) {
        const b = opts.branchByUuid ?? { status: 200, body: BRANCH_CONFIG };
        return Effect.succeed(jsonResponse(request, b.status, b.body));
      }
      if (url.endsWith("/branches")) {
        const b = opts.branchList ?? { status: 200, body: [BRANCH_BY_NAME] };
        return Effect.succeed(jsonResponse(request, b.status, b.body));
      }
      return Effect.succeed(jsonResponse(request, 200, {}));
    },
  });
  const telemetry = mockTelemetryStateTracked();
  const linkedProjectCache = mockLinkedProjectCacheTracked();
  const processControl = mockProcessControl();
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({
        workdir: opts.workdir ?? tempRoot.current,
        explicitWorkdir: opts.explicitWorkdir ?? false,
        ...(opts.projectId !== undefined
          ? { projectId: opts.projectId }
          : opts.linked === false
            ? { projectId: Option.none<string>() }
            : {}),
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: opts.cwd ?? tempRoot.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: linkedProjectCache.layer,
      processControl,
      outputFlag: opts.outputFlag === undefined ? Option.none() : Option.some(opts.outputFlag),
      ...(opts.analytics === undefined ? {} : { analytics: opts.analytics }),
      ...(opts.cliArgs === undefined ? {} : { cliArgs: opts.cliArgs }),
    }),
    projectFiles,
    cliConfigValuesTestLayer,
  );
  return { layer, out, api, telemetry, linkedProjectCache, processControl };
}

const noFlags = {
  remote: Option.none<RemoteValue>(),
  projectRef: Option.none<string>(),
  exitCode: false,
};

const remoteRef = (ref: string) => ({
  ...noFlags,
  remote: Option.some<RemoteValue>({ _tag: "Ref", ref }),
});
const remoteBranch = (name: string) => ({
  ...noFlags,
  remote: Option.some<RemoteValue>({ _tag: "Branch", name }),
});

describe("config diff integration", () => {
  it.effect("reports drift against the linked project without touching the config file", () => {
    const { layer, out, processControl, telemetry, linkedProjectCache, api } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configPath = path.join(tempRoot.current, "supabase", "config.toml");
      yield* fs.utimes(configPath, BACKDATED_MTIME_SECONDS, BACKDATED_MTIME_SECONDS);
      const before = {
        mtime: (yield* fs.stat(configPath)).mtime,
        contents: yield* fs.readFileString(configPath),
      };
      yield* configDiff(noFlags);

      expect((yield* fs.stat(configPath)).mtime).toEqual(before.mtime);
      expect(yield* fs.readFileString(configPath)).toBe(before.contents);

      expect(out.stderrText).toContain(`Comparing against project ${VALID_REF} using base config`);
      expect(out.stderrText).toContain(
        "Comparison scope: api, auth, database, pooler, realtime, storage",
      );
      expect(out.stdoutText).toContain("api.max_rows [update]");
      expect(out.stdoutText).toContain("local:  500");
      expect(out.stdoutText).toContain("remote: 1000");
      expect(out.stdoutText).toContain(
        "1 difference found (1 update, 0 remote-only, 0 local-only).",
      );
      expect(processControl.exitCode).toBeUndefined();
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBe(VALID_REF);
      assertPermissionDrift({ command: "config diff", requests: api.requests, exact: true });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a clean config produces the success message and exit 0 even with --exit-code", () => {
    const { layer, out, processControl } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a project that never set up SMS diffs clean against a declared enabled = false",
    () => {
      const { layer, out } = setup({
        toml: 'project_id = "test"\n[auth.sms.twilio]\nenabled = false\n',
      });
      return Effect.gen(function* () {
        yield* configDiff(noFlags);
        expect(out.stdoutText).toContain("No config differences found.");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a disabled Data API diffs clean against a declared enabled = false", () => {
    const { layer, out, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nenabled = false\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            api: {
              ...asJsonRecord(attributes["api"]),
              db_schema: "pg_pgrst_no_exposed_schemas",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a configured provider still diffs clean", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[auth.sms.twilio]",
        "enabled = true",
        'account_sid = "AC1"',
        'message_service_sid = "MG1"',
        'auth_token = "env(TWILIO_AUTH_TOKEN)"',
        "",
      ].join("\n"),
      dotenv: "TWILIO_AUTH_TOKEN=token\n",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              ...asJsonRecord(attributes["auth"]),
              sms_twilio_account_sid: "AC1",
              sms_twilio_message_service_sid: "MG1",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("--exit-code sets exit 2 when differences are found", () => {
    const { layer, processControl, api } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(processControl.exitCode).toBe(2);
      assertPermissionDrift({
        command: "config diff",
        activeFlags: { "exit-code": true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--exit-code in text mode prints a stderr reason line before exiting 2", () => {
    const { layer, out, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(out.stderrText).toContain("Exiting 2: configuration differences found (--exit-code).");
      expect(processControl.exitCode).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--exit-code in json mode exits 2 without the stderr reason line", () => {
    const { layer, out, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      format: "json",
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(out.stderrText).not.toContain("Exiting 2");
      expect(processControl.exitCode).toBe(2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("declared properties the response does not carry are local_only", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[auth]\nsite_url = "https://local.example.com"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => {
            // Drop site_url so the response genuinely omits the declared property.
            const { site_url: _siteUrl, ...auth } = asJsonRecord(attributes["auth"]);
            return { ...attributes, auth };
          },
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("auth.site_url [local-only]");
      expect(out.stdoutText).toContain('local:  "https://local.example.com"');
      expect(out.stdoutText).toContain("remote: (not returned)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("env()-resolved values compare resolved and name the variable on drift", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = "env(PGRST_MAX_ROWS)"\n',
      dotenv: "PGRST_MAX_ROWS=500\n",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [update]");
      expect(out.stdoutText).toContain("local:  500 (from env PGRST_MAX_ROWS)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks a value a project .env file overrides with the variable and file", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      dotenv: "SUPABASE_API_MAX_ROWS=700\n",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("local:  700 (from SUPABASE_API_MAX_ROWS in supabase/.env)");
    }).pipe(Effect.provide(layer));
  });

  it.effect("marks a value the shell environment overrides with the variable alone", () => {
    const { layer, out } = setup({ toml: 'project_id = "test"\n[api]\nmax_rows = 500\n' });
    return withEnvVar(
      "SUPABASE_API_MAX_ROWS",
      "700",
      Effect.gen(function* () {
        yield* configDiff(noFlags);
        expect(out.stdoutText).toContain("local:  700 (from SUPABASE_API_MAX_ROWS)");
        expect(out.stdoutText).not.toContain("SUPABASE_API_MAX_ROWS in");
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("carries an origin on an env-sourced change in the machine payload only", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n[auth]\nsite_url = "https://local.example.com"\n',
      dotenv: "SUPABASE_API_MAX_ROWS=700\n",
      format: "json",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const data = yield* decodeJsonRecord(success?.data);
      const changes = yield* decodeChanges(data["changes"]);
      expect(changes.find((change) => change.path[0] === "api")).toEqual({
        path: ["api", "max_rows"],
        class: "update",
        declared: true,
        local: 700,
        remote: 1000,
        origin: {
          source: "project_env",
          env_variable: "SUPABASE_API_MAX_ROWS",
          file: "supabase/.env",
        },
      });
      expect(changes.find((change) => change.path[0] === "auth")).not.toHaveProperty("origin");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an env override beats the matched [remotes.*] value as the local operand", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[api]",
        "max_rows = 500",
        "[remotes.staging]",
        `project_id = "${VALID_REF}"`,
        "[remotes.staging.api]",
        "max_rows = 1000",
        "",
      ].join("\n"),
      dotenv: "SUPABASE_API_MAX_ROWS=700\n",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stderrText).toContain(
        `Comparing against project ${VALID_REF} using [remotes.staging]`,
      );
      expect(out.stdoutText).toContain("local:  700 (from SUPABASE_API_MAX_ROWS in supabase/.env)");
      expect(out.stdoutText).toContain("remote: 1000");
    }).pipe(Effect.provide(layer));
  });

  it.effect("declared secrets are masked, not compared, and never count for --exit-code", () => {
    const { layer, out, processControl } = setup({
      toml: [
        'project_id = "test"',
        "[auth.external.github]",
        "enabled = true",
        'client_id = "id"',
        'secret = "env(GITHUB_SECRET)"',
        "",
      ].join("\n"),
      dotenv: "GITHUB_SECRET=shh\n",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              external_github_enabled: true,
              external_github_client_id: "id",
              // The platform reports secret fields as HMAC digests, not plaintext.
              external_github_secret: "v1,whmac-sha256-digest-of-the-secret",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 credential value not compared (masked by the API): auth.external.github.secret",
      );
      const everything = out.stdoutText + out.stderrText;
      expect(everything).not.toContain("shh");
      expect(everything).not.toContain("whmac-sha256");
      expect(processControl.exitCode).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("secret strings never reach the machine payload either", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[auth.external.github]",
        "enabled = true",
        'client_id = "id"',
        'secret = "env(GITHUB_SECRET)"',
        "",
      ].join("\n"),
      dotenv: "GITHUB_SECRET=shh\n",
      format: "json",
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              external_github_enabled: true,
              external_github_client_id: "id",
              external_github_secret: "v1,whmac-sha256-digest-of-the-secret",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const serialized = yield* jsonText(success);
      expect(serialized).not.toContain("shh");
      expect(serialized).not.toContain("whmac-sha256");
      expect(success?.message).toContain("masked by the API");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a matching [remotes.*] block becomes the local operand", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[api]",
        "max_rows = 500",
        "[remotes.staging]",
        `project_id = "${VALID_REF}"`,
        "[remotes.staging.api]",
        "max_rows = 1000",
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stderrText).toContain(
        `Comparing against project ${VALID_REF} using [remotes.staging]`,
      );
      expect(out.stdoutText).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an env()-resolving [remotes.*] project_id does not match the target", () => {
    const { layer, out } = setup({
      toml: ['project_id = "test"', "[remotes.x]", 'project_id = "env(REMOTE_REF)"', ""].join("\n"),
      dotenv: `REMOTE_REF=${VALID_REF}\n`,
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stderrText).toContain(`Comparing against project ${VALID_REF} using base config`);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a branch-named --remote resolves via the parent project", () => {
    const { layer, out, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configDiff(remoteBranch("staging"));
      expect(out.stderrText).toContain(
        `Comparing against 'staging' (branch ${BRANCH_REF}) using base config`,
      );
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.endsWith(`/v1/projects/${VALID_REF}/branches`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      assertPermissionDrift({
        command: "config diff",
        activeFlags: { remote: "staging" },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "branch-name resolution uses the linked PARENT, not a branch ref in project-ref",
    () => {
      // project-ref holds the branch's own ref; linked-project.json recovers the parent, which the
      // parent-scoped branches endpoint requires.
      const { layer, api } = setup({
        toml: 'project_id = "test"\n',
        linked: false,
        v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      });
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const temp = path.join(tempRoot.current, "supabase", ".temp");
        yield* fs.makeDirectory(temp, { recursive: true });
        yield* fs.writeFileString(path.join(temp, "project-ref"), BRANCH_REF);
        yield* fs.writeFileString(
          path.join(temp, "linked-project.json"),
          yield* jsonText({ ref: VALID_REF }),
        );
        yield* configDiff(remoteBranch("staging"));
        const urls = api.requests.map((request) => request.url);
        expect(urls.some((url) => url.endsWith(`/v1/projects/${VALID_REF}/branches`))).toBe(true);
        expect(urls.some((url) => url.includes(`/v1/projects/${BRANCH_REF}/`))).toBe(false);
        assertPermissionDrift({
          command: "config diff",
          activeFlags: { remote: "staging" },
          requests: api.requests,
        });
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a UUID --remote resolves directly, even in an unlinked directory", () => {
    const { layer, api, out } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      linked: false,
    });
    return Effect.gen(function* () {
      yield* configDiff(remoteBranch(BRANCH_UUID));
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      // A UUID is an identifier, not a display name, so it isn't quoted.
      expect(out.stderrText).toContain(
        `Comparing against branch ${BRANCH_UUID} (project ref ${BRANCH_REF})`,
      );
      assertPermissionDrift({
        command: "config diff",
        activeFlags: { remote: BRANCH_UUID },
        requests: api.requests,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a ref-shaped --remote never touches the branches API", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configDiff(remoteRef(BRANCH_REF));
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes("/branches"))).toBe(false);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      assertPermissionDrift({
        command: "config diff",
        activeFlags: { remote: BRANCH_REF },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a bare --remote diffs against the linked project", () => {
    const { layer, out, api } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, remote: Option.some<RemoteValue>({ _tag: "Linked" }) });
      expect(out.stderrText).toContain(`Comparing against project ${VALID_REF} using base config`);
      expect(api.requests.some((request) => request.url.includes("/branches"))).toBe(false);
      assertPermissionDrift({
        command: "config diff",
        activeFlags: { remote: true },
        requests: api.requests,
        exact: true,
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("--project-ref still resolves a branch name and warns to use --remote", () => {
    const { layer, out, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      cliArgs: ["config", "diff", "--project-ref", "staging"],
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, projectRef: Option.some("staging") });
      expect(warningsOf(out)).toEqual([
        "--project-ref is deprecated and will be removed in v4. Use --remote instead: supabase config diff --remote=staging",
      ]);
      expect(out.stderrText).toContain(
        `Comparing against 'staging' (branch ${BRANCH_REF}) using base config`,
      );
      expect(
        api.requests.some((request) => request.url.endsWith(`/v1/projects/${VALID_REF}/branches`)),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--remote=<url> is rejected before any request", () => {
    const { layer, api } = setup({ toml: 'project_id = "test"\n' });
    return Effect.gen(function* () {
      const error = yield* configDiff({
        ...noFlags,
        remote: Option.some<RemoteValue>({
          _tag: "DbUrl",
          url: "postgresql://postgres:pw@db.example.com:5432/postgres",
        }),
      }).pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "TargetNeedsProjectError",
        message: "`supabase config diff` needs a project, not a database URL.",
      });
      expect(api.requests).toEqual([]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          commandRuntimeLayer(["config", "diff"]).pipe(Layer.provide(BunServices.layer)),
        ),
      ),
    );
  });

  it.effect("an unknown branch fails listing the available branches", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: 'project_id = "test"\n',
      branchList: { status: 200, body: [BRANCH_BY_NAME] },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(remoteBranch("ghost")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("LinkBranchNotFoundError");
        expect(causeText).toContain(
          `Branch "ghost" not found for project ${VALID_REF}. Available branches: staging`,
        );
      }
      // Telemetry still flushes on failure; the linked-project cache stays untouched since no
      // ref resolved.
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a non-404 branch lookup failure keeps its status error", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      branchList: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(remoteBranch("staging")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("LinkBranchListStatusError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("a missing config file points at supabase init before any resolution", () => {
    const { layer, telemetry, api } = setup();
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffLoadConfigError");
        // The config load probes both config.toml and config.json, so the message names both.
        expect(causeText).toContain("supabase/config.toml or supabase/config.json: file not found");
        expect(causeText).toContain("supabase init");
      }
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "does not climb to an ancestor project's config when --workdir names a subdirectory with no config of its own",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The ancestor (tempRoot) genuinely has a config.toml and the subdirectory genuinely has
        // none, so this exercises a real climb, not a tautology.
        const sub = path.join(tempRoot.current, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const { layer, api, telemetry } = setup({
          toml: 'project_id = "test"\n',
          workdir: sub,
          explicitWorkdir: true,
        });
        const exit = yield* configDiff(noFlags).pipe(Effect.exit, Effect.provide(layer));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffLoadConfigError");
          expect(causeText).toContain("file not found");
          // An explicit workdir skips the ancestor-search "supabase init" hint; it names the
          // resolved directory and the flag/env var to change instead.
          expect(causeText).not.toContain("supabase init");
          expect(causeText).toContain("--workdir/SUPABASE_WORKDIR");
          expect(causeText).toContain(sub);
          // The ancestor has a valid project, so the message also hints at it via the "Did you
          // mean" enrichment.
          expect(causeText).toContain(`Did you mean --workdir ${tempRoot.current}?`);
        }
        expect(api.requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "does not hint at an ancestor when explicit --workdir has no project anywhere above it",
    () => {
      const { layer, api } = setup({ explicitWorkdir: true });
      return Effect.gen(function* () {
        const exit = yield* configDiff(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffLoadConfigError");
          expect(causeText).not.toContain("Did you mean");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect(
    "an explicit --workdir naming a directory that does not exist at all fails before any config load",
    () =>
      Effect.gen(function* () {
        const path = yield* Path.Path;
        const missing = path.join(tempRoot.current, "does-not-exist");
        const { layer, api } = setup({ workdir: missing, explicitWorkdir: true });
        const exit = yield* configDiff(noFlags).pipe(Effect.exit, Effect.provide(layer));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffWorkdirError");
          expect(causeText).toContain("failed to change workdir: chdir");
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect(
    "a defaulted workdir still resolves a config.json project root above a config-less subdirectory",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* writeProjectFile("config.json", yield* jsonText({ project_id: "test" }));
        const sub = path.join(tempRoot.current, "nested", "dir");
        yield* fs.makeDirectory(sub, { recursive: true });
        const resolved = yield* resolveWorkdir(Option.none(), Option.none(), sub, path);
        const { layer, api } = setup({
          workdir: resolved.workdir,
          explicitWorkdir: resolved.explicit,
        });
        yield* configDiff(noFlags).pipe(Effect.provide(layer));
        expect(api.requests.some((r) => r.url.includes("/v2/projects/"))).toBe(true);
        expect(api.requests).not.toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a malformed config aborts before any network call, even with a branch target", () => {
    const { layer, api, telemetry } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const exit = yield* configDiff(remoteBranch("staging")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      // The message names the actual file that failed to parse, workdir-relative regardless of
      // invocation cwd.
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          `failed to parse ${path.join("supabase", "config.toml")}`,
        );
      }
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a malformed config file fails as a parse error", () => {
    const { layer } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain(
          `failed to parse ${path.join("supabase", "config.toml")}`,
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("duplicate [remotes.*] project_ids abort the load", () => {
    const { layer } = setup({
      toml: [
        'project_id = "test"',
        "[remotes.a]",
        `project_id = "${VALID_REF}"`,
        "[remotes.b]",
        `project_id = "${VALID_REF}"`,
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ConfigDiffLoadConfigError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("a remote config transport failure maps to the read network error", () => {
    const { layer, telemetry } = setup({ toml: 'project_id = "test"\n', v2: "fail" });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ConfigDiffReadNetworkError");
      }
      // Telemetry still flushes even on failure.
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an out-of-domain mapped value in the response keeps its typed parse error", () => {
    // See ADR 0021: this stays a typed ProjectConfigParseError, not a network failure.
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            storage: {
              ...asJsonRecord(attributes["storage"]),
              file_size_limit: -1,
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ProjectConfigParseError");
        expect(causeText).toContain("Could not read the project config");
        expect(Option.getOrUndefined(Cause.findErrorOption(exit.cause))).toMatchObject({
          suggestion: expect.any(String),
        });
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unknown enum value in the response degrades instead of failing", () => {
    // ADR 0019: executeRaw bypasses the generated client's closed enums, so a new platform enum
    // value degrades instead of failing.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            pooler: {
              ...asJsonRecord(attributes["pooler"]),
              pool_mode: "burst_v9",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("a remote config error status maps to the read status error", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 403, body: { message: "forbidden" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffReadStatusError");
        // 403 gets a purpose-written message naming the project instead of the raw status/body dump.
        expect(causeText).toContain("Access denied");
        expect(causeText).toContain(VALID_REF);
      }
      expect(
        api.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
      ).toEqual([`GET /v2/projects/${VALID_REF}/config`]);
      assertPermissionDrift({ command: "config diff", requests: api.requests });
    }).pipe(Effect.provide(layer));
  });

  it.effect("a 401 on the config read points at re-authenticating", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 401, body: { message: "unauthorized" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffReadStatusError");
        expect(causeText).toContain("supabase login");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "a 404 on the config read names the sanitized ref, suggests projects list, and hedges the api host",
    () => {
      const { layer } = setup({
        toml: 'project_id = "test"\n',
        v2: { status: 404, body: { message: "not found" } },
      });
      return Effect.gen(function* () {
        const exit = yield* configDiff(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffReadStatusError");
          expect(causeText).toContain(`Could not read configuration for project ${VALID_REF}`);
          expect(causeText).toContain("supabase projects list");
          expect(causeText).toContain(DEFAULT_API_URL);
        }
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("other config-read statuses keep the generic unexpected-status message", () => {
    const { layer } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain('unexpected status 500: {"message":"boom"}');
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output-format json emits the structured change set", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
      format: "json",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      expect(success).toBeDefined();
      expect(success?.message).toContain("1 config difference found.");
      const data = yield* decodeJsonRecord(success?.data);
      expect(data["target"]).toEqual({
        kind: "linked",
        project_ref: VALID_REF,
        environment: "unverified",
        local_scope: "base",
      });
      // schema_version is the payload contract's version; the user's $schema reference travels
      // separately as config_schema.
      expect(data["schema_version"]).toBe(CONFIG_DIFF_PAYLOAD_VERSION);
      expect(data["schema_version"]).toBe(1);
      expect(typeof data["config_schema"]).toBe("string");
      expect(data["scope"]).toEqual({
        present: ["api", "auth", "database", "pooler", "realtime", "storage"],
        missing: [],
      });
      expect(data["changes"]).toEqual([
        { path: ["api", "max_rows"], class: "update", declared: true, local: 500, remote: 1000 },
      ]);
      expect(data["counts"]).toEqual({ update: 1, remote_only: 0, local_only: 0, total: 1 });
      expect(data["masked"]).toEqual([]);
      expect(data["unmanaged"]).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("--output-format stream-json reports zero differences as a success result", () => {
    const { layer, out } = setup({ toml: 'project_id = "test"\n', format: "stream-json" });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.message).toContain("No config differences found.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("every -o/--output value is rejected outright before any work happens", () => {
    // Iterates every value the global `-o`/`--output` flag can carry, so a value added there
    // automatically extends this coverage.
    const values = GLOBAL_OUTPUT_FORMATS;
    const run = (outputFlag: (typeof values)[number]) => {
      const { layer, api } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        outputFlag,
      });
      return Effect.gen(function* () {
        const exit = yield* configDiff(noFlags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffOutputFlagUnsupportedError");
          expect(causeText).toContain(
            "the -o/--output flag is not supported by config diff; use --output-format json|stream-json instead.",
          );
        }
        expect(api.requests).toHaveLength(0);
      }).pipe(Effect.provide(layer));
    };
    return Effect.gen(function* () {
      for (const value of values) {
        yield* run(value);
      }
    });
  });

  it.effect("a fetch failure in json mode still maps cleanly without a spinner", () => {
    const { layer } = setup({ toml: 'project_id = "test"\n', v2: "fail", format: "json" });
    return Effect.gen(function* () {
      const exit = yield* configDiff(noFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ConfigDiffReadNetworkError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.effect("json target for a branch name carries the branch, its parent and the identity", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      format: "json",
    });
    return Effect.gen(function* () {
      yield* configDiff(remoteBranch("staging"));
      const success = out.messages.find((message) => message.type === "success");
      const data = yield* decodeJsonRecord(success?.data);
      expect(data["target"]).toEqual({
        kind: "linked",
        project_ref: BRANCH_REF,
        environment: "branch",
        parent_project_ref: VALID_REF,
        branch: "staging",
        local_scope: "base",
      });
    }).pipe(Effect.provide(layer));
  });

  it.effect("json payload carries the remotes scope and env variable annotations", () => {
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        "[remotes.staging]",
        `project_id = "${VALID_REF}"`,
        "[remotes.staging.api]",
        'max_rows = "env(PGRST_MAX_ROWS)"',
        "",
      ].join("\n"),
      dotenv: "PGRST_MAX_ROWS=500\n",
      format: "json",
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      const data = yield* decodeJsonRecord(success?.data);
      expect(data["target"]).toMatchObject({ local_scope: "remotes.staging" });
      expect(data["changes"]).toEqual([
        {
          path: ["api", "max_rows"],
          class: "update",
          declared: true,
          local: 500,
          remote: 1000,
          env_variables: ["PGRST_MAX_ROWS"],
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("remote-only drift renders (unset) locals distinguishably from empty ones", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            database: {
              ...asJsonRecord(attributes["database"]),
              postgres_settings: { work_mem: "64MB" },
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("db.settings.work_mem [remote-only]");
      expect(out.stdoutText).toContain("local:  (unset)");
      expect(out.stdoutText).toContain('remote: "64MB"');
    }).pipe(Effect.provide(layer));
  });

  it.effect("remote-only drift on a defaulted path shows the local schema default", () => {
    // The file never declares api.max_rows, so a config push would overwrite the remote's 250
    // with the schema default 1000; the output must say so, not imply the key exists only
    // remotely.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            api: { ...asJsonRecord(attributes["api"]), max_rows: 250 },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("api.max_rows [remote-only]");
      expect(out.stdoutText).toContain(
        "local:  1000 (schema default — not declared in config.toml)",
      );
      expect(out.stdoutText).toContain("remote: 250");
    }).pipe(Effect.provide(layer));
  });

  it.effect("the config file is read relative to --workdir, not the invoking directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // The ambient cwd points at a directory with no supabase/ project at all, so only
      // cliSettings.workdir can resolve it.
      const elsewhere = path.join(tempRoot.current, "unrelated-cwd");
      yield* fs.makeDirectory(elsewhere, { recursive: true });
      const { layer, out } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        cwd: elsewhere,
      });
      yield* configDiff(noFlags).pipe(Effect.provide(layer));
      expect(out.stdoutText).toContain("api.max_rows [update]");
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("hostile names cannot inject ANSI or forge output lines in text mode", () => {
    // [remotes.*] names are unconstrained TOML keys an attacker could control, so escape bytes
    // must not reach the terminal raw.
    const { layer, out } = setup({
      toml: [
        'project_id = "test"',
        '[remotes."evil\\u001B[31mred"]',
        `project_id = "${VALID_REF}"`,
        '[remotes."evil\\u001B[31mred".api]',
        "max_rows = 500",
        "",
      ].join("\n"),
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stderrText).toContain("[remotes.evil[31mred]");
      expect(out.stderrText).not.toContain("\u001b");
      expect(out.stdoutText).not.toContain("\u001b");
    }).pipe(Effect.provide(layer));
  });

  it.effect("an empty block record is reported not-returned, not silently compared", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({ attributes: (attributes) => ({ ...attributes, auth: {} }) }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stderrText).toContain(
        "Comparison scope: api, database, pooler, realtime, storage (not returned: auth)",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a missing block's not-compared caveat travels with the machine `.message`", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      format: "json",
      v2: {
        status: 200,
        body: v2Response({ attributes: (attributes) => ({ ...attributes, auth: {} }) }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      const success = out.messages.find((message) => message.type === "success");
      expect(success?.message).toBe(
        "No config differences found. 1 block was not returned by the API and was not compared: auth.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("the same missing-block caveat renders as a Note in text mode", () => {
    const { layer, out } = setup({
      toml: 'project_id = "test"\n',
      v2: {
        status: 200,
        body: v2Response({ attributes: (attributes) => ({ ...attributes, auth: {} }) }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 block was not returned by the API and was not compared: auth",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a declared path push cannot communicate surfaces in the unmanaged note", () => {
    // DISABLED_SENTINEL_PRUNES drops authorization_url_path from the local projection while the
    // container is declared disabled, so a disagreeing remote value can't be a change entry but
    // must not vanish silently either.
    const { layer, out } = setup({
      toml: 'project_id = "test"\n[auth.oauth_server]\nenabled = false\nauthorization_url_path = "/consent"\n',
      v2: {
        status: 200,
        body: v2Response({
          attributes: (attributes) => ({
            ...attributes,
            auth: {
              ...asJsonRecord(attributes["auth"]),
              oauth_server_enabled: false,
              oauth_server_authorization_path: "/other",
            },
          }),
        }),
      },
    });
    return Effect.gen(function* () {
      yield* configDiff(noFlags);
      expect(out.stdoutText).toContain("No config differences found.");
      expect(out.stdoutText).toContain(
        "Note: 1 declared property is not part of the current comparison and was not compared: auth.oauth_server.authorization_url_path",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a branch-NAME --remote in an unlinked dir fails immediately, naming the value", () => {
    const { layer, api, telemetry, linkedProjectCache } = setup({
      toml: 'project_id = "test"\n',
      linked: false,
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(remoteBranch("somebranch")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("LinkBranchNotLinkedError");
        expect(causeText).toContain('"somebranch"');
      }
      expect(api.requests).toHaveLength(0);
      expect(telemetry.flushed).toBe(true);
      expect(linkedProjectCache.cachedRef).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.effect("a branch-NAME --remote with a corrupt linked ref reports it as invalid", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      projectId: Option.some("not-a-valid-ref"),
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(remoteBranch("somebranch")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("LinkParentRefInvalidError");
        expect(causeText).toContain('"somebranch"');
        expect(causeText).toContain("Relink the parent project");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a resolved branch with no project ref yet fails with a not-ready error", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      branchList: { status: 200, body: [{ ...BRANCH_BY_NAME, project_ref: "" }] },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff(remoteBranch("staging")).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("LinkBranchNotReadyError");
        expect(causeText).toContain("has no project ref yet");
      }
      expect(api.requests.some((request) => request.url.includes("/v2/projects/"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "diffs the project chosen from the picker and fills the real linked-project cache",
    () => {
      const out = mockOutput({ format: "text", promptSelectResponses: [VALID_REF] });
      const api = mockCommandPlatformApi({
        handler: (request) =>
          Effect.sync(() => {
            if (request.method === "GET" && request.url === `${API}/v1/projects`) {
              return jsonResponse(request, 200, [PROJECT]);
            }
            if (request.method === "GET" && request.url === `${API}/v1/projects/${VALID_REF}`) {
              return jsonResponse(request, 200, PROJECT);
            }
            if (request.url === `${API}/v2/projects/${VALID_REF}/config`) {
              return jsonResponse(request, 200, v2Response());
            }
            return jsonResponse(request, 404, { message: "unexpected request" });
          }),
      });
      const cliSettings = mockCommandSettings({
        workdir: tempRoot.current,
        projectId: Option.none(),
      });
      const layer = Layer.merge(
        buildTestRuntime({
          out,
          api,
          cliSettings,
          tty: mockTty({ stdinIsTty: true }),
          linkedProjectCache: realLinkedProjectCache({
            httpClient: api.httpClientLayer,
            cliSettings,
          }),
        }),
        cliConfigValuesTestLayer,
      );
      return Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* writeProjectFile("config.toml", 'project_id = "test"\n');
        const cachePath = `${tempRoot.current}/supabase/.temp/linked-project.json`;
        expect(yield* fs.exists(cachePath)).toBe(false);

        yield* configDiff(noFlags);

        expect(api.requests.map(({ method, url }) => `${method} ${url}`)).toEqual([
          `GET ${API}/v1/projects`,
          `GET ${API}/v2/projects/${VALID_REF}/config`,
          `GET ${API}/v1/projects/${VALID_REF}`,
        ]);
        expect(out.stdoutText).toContain("No config differences found.");
        expect(yield* decodeJsonText(yield* fs.readFileString(cachePath))).toMatchObject({
          ref: VALID_REF,
        });
        assertPermissionDrift({ command: "config diff", requests: api.requests, exact: true });
      }).pipe(Effect.provide(layer));
    },
  );
});

describe("config diff telemetry wiring", () => {
  // Uses configDiffHandler (not the bare handler) since the safeFlags guard lives in the command
  // wiring, not the handler itself.
  const wiringLayer = (
    analytics: ReturnType<typeof mockContextualAnalytics>,
    args: ReadonlyArray<string>,
  ) =>
    Layer.mergeAll(
      setup({ toml: 'project_id = "test"\n', analytics }).layer,
      commandRuntimeLayer(["config", "diff"]).pipe(Layer.provide(BunServices.layer)),
      Stdio.layerTest({ args: Effect.succeed(["config", "diff", ...args]) }),
    );

  const flagsOf = (analytics: ReturnType<typeof mockContextualAnalytics>) =>
    analytics.captured.find((c) => c.event === "cli_command_executed")?.properties["flags"];

  it.effect("logs a ref-shaped --remote verbatim in cli_command_executed", () => {
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(configDiffHandler(remoteRef(VALID_REF)));
      expect(flagsOf(analytics)).toEqual({ remote: VALID_REF });
    }).pipe(Effect.provide(wiringLayer(analytics, [`--remote=${VALID_REF}`])));
  });

  it.effect("redacts a branch-name --remote", () => {
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(configDiffHandler(remoteBranch("staging")));
      expect(flagsOf(analytics)).toEqual({ remote: "<redacted>" });
    }).pipe(Effect.provide(wiringLayer(analytics, ["--remote=staging"])));
  });

  it.effect("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(configDiffHandler({ ...noFlags, projectRef: Option.some(VALID_REF) }));
      expect(flagsOf(analytics)).toEqual({ "project-ref": VALID_REF });
    }).pipe(Effect.provide(wiringLayer(analytics, ["--project-ref", VALID_REF])));
  });

  it.effect("redacts a branch-name-shaped --project-ref", () => {
    // A user-created branch name must never reach PostHog verbatim.
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(configDiffHandler({ ...noFlags, projectRef: Option.some("staging") }));
      expect(flagsOf(analytics)).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(wiringLayer(analytics, ["--project-ref", "staging"])));
  });
});

describe("config diff -o/--output wrapper wiring", () => {
  // diff.command.ts's `outputFormats` override widens the flag's enum to the full choice list;
  // without it, `-o table` would hit the wrapper's own generic rejection before reaching this
  // command's specific one. Uses the real configDiffHandler wiring so this exercises that override.
  it.effect("-o table reaches this command's own message, not the wrapper's generic one", () => {
    const { layer, api } = setup({ toml: 'project_id = "test"\n', outputFlag: "table" });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(configDiffHandler(noFlags));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffOutputFlagUnsupportedError");
        expect(causeText).not.toContain("InvalidOutputFormatError");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          layer,
          commandRuntimeLayer(["config", "diff"]).pipe(Layer.provide(BunServices.layer)),
          Stdio.layerTest({ args: Effect.succeed(["config", "diff", "-o", "table"]) }),
        ),
      ),
    );
  });
});
