import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Option } from "effect";
import { BunServices } from "@effect/platform-bun";
import { CliOutput, Command } from "effect/unstable/cli";
import { textCliOutputFormatter } from "../../shared/output/text-formatter.ts";
import { pullCommand } from "./pull.command.ts";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";
import {
  buildTestRuntime,
  isolatedHomeLayer,
  jsonResponse,
  mockCommandPlatformApi,
  mockCommandSettings,
  mockLinkedProjectCacheTracked,
  mockTelemetryStateTracked,
  useTempWorkdir,
  VALID_REF,
} from "../../../tests/helpers/command-mocks.ts";
import {
  mockAnalytics,
  mockOutput,
  mockRuntimeInfo,
  mockStdin,
  mockTty,
} from "../../../tests/helpers/mocks.ts";
import { mockChildProcessSpawner } from "../../../tests/helpers/child-process-spawner.ts";
import {
  DebugFlag,
  DnsResolverFlag,
  ExperimentalFlag,
  NetworkIdFlag,
  OutputFlag,
  ProfileFlag,
  WorkdirFlag,
  YesFlag,
} from "../../command-internal/global-flags.ts";
import { DbConfigResolver } from "../../command-internal/db-config.service.ts";
import { DbConnection, type PgConnInput } from "../../command-internal/db-connection.service.ts";
import { GoProxy } from "../../command-internal/go-proxy.service.ts";
import { DockerRun } from "../../command-internal/docker-run.service.ts";
import { EdgeRuntimeScript } from "../../command-internal/edge-runtime-script.service.ts";
import { PgDeltaSslProbe } from "../../command-internal/pgdelta-ssl-probe.service.ts";
import { PgDeltaEngine, PgDeltaEngineError } from "../db/shared/pgdelta-engine.service.ts";
import { pull } from "./pull.handler.ts";
import type { PullFlags } from "./pull.command.ts";
import { PullInitialization, pullInitializationLayer } from "./pull.initialize.ts";
import { commandSettingsLayer } from "../../config/command-settings.layer.ts";
import { CommandSettings } from "../../config/command-settings.service.ts";
import { debugLoggerLayer } from "../../command-internal/debug-logger.layer.ts";
import { CliArgs } from "../../shared/cli/cli-args.service.ts";

const root = useTempWorkdir("supabase-project-pull-");
const OTHER_REF = "bbbbbbbbbbbbbbbbbbbb";
const flags: PullFlags = {
  projectRef: Option.none(),
  password: Option.none(),
  force: false,
  strictCoverage: false,
  useApi: true,
  link: Option.none(),
};

function setup(
  opts: {
    format?: "text" | "json" | "stream-json";
    fail?: "config" | "database" | "functions" | "secrets" | "link";
    empty?: boolean;
    invalidSecret?: boolean;
    decline?: boolean;
    dirty?: boolean;
    legacyOutput?: boolean;
    workdir?: string;
    initialization?: Option.Option<string>;
    yes?: boolean;
    confirmations?: ReadonlyArray<boolean>;
  } = {},
) {
  const out = mockOutput({
    format: opts.format ?? "json",
    interactive: opts.confirmations !== undefined,
    promptConfirmResponses: opts.confirmations,
  });
  const analytics = mockAnalytics();
  const cache = mockLinkedProjectCacheTracked();
  const telemetry = mockTelemetryStateTracked();
  const api = mockCommandPlatformApi({
    handler: (request) => {
      if (request.url.includes("/v2/projects/"))
        return Effect.succeed(
          jsonResponse(request, opts.fail === "config" ? 500 : 200, {
            data: {
              type: "project_config",
              id: VALID_REF,
              attributes: { api: { max_rows: 1234 } },
            },
          }),
        );
      if (request.url.endsWith("/functions"))
        return Effect.succeed(
          jsonResponse(
            request,
            opts.fail === "functions" ? 500 : 200,
            opts.empty ? [] : [{ slug: "hello-world" }],
          ),
        );
      if (request.url.endsWith("/secrets"))
        return Effect.succeed(
          jsonResponse(
            request,
            opts.fail === "secrets" ? 500 : 200,
            opts.empty
              ? []
              : [
                  { name: "ZEBRA_KEY", value: "digest-not-a-secret" },
                  {
                    name: opts.invalidSecret ? "INVALID\nINJECTED" : "API_KEY",
                    value: "another-digest",
                  },
                ],
          ),
        );
      if (request.url.endsWith("/body")) {
        const form = new FormData();
        form.append("metadata", JSON.stringify({ deno2_entrypoint_path: "source/index.ts" }));
        form.append(
          "file",
          new Blob(["Deno.serve(() => new Response('hello'));\n"]),
          "source/index.ts",
        );
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(form)));
      }
      const project = request.url.match(/\/v1\/projects\/([a-z]{20})$/);
      if (project !== null)
        return Effect.succeed(
          jsonResponse(request, opts.fail === "link" ? 500 : 200, {
            id: project[1],
            ref: project[1],
            name: "Test project",
            organization_id: "org_123",
            organization_slug: "test-org",
            status: "ACTIVE_HEALTHY",
            region: "us-east-1",
            created_at: "2026-01-01T00:00:00Z",
            database: {
              host: "db.example.test",
              version: "17.4.1.001",
              postgres_engine: "17",
              release_channel: "ga",
            },
          }),
        );
      if (request.url.endsWith("/api-keys"))
        return Effect.succeed(
          jsonResponse(request, 200, [
            { name: "anon", api_key: "anon-key", type: "legacy" },
            { name: "service_role", api_key: "service-role-key", type: "legacy" },
          ]),
        );
      if (
        request.url.endsWith("/config/storage") ||
        request.url.endsWith("/config/database/pooler") ||
        request.url.endsWith("/rest/v1/") ||
        request.url.endsWith("/auth/v1/health") ||
        request.url.endsWith("/storage/v1/version")
      ) {
        return Effect.succeed(jsonResponse(request, 404, { message: "unavailable" }));
      }
      return Effect.die(`Unexpected request: ${request.url}`);
    },
  });
  const connections: PgConnInput[] = [];
  const exports: Array<{ projectRef: string | undefined; strictCoverage: boolean }> = [];
  const passwords: Option.Option<string>[] = [];
  const layer = Layer.mergeAll(
    buildTestRuntime({
      out,
      api,
      cliSettings: mockCommandSettings({
        workdir: opts.workdir ?? root.current,
        explicitWorkdir: true,
      }),
      runtimeInfo: mockRuntimeInfo({ cwd: root.current, homeDir: root.current }),
      telemetry: telemetry.layer,
      linkedProjectCache: cache.layer,
      analytics,
      goOutput: opts.legacyOutput ? Option.some("json") : Option.none(),
      tty: mockTty({
        stdinIsTty: opts.confirmations !== undefined,
        stdoutIsTty: opts.confirmations !== undefined,
      }),
    }),
    Layer.succeed(PullInitialization, { configPath: opts.initialization ?? Option.none() }),
    mockStdin(false, opts.decline ? "n\n" : undefined),
    mockChildProcessSpawner({ stdout: opts.dirty ? [" M supabase/config.toml\n"] : [] }).layer,
    Layer.succeed(YesFlag, opts.yes ?? !opts.decline),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(DnsResolverFlag, "native"),
    Layer.succeed(ExperimentalFlag, false),
    Layer.succeed(NetworkIdFlag, Option.none()),
    Layer.succeed(DbConfigResolver, {
      resolve: (input) =>
        Effect.sync(() => {
          passwords.push(input.password ?? Option.none());
          const ref = Option.getOrElse(input.linkedProjectRef ?? Option.none(), () => VALID_REF);
          return {
            conn: {
              host: `db.${ref}.supabase.co`,
              port: 5432,
              user: "postgres",
              password: "x",
              database: "postgres",
            },
            isLocal: false,
            ref: Option.some(ref),
          };
        }),
      resolvePoolerFallback: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(DbConnection, {
      connect: (conn) =>
        Effect.sync(() => {
          connections.push(conn);
          return {
            exec: () => Effect.die("unexpected database write"),
            query: () => Effect.die("unexpected migration history query"),
            execBatch: () => Effect.die("unexpected migration batch"),
            extensionExists: () => Effect.die("unexpected extension query"),
            copyToCsv: () => Effect.die("unexpected data export"),
            queryRaw: () => Effect.die("unexpected query"),
          };
        }),
    }),
    Layer.succeed(PgDeltaEngine, {
      exportDeclarativeSchema: (input) =>
        Effect.gen(function* () {
          exports.push({ projectRef: input.projectRef, strictCoverage: input.strictCoverage });
          if (opts.fail === "database")
            return yield* new PgDeltaEngineError({ message: "export failed", cause: "test" });
          return {
            files: [{ name: "public/t.sql", sql: "CREATE TABLE public.t (id integer);\n" }],
            manifest: { redactSecrets: true, scope: "database", profile: "supabase" },
          };
        }),
      diffDatabase: () => Effect.die("unexpected migration diff"),
      diffExplicit: () => Effect.die("unexpected explicit diff"),
      planDeclarativeSchema: () => Effect.die("unexpected declarative plan"),
    }),
    Layer.succeed(GoProxy, {
      exec: () => Effect.die("unexpected Go proxy"),
      execCapture: () => Effect.die("unexpected Go proxy"),
    }),
    Layer.succeed(DockerRun, {
      run: () => Effect.die("unexpected Docker"),
      runCapture: () => Effect.die("unexpected Docker"),
      runStream: () => Effect.die("unexpected Docker"),
    }),
    Layer.succeed(EdgeRuntimeScript, { run: () => Effect.die("unexpected migra") }),
    Layer.succeed(PgDeltaSslProbe, {
      requireSsl: () => Effect.succeed(false),
      requireSslForHost: () => Effect.succeed(false),
    }),
  );
  return { layer, out, api, connections, exports, passwords, cache, telemetry, analytics };
}

function existingConfig(json = false) {
  mkdirSync(join(root.current, "supabase"), { recursive: true });
  writeFileSync(
    join(root.current, "supabase", json ? "config.json" : "config.toml"),
    json
      ? JSON.stringify({ project_id: "local", api: { max_rows: 1000 } })
      : 'project_id = "local"\n[api]\nmax_rows = 1000\n',
  );
}

function writeLink(workdir: string, ref = VALID_REF) {
  mkdirSync(join(workdir, "supabase/.temp"), { recursive: true });
  writeFileSync(join(workdir, "supabase/.temp/project-ref"), ref);
}

function initializeDestination(opts: {
  cwd: string;
  workdir?: string;
  envWorkdir?: string;
  legacyOutput?: boolean;
}) {
  const preflight = Layer.mergeAll(
    BunServices.layer,
    mockOutput().layer,
    mockTty(),
    mockStdin(false),
    Layer.succeed(CliArgs, { args: [] }),
    Layer.succeed(OutputFlag, opts.legacyOutput ? Option.some("json") : Option.none()),
    Layer.succeed(WorkdirFlag, Option.fromUndefinedOr(opts.workdir)),
    Layer.succeed(ProfileFlag, "supabase"),
    Layer.succeed(DebugFlag, false),
    Layer.succeed(YesFlag, true),
    mockRuntimeInfo({ cwd: opts.cwd, homeDir: root.current }),
  ).pipe(Layer.provide(isolatedHomeLayer(root.current, { SUPABASE_WORKDIR: opts.envWorkdir })));
  return commandSettingsLayer.pipe(
    Layer.provide(debugLoggerLayer),
    Layer.provideMerge(pullInitializationLayer),
    Layer.provide(preflight),
  );
}

describe("supabase pull", () => {
  for (const json of [false, true]) {
    it.live(`reuses a linked ${json ? "JSON" : "TOML"} parent from a subfolder`, () => {
      existingConfig(json);
      writeLink(root.current);
      const cwd = join(root.current, "child");
      mkdirSync(cwd);
      return Effect.gen(function* () {
        const settings = yield* CommandSettings;
        expect(settings.workdir).toBe(root.current);
        expect(Option.isNone((yield* PullInitialization).configPath)).toBe(true);
        const s = setup({ workdir: settings.workdir });
        yield* pull(flags).pipe(Effect.provide(s.layer));
        expect(existsSync(join(cwd, "supabase"))).toBe(false);
        expect(readFileSync(join(root.current, "supabase/.temp/project-ref"), "utf8")).toBe(
          VALID_REF,
        );
        expect(s.api.requests.some((r) => r.url.endsWith("/api-keys"))).toBe(false);
        expect(s.out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: expect.objectContaining({ linked: true }),
          }),
        );
      }).pipe(Effect.provide(initializeDestination({ cwd })), Effect.scoped);
    });
  }

  it.live("initializes an explicit destination even inside a linked parent", () => {
    existingConfig();
    writeLink(root.current);
    const cwd = join(root.current, "child");
    mkdirSync(cwd);
    return Effect.gen(function* () {
      expect((yield* CommandSettings).workdir).toBe(cwd);
      expect(Option.isSome((yield* PullInitialization).configPath)).toBe(true);
      expect(existsSync(join(cwd, "supabase/config.toml"))).toBe(true);
      expect(existsSync(join(cwd, "supabase/.temp/project-ref"))).toBe(false);
    }).pipe(Effect.provide(initializeDestination({ cwd, workdir: "." })), Effect.scoped);
  });

  it.live("initializes missing config in a linked folder without losing the link", () => {
    writeLink(root.current);
    return Effect.gen(function* () {
      expect((yield* CommandSettings).workdir).toBe(root.current);
      expect(Option.isSome((yield* PullInitialization).configPath)).toBe(true);
      expect(existsSync(join(root.current, "supabase/config.toml"))).toBe(true);
      expect(readFileSync(join(root.current, "supabase/.temp/project-ref"), "utf8")).toBe(
        VALID_REF,
      );
    }).pipe(Effect.provide(initializeDestination({ cwd: root.current })), Effect.scoped);
  });

  it.live("does not treat a parent's metadata cache as proof of linking", () => {
    existingConfig();
    mkdirSync(join(root.current, "supabase/.temp"));
    writeFileSync(
      join(root.current, "supabase/.temp/linked-project.json"),
      JSON.stringify({ ref: VALID_REF }),
    );
    const cwd = join(root.current, "child");
    mkdirSync(cwd);
    return Effect.gen(function* () {
      expect((yield* CommandSettings).workdir).toBe(cwd);
      expect(Option.isSome((yield* PullInitialization).configPath)).toBe(true);
    }).pipe(Effect.provide(initializeDestination({ cwd })), Effect.scoped);
  });

  it.live("does not cross an unlinked project to reuse a more distant linked ancestor", () => {
    existingConfig();
    writeLink(root.current);
    const project = join(root.current, "child");
    mkdirSync(join(project, "supabase"), { recursive: true });
    writeFileSync(join(project, "supabase/config.json"), "{}");
    const cwd = join(project, "nested");
    mkdirSync(cwd);
    return Effect.gen(function* () {
      expect((yield* CommandSettings).workdir).toBe(cwd);
      expect(Option.isSome((yield* PullInitialization).configPath)).toBe(true);
    }).pipe(Effect.provide(initializeDestination({ cwd })), Effect.scoped);
  });

  it.live("uses an unlinked local JSON config instead of a linked parent", () => {
    existingConfig();
    writeLink(root.current);
    const cwd = join(root.current, "child");
    mkdirSync(join(cwd, "supabase"), { recursive: true });
    writeFileSync(join(cwd, "supabase/config.json"), "{}");
    return Effect.gen(function* () {
      expect((yield* CommandSettings).workdir).toBe(cwd);
      expect(Option.isNone((yield* PullInitialization).configPath)).toBe(true);
      expect(existsSync(join(cwd, "supabase/config.toml"))).toBe(false);
    }).pipe(Effect.provide(initializeDestination({ cwd })), Effect.scoped);
  });

  for (const accept of [true, false]) {
    it.live(
      `${accept ? "links" : "leaves unlinked"} the exported folder when the user ${accept ? "accepts" : "declines"}`,
      () => {
        const s = setup({ format: "text", yes: false, confirmations: [true, accept] });
        return Effect.gen(function* () {
          yield* pull(flags);
          expect(s.out.promptConfirmCalls.at(-1)?.message).toBe(
            `Link this folder to project ${VALID_REF}?`,
          );
          expect(existsSync(join(root.current, "supabase/.temp/project-ref"))).toBe(accept);
          expect(existsSync(join(root.current, "supabase/functions/.env.example"))).toBe(true);
          expect(s.cache.cacheCount).toBe(1);
          expect(s.telemetry.flushCount).toBe(1);
          if (accept) {
            expect(readFileSync(join(root.current, "supabase/.temp/project-ref"), "utf8")).toBe(
              VALID_REF,
            );
            expect(
              readFileSync(join(root.current, "supabase/.temp/postgres-version"), "utf8"),
            ).toBe("17.4.1.001");
            expect(
              s.analytics.captured.filter((event) => event.event === "cli_project_linked"),
            ).toHaveLength(1);
          }
        }).pipe(Effect.provide(s.layer), Effect.scoped);
      },
    );
  }

  for (const link of [true, false]) {
    it.live(`honors --link=${link} when pulling a different project into a linked folder`, () => {
      writeLink(root.current);
      const s = setup();
      return Effect.gen(function* () {
        yield* pull({ ...flags, projectRef: Option.some(OTHER_REF), link: Option.some(link) });
        expect(readFileSync(join(root.current, "supabase/.temp/project-ref"), "utf8")).toBe(
          link ? OTHER_REF : VALID_REF,
        );
        expect(s.api.requests.some((r) => r.url.endsWith("/api-keys"))).toBe(link);
        expect(s.out.messages).toContainEqual(
          expect.objectContaining({
            type: "success",
            data: expect.objectContaining({ linked: link }),
          }),
        );
      }).pipe(Effect.provide(s.layer), Effect.scoped);
    });
  }

  it.live("asks before replacing an existing link and preserves it on decline", () => {
    writeLink(root.current);
    const s = setup({ format: "text", yes: false, confirmations: [true, false] });
    return Effect.gen(function* () {
      yield* pull({ ...flags, projectRef: Option.some(OTHER_REF) });
      expect(s.out.promptConfirmCalls.at(-1)?.message).toBe(
        `Replace this folder's existing link with project ${OTHER_REF}?`,
      );
      expect(readFileSync(join(root.current, "supabase/.temp/project-ref"), "utf8")).toBe(
        VALID_REF,
      );
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });

  it.live("keeps a noninteractive export unlinked without an explicit link choice or --yes", () => {
    const s = setup({ yes: false });
    return Effect.gen(function* () {
      yield* pull(flags);
      expect(existsSync(join(root.current, "supabase/functions/.env.example"))).toBe(true);
      expect(existsSync(join(root.current, "supabase/.temp/project-ref"))).toBe(false);
      expect(s.api.requests.some((r) => r.url.endsWith("/api-keys"))).toBe(false);
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });

  it.live("retains exported files and reports failure if the requested link fails", () => {
    const s = setup({ fail: "link" });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* pull(flags).pipe(Effect.exit))).toBe(true);
      expect(existsSync(join(root.current, "supabase/functions/.env.example"))).toBe(true);
      expect(existsSync(join(root.current, "supabase/.temp/project-ref"))).toBe(false);
      expect(s.out.messages.filter((m) => m.type === "success")).toEqual([]);
      expect(s.cache.cacheCount).toBe(1);
      expect(s.telemetry.flushCount).toBe(1);
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });

  for (const destination of ["cwd", "flag", "env"] as const) {
    it.live(
      `initializes the ${destination} destination before discovering a parent project`,
      () => {
        existingConfig();
        const parentConfig = readFileSync(join(root.current, "supabase/config.toml"), "utf8");
        const cwd = join(root.current, "child");
        const target = destination === "cwd" ? cwd : join(cwd, "export");
        mkdirSync(target, { recursive: true });
        const initializedRuntime = initializeDestination({
          cwd,
          workdir: destination === "flag" ? "export" : undefined,
          envWorkdir:
            destination === "env" ? "export" : destination === "flag" ? "ignored" : undefined,
        });
        return Effect.gen(function* () {
          const settings = yield* CommandSettings;
          const initialization = yield* PullInitialization;
          expect(settings.workdir).toBe(target);
          const s = setup({
            workdir: settings.workdir,
            initialization: initialization.configPath,
            dirty: true,
          });
          yield* pull({ ...flags, projectRef: Option.some(OTHER_REF) }).pipe(
            Effect.provide(s.layer),
          );
          expect(readFileSync(join(target, "supabase/config.toml"), "utf8")).toContain(
            "max_rows = 1234",
          );
          expect(existsSync(join(target, "supabase/schemas/public/t.sql"))).toBe(true);
          expect(existsSync(join(target, "supabase/functions/hello-world/index.ts"))).toBe(true);
          expect(readFileSync(join(target, "supabase/functions/.env.example"), "utf8")).toContain(
            "API_KEY=\n",
          );
          expect(readFileSync(join(root.current, "supabase/config.toml"), "utf8")).toBe(
            parentConfig,
          );
          expect(existsSync(join(root.current, "supabase/schemas"))).toBe(false);
          expect(existsSync(join(root.current, "supabase/functions"))).toBe(false);
          if (destination !== "cwd") expect(existsSync(join(cwd, "supabase"))).toBe(false);
        }).pipe(Effect.provide(initializedRuntime), Effect.scoped);
      },
    );
  }

  for (const json of [false, true]) {
    it.live(`retains an existing ${json ? "JSON" : "TOML"} config during initialization`, () => {
      existingConfig(json);
      const configPath = join(root.current, "supabase", json ? "config.json" : "config.toml");
      const before = readFileSync(configPath, "utf8");
      return Effect.gen(function* () {
        expect(Option.isNone((yield* PullInitialization).configPath)).toBe(true);
        expect(readFileSync(configPath, "utf8")).toBe(before);
        if (json) expect(existsSync(join(root.current, "supabase/config.toml"))).toBe(false);
      }).pipe(Effect.provide(initializeDestination({ cwd: root.current })), Effect.scoped);
    });
  }

  it.live("keeps normal ancestor lookup when the current supabase directory already exists", () => {
    existingConfig();
    const cwd = join(root.current, "child");
    mkdirSync(join(cwd, "supabase"), { recursive: true });
    return Effect.gen(function* () {
      expect(Option.isNone((yield* PullInitialization).configPath)).toBe(true);
      expect((yield* CommandSettings).workdir).toBe(root.current);
      expect(existsSync(join(cwd, "supabase/config.toml"))).toBe(false);
    }).pipe(Effect.provide(initializeDestination({ cwd })), Effect.scoped);
  });

  it.live("does not initialize a project when legacy output is rejected", () =>
    Effect.gen(function* () {
      expect(Option.isNone((yield* PullInitialization).configPath)).toBe(true);
      expect(existsSync(join(root.current, "supabase"))).toBe(false);
    }).pipe(
      Effect.provide(initializeDestination({ cwd: root.current, legacyOutput: true })),
      Effect.scoped,
    ),
  );

  it.live("rejects a missing workdir before creating a scaffold", () =>
    Effect.gen(function* () {
      const exit = yield* PullInitialization.pipe(
        Effect.provide(initializeDestination({ cwd: root.current, workdir: "missing" })),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(existsSync(join(root.current, "missing"))).toBe(false);
      expect(existsSync(join(root.current, "supabase"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.live("parses the project flags and their defaults through the command", () => {
    const parsed: PullFlags[] = [];
    const command = pullCommand.pipe(
      Command.withHandler((value) =>
        Effect.sync(() => {
          parsed.push(value);
        }),
      ),
    );
    return Effect.gen(function* () {
      yield* Command.runWith(command, { version: "test" })([]);
      yield* Command.runWith(command, { version: "test" })([
        "--project-ref",
        OTHER_REF,
        "-p",
        "test-password",
        "--force",
        "--strict-coverage",
        "--use-api",
        "--link=false",
      ]);
      expect(parsed).toEqual([
        { ...flags, useApi: false },
        {
          projectRef: Option.some(OTHER_REF),
          password: Option.some("test-password"),
          force: true,
          strictCoverage: true,
          useApi: true,
          link: Option.some(false),
        },
      ]);
    }).pipe(
      Effect.provide(Layer.mergeAll(BunServices.layer, CliOutput.layer(textCliOutputFormatter()))),
    );
  });

  for (const format of ["text", "json", "stream-json"] as const) {
    it.live(`pulls a fresh project with ${format} output`, () => {
      const s = setup({ format });
      return Effect.gen(function* () {
        yield* pull({
          ...flags,
          projectRef: Option.some(OTHER_REF),
          password: Option.some("test-password"),
          strictCoverage: true,
        });
        expect(readFileSync(join(root.current, "supabase/config.toml"), "utf8")).toContain(
          "max_rows = 1234",
        );
        expect(readFileSync(join(root.current, "supabase/schemas/public/t.sql"), "utf8")).toContain(
          "CREATE TABLE",
        );
        expect(
          readFileSync(join(root.current, "supabase/functions/hello-world/index.ts"), "utf8"),
        ).toContain("Deno.serve");
        const example = readFileSync(join(root.current, "supabase/functions/.env.example"), "utf8");
        expect(example).toContain("API_KEY=\nZEBRA_KEY=\n");
        expect(example).not.toContain("digest");
        expect(existsSync(join(root.current, "supabase/migrations"))).toBe(false);
        expect(s.exports).toEqual([{ projectRef: OTHER_REF, strictCoverage: true }]);
        expect(s.passwords).toEqual([Option.some("test-password")]);
        expect(s.cache.cacheCount).toBe(1);
        expect(s.telemetry.flushCount).toBe(1);
        expect(s.api.requests.every((r) => r.url.includes(OTHER_REF))).toBe(true);
        if (format !== "text") {
          expect(s.out.messages.filter((m) => m.type === "success")).toHaveLength(1);
          expect(s.out.rawChunks.filter((m) => m.stream === "stdout")).toEqual([]);
        }
      }).pipe(Effect.provide(s.layer), Effect.scoped);
    });
  }

  it.live(
    "updates an existing JSON project and writes an empty example when there are no functions or secrets",
    () => {
      existingConfig(true);
      const s = setup({ empty: true });
      return Effect.gen(function* () {
        yield* pull(flags);
        expect(existsSync(join(root.current, "supabase/config.toml"))).toBe(false);
        expect(
          JSON.parse(readFileSync(join(root.current, "supabase/config.json"), "utf8")).api.max_rows,
        ).toBe(1234);
        expect(readFileSync(join(root.current, "supabase/functions/.env.example"), "utf8")).toMatch(
          /^#.*\n$/,
        );
        expect(s.exports[0]?.projectRef).toBe(VALID_REF);
      }).pipe(Effect.provide(s.layer), Effect.scoped);
    },
  );

  it.live("stops when the config confirmation is declined", () => {
    existingConfig();
    const s = setup({ format: "text", decline: true });
    return Effect.gen(function* () {
      yield* pull(flags);
      expect(s.connections).toEqual([]);
      expect(s.api.requests).toHaveLength(1);
      expect(readFileSync(join(root.current, "supabase/config.toml"), "utf8")).toContain("1000");
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });

  for (const fail of ["config", "database", "functions", "secrets"] as const) {
    it.live(`stops on ${fail} failure without reporting project success`, () => {
      const s = setup({ fail });
      return Effect.gen(function* () {
        const exit = yield* pull(flags).pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(s.out.messages.filter((m) => m.type === "success")).toEqual([]);
        expect(s.cache.cacheCount).toBe(1);
        expect(s.telemetry.flushCount).toBe(1);
        expect(existsSync(join(root.current, "supabase/functions/.env.example"))).toBe(false);
        if (fail === "config") expect(s.connections).toEqual([]);
        if (fail === "database")
          expect(s.api.requests.some((r) => r.url.endsWith("/functions"))).toBe(false);
        if (fail === "functions")
          expect(s.api.requests.some((r) => r.url.endsWith("/secrets"))).toBe(false);
      }).pipe(Effect.provide(s.layer), Effect.scoped);
    });
  }

  it.live("rejects legacy output before creating files or contacting the project", () => {
    const s = setup({ legacyOutput: true });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* pull(flags).pipe(Effect.exit))).toBe(true);
      expect(s.api.requests).toEqual([]);
      expect(s.telemetry.flushCount).toBe(1);
      expect(s.cache.cacheCount).toBe(0);
      expect(existsSync(join(root.current, "supabase"))).toBe(false);
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });

  for (const force of [false, true]) {
    it.live(`${force ? "updates" : "protects"} dirty config with force=${force}`, () => {
      existingConfig();
      const s = setup({ dirty: true, empty: true });
      return Effect.gen(function* () {
        const exit = yield* pull({ ...flags, force }).pipe(Effect.exit);
        expect(Exit.isSuccess(exit)).toBe(force);
        expect(s.exports).toHaveLength(force ? 1 : 0);
      }).pipe(Effect.provide(s.layer), Effect.scoped);
    });
  }

  it.live("refuses secret names that would inject extra lines into the example", () => {
    const s = setup({ invalidSecret: true });
    return Effect.gen(function* () {
      expect(Exit.isFailure(yield* pull(flags).pipe(Effect.exit))).toBe(true);
      expect(existsSync(join(root.current, "supabase/functions/.env.example"))).toBe(false);
    }).pipe(Effect.provide(s.layer), Effect.scoped);
  });
});
