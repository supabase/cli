import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem, Layer, Option, Path, Schema, Stdio } from "effect";
import { vi } from "vitest";

import {
  mockContextualAnalytics,
  mockOutput,
  mockProcessControl,
  mockRuntimeInfo,
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
} from "../../../../tests/helpers/command-mocks.ts";
import { GLOBAL_OUTPUT_FORMATS } from "../../../command-internal/global-flags.ts";
import { commandRuntimeLayer } from "../../../shared/runtime/command-runtime.layer.ts";
import { configDiffHandler } from "./diff.command.ts";
import { CONFIG_DIFF_PAYLOAD_VERSION } from "./diff.format.ts";
import { configDiff } from "./diff.handler.ts";

const tempRoot = useTempWorkdir("supabase-config-diff-int-");

// A past mtime for "untouched file" checks, so a rewrite within the same millisecond still shows.
const BACKDATED_MTIME_SECONDS = 1_577_836_800;

const BRANCH_UUID = "11111111-1111-4111-8111-111111111111";
const BRANCH_REF = "cccccccccccccccccccc";

const writeProjectFile = Effect.fnUntraced(function* (name: string, contents: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = path.join(tempRoot.current, "supabase");
  yield* fs.makeDirectory(dir, { recursive: true });
  yield* fs.writeFileString(path.join(dir, name), contents);
});

const jsonText = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** Schema-valid v2 project-config body whose managed values all sit at the local schema
 *  defaults, so an empty config.toml diffs clean against it. */
const v2Response = v2ProjectConfigResponse;

/** V1GetABranch body for the branch-name `--project-ref` lookup. */
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

/** V1GetABranchConfig body for the UUID `--project-ref` lookup. */
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
  readonly goOutput?: "env" | "pretty" | "json" | "toml" | "yaml" | "table" | "csv";
  readonly v2?: { status: number; body: unknown } | "fail";
  readonly branchByName?: { status: number; body: unknown };
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
      if (url.includes("/branches/")) {
        const b = opts.branchByName ?? { status: 200, body: BRANCH_BY_NAME };
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
      goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
      ...(opts.analytics === undefined ? {} : { analytics: opts.analytics }),
    }),
    projectFiles,
  );
  return { layer, out, api, telemetry, linkedProjectCache, processControl };
}

const noFlags = {
  projectRef: Option.none<string>(),
  exitCode: false,
};

describe("config diff integration", () => {
  it.effect("reports drift against the linked project without touching the config file", () => {
    const { layer, out, processControl, telemetry, linkedProjectCache } = setup({
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

  it.effect("--exit-code sets exit 2 when differences are found", () => {
    const { layer, processControl } = setup({
      toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, exitCode: true });
      expect(processControl.exitCode).toBe(2);
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
            const { site_url: _siteUrl, ...auth } = attributes["auth"] as Record<string, unknown>;
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

  it.effect(
    "an env()-resolving [remotes.*] project_id does not match the target and does not double-warn (CLI-2287)",
    () => {
      const { layer, out } = setup({
        toml: [
          'project_id = "test"',
          "[inbucket]",
          "enabled = true",
          "port = 12345",
          "[remotes.x]",
          'project_id = "env(REMOTE_REF)"',
          "",
        ].join("\n"),
        dotenv: `REMOTE_REF=${VALID_REF}\n`,
      });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      return Effect.gen(function* () {
        yield* configDiff(noFlags);
        expect(out.stderrText).toContain(
          `Comparing against project ${VALID_REF} using base config`,
        );
        const inbucketWarnings = errorSpy.mock.calls.filter((call) =>
          String(call[0]).includes("[inbucket] is deprecated"),
        );
        expect(inbucketWarnings).toHaveLength(1);
      }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
    },
  );

  it.effect("a branch-named --project-ref resolves via the parent project", () => {
    const { layer, out, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, projectRef: Option.some("staging") });
      expect(out.stderrText).toContain(
        `Comparing against 'staging' (branch ${BRANCH_REF}) using base config`,
      );
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/projects/${VALID_REF}/branches/staging`))).toBe(
        true,
      );
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
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
        yield* configDiff({ ...noFlags, projectRef: Option.some("staging") });
        const urls = api.requests.map((request) => request.url);
        expect(urls.some((url) => url.includes(`/v1/projects/${VALID_REF}/branches/staging`))).toBe(
          true,
        );
        expect(urls.some((url) => url.includes(`/v1/projects/${BRANCH_REF}/`))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a UUID --project-ref resolves directly, even in an unlinked directory", () => {
    const { layer, api, out } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
      linked: false,
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, projectRef: Option.some(BRANCH_UUID) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes(`/v1/branches/${BRANCH_UUID}`))).toBe(true);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
      // A UUID is an identifier, not a display name, so it isn't quoted.
      expect(out.stderrText).toContain(
        `Comparing against branch ${BRANCH_UUID} (project ref ${BRANCH_REF})`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("a ref-shaped --project-ref never touches the branches API", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      v2: { status: 200, body: v2Response({ ref: BRANCH_REF }) },
    });
    return Effect.gen(function* () {
      yield* configDiff({ ...noFlags, projectRef: Option.some(BRANCH_REF) });
      const urls = api.requests.map((request) => request.url);
      expect(urls.some((url) => url.includes("/branches/"))).toBe(false);
      expect(urls.some((url) => url.includes(`/v2/projects/${BRANCH_REF}/config`))).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an unknown branch fails with a branches-list suggestion", () => {
    const { layer, telemetry, linkedProjectCache } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 404, body: { message: "not found" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff({ ...noFlags, projectRef: Option.some("ghost") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffBranchNotFoundError");
        expect(causeText).toContain('Branch "ghost" not found');
        expect(causeText).toContain("supabase branches list");
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
      branchByName: { status: 500, body: { message: "boom" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff({ ...noFlags, projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Cause.pretty(exit.cause)).toContain("ConfigDiffBranchResolveStatusError");
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
        // loadCliConfig probes both config.toml and config.json, so the message names both.
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
        const { layer, api } = setup({ workdir: sub, explicitWorkdir: false });
        yield* configDiff(noFlags).pipe(Effect.provide(layer));
        expect(api.requests.some((r) => r.url.includes("/v2/projects/"))).toBe(true);
        expect(api.requests).not.toHaveLength(0);
      }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("a malformed config aborts before any network call, even with a branch target", () => {
    const { layer, api, telemetry } = setup({ toml: "not [valid toml\n" });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const exit = yield* configDiff({ ...noFlags, projectRef: Option.some("staging") }).pipe(
        Effect.exit,
      );
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
              ...(attributes["storage"] as Record<string, unknown>),
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
              ...(attributes["pooler"] as Record<string, unknown>),
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
    const { layer } = setup({
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
      const data = success?.data as Record<string, unknown>;
      expect(data["target"]).toMatchObject({
        project_ref: VALID_REF,
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
    const run = (goOutput: (typeof values)[number]) => {
      const { layer, api } = setup({
        toml: 'project_id = "test"\n[api]\nmax_rows = 500\n',
        goOutput,
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
      const data = success?.data as Record<string, unknown>;
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
              ...(attributes["database"] as Record<string, unknown>),
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
            api: { ...(attributes["api"] as Record<string, unknown>), max_rows: 250 },
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
              ...(attributes["auth"] as Record<string, unknown>),
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

  it.effect(
    "a branch-NAME --project-ref in an unlinked dir fails immediately, naming the value",
    () => {
      const { layer, api, telemetry, linkedProjectCache } = setup({
        toml: 'project_id = "test"\n',
        linked: false,
      });
      return Effect.gen(function* () {
        const exit = yield* configDiff({
          ...noFlags,
          projectRef: Option.some("somebranch"),
        }).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const causeText = Cause.pretty(exit.cause);
          expect(causeText).toContain("ConfigDiffBranchNotLinkedError");
          expect(causeText).toContain('"somebranch"');
        }
        expect(api.requests).toHaveLength(0);
        expect(telemetry.flushed).toBe(true);
        expect(linkedProjectCache.cachedRef).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("a branch-NAME --project-ref with a corrupt linked ref reports it as invalid", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      projectId: Option.some("not-a-valid-ref"),
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff({
        ...noFlags,
        projectRef: Option.some("somebranch"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffParentRefInvalidError");
        expect(causeText).toContain('"somebranch"');
        expect(causeText).toContain("Relink the parent project");
      }
      expect(api.requests).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("a resolved branch with no project ref yet fails with a not-ready error", () => {
    const { layer, api } = setup({
      toml: 'project_id = "test"\n',
      branchByName: { status: 200, body: { ...BRANCH_BY_NAME, project_ref: "" } },
    });
    return Effect.gen(function* () {
      const exit = yield* configDiff({
        ...noFlags,
        projectRef: Option.some("staging"),
      }).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const causeText = Cause.pretty(exit.cause);
        expect(causeText).toContain("ConfigDiffBranchNotReadyError");
        expect(causeText).toContain("has no project ref yet");
      }
      expect(api.requests.some((request) => request.url.includes("/v2/projects/"))).toBe(false);
    }).pipe(Effect.provide(layer));
  });
});

describe("config diff telemetry wiring", () => {
  // Uses configDiffHandler (not the bare handler) since the safeFlags guard lives in the command
  // wiring, not the handler itself.
  const wiringLayer = (analytics: ReturnType<typeof mockContextualAnalytics>, projectRef: string) =>
    Layer.mergeAll(
      setup({ toml: 'project_id = "test"\n', analytics }).layer,
      commandRuntimeLayer(["config", "diff"]),
      Stdio.layerTest({
        args: Effect.succeed(["config", "diff", "--project-ref", projectRef]),
      }),
    );

  it.effect("logs a ref-shaped --project-ref verbatim in cli_command_executed", () => {
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(
        configDiffHandler({ projectRef: Option.some(VALID_REF), exitCode: false }),
      );
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": VALID_REF });
    }).pipe(Effect.provide(wiringLayer(analytics, VALID_REF)));
  });

  it.effect("redacts a branch-name-shaped --project-ref", () => {
    // --project-ref also accepts branch names; a user-created name must never reach PostHog
    // verbatim.
    const analytics = mockContextualAnalytics();
    return Effect.gen(function* () {
      yield* Effect.exit(
        configDiffHandler({ projectRef: Option.some("staging"), exitCode: false }),
      );
      const event = analytics.captured.find((c) => c.event === "cli_command_executed");
      expect(event?.properties["flags"]).toEqual({ "project-ref": "<redacted>" });
    }).pipe(Effect.provide(wiringLayer(analytics, "staging")));
  });
});

describe("config diff -o/--output wrapper wiring", () => {
  // diff.command.ts's `outputFormats` override widens the flag's enum to the full choice list;
  // without it, `-o table` would hit the wrapper's own generic rejection before reaching this
  // command's specific one. Uses the real configDiffHandler wiring so this exercises that override.
  it.effect("-o table reaches this command's own message, not the wrapper's generic one", () => {
    const { layer, api } = setup({ toml: 'project_id = "test"\n', goOutput: "table" });
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
          commandRuntimeLayer(["config", "diff"]),
          Stdio.layerTest({ args: Effect.succeed(["config", "diff", "-o", "table"]) }),
        ),
      ),
    );
  });
});
