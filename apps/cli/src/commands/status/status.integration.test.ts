import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import type { ApiClient, V1ListAllBranchesOutput } from "@supabase/api/effect";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Layer, Option, PlatformError, Sink, Stdio, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as HttpClientRequestModule from "effect/unstable/http/HttpClientRequest";
import { afterEach, vi } from "vitest";

import { mockOutput, mockProcessControl } from "../../../tests/helpers/mocks.ts";
import {
  statusCodeFailure,
  transportFailure,
  mockCommandSettings,
  mockCommandPlatformApiService,
  mockTelemetryStateTracked,
  useTempWorkdir,
} from "../../../tests/helpers/command-mocks.ts";
import type { CommandPlatformApiFactoryError } from "../../auth/command-platform-api-factory.service.ts";
import { CommandPlatformApiFactory } from "../../auth/command-platform-api-factory.service.ts";
import { AccessTokenRequiredError } from "../../auth/errors.ts";
import { OutputFlag } from "../../command-internal/global-flags.ts";
import { withJsonErrorHandling } from "../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../shared/output/output.layer.ts";
import { serviceContainerIds, localDbContainerId } from "../../command-internal/docker-ids.ts";
import type { StatusFlags } from "./status.command.ts";
import { status } from "./status.handler.ts";

type LinkedStateBranches = typeof V1ListAllBranchesOutput.Type;
type LinkedStateBranch = LinkedStateBranches[number];

const tempRoot = useTempWorkdir("supabase-status-int-");

afterEach(() => {
  delete process.env["SUPABASE_AUTH_JWT_SECRET"];
});

function flags(overrides: Partial<StatusFlags> = {}): StatusFlags {
  return {
    overrideName: [],
    exclude: [],
    ignoreHealthCheck: false,
    ...overrides,
  };
}

function writeConfig(workdir: string, contents = 'project_id = "demo"\n') {
  const supabaseDir = join(workdir, "supabase");
  mkdirSync(supabaseDir, { recursive: true });
  writeFileSync(join(supabaseDir, "config.toml"), contents);
}

// Linked-state fixtures: distinct 20-lowercase-letter refs so it's unambiguous which candidate
// (branch vs. parent) a given assertion targets.

const LINKED_PARENT_REF = "parentprojectrefxxxx";
const LINKED_BRANCH_REF = "branchprojectrefyyyy";
const LINKED_PLAIN_REF = "plainprojectrefzzzzz";

const LINKED_BRANCH: LinkedStateBranch = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "feature-x",
  project_ref: LINKED_BRANCH_REF,
  parent_project_ref: LINKED_PARENT_REF,
  is_default: false,
  persistent: false,
  status: "MIGRATIONS_PASSED",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  with_data: false,
};

function tempFile(workdir: string, name: string): string {
  return join(workdir, "supabase", ".temp", name);
}

function writeTempContent(workdir: string, name: string, content: string): void {
  mkdirSync(join(workdir, "supabase", ".temp"), { recursive: true });
  writeFileSync(tempFile(workdir, name), content);
}

function writeProjectRefFile(workdir: string, ref: string): void {
  writeTempContent(workdir, "project-ref", ref);
}

/**
 * Writes `linked-project.json`. `orgSlug`/`orgId` default to distinct values
 * (`"acme"`/`"org_1"`) matching the common real-world case — pass `null`
 * explicitly to omit a field entirely (the "neither known" org variant).
 */
function writeLinkedProjectCacheFile(
  workdir: string,
  ref: string,
  opts: {
    readonly name?: string;
    readonly orgSlug?: string | null;
    readonly orgId?: string | null;
  } = {},
): void {
  const orgSlug = opts.orgSlug === undefined ? "acme" : opts.orgSlug;
  const orgId = opts.orgId === undefined ? "org_1" : opts.orgId;
  writeTempContent(
    workdir,
    "linked-project.json",
    JSON.stringify({
      ref,
      ...(opts.name === undefined ? {} : { name: opts.name }),
      ...(orgSlug === null ? {} : { organization_slug: orgSlug }),
      ...(orgId === null ? {} : { organization_id: orgId }),
    }),
  );
}

function transportFailureForMock() {
  return transportFailure(HttpClientRequestModule.get("https://api.supabase.com/mock"));
}

/**
 * Wires `CommandPlatformApiFactory` directly (`make` resolves immediately to a stubbed client),
 * not `CommandPlatformApi`. Matches the runtime shape `status` actually provides
 * (`commandPlatformApiFactoryLayer` in `status.command.ts`), as opposed to a direct-service
 * `branches` mock, which a real `status` invocation never has.
 */
function mockCommandPlatformApiFactoryDirect(opts: {
  readonly ok?: LinkedStateBranches;
  readonly fail?: unknown;
  /** When set, `factory.make` itself fails (e.g. no/invalid token) before any
   * `v1` call is ever attempted — distinct from `fail`, which lets `make`
   * succeed and fails the `listAllBranches` call instead. */
  readonly makeFails?: CommandPlatformApiFactoryError;
}) {
  const requests: Array<{ method: string; input: unknown }> = [];
  const v1Proxy = new Proxy({} as ApiClient["v1"], {
    get(_target, prop: string) {
      return (input: unknown) =>
        Effect.gen(function* () {
          requests.push({ method: prop, input });
          if (prop !== "listAllBranches") {
            return yield* Effect.die(`Unmocked factory-backed CommandPlatformApi.v1.${prop}`);
          }
          if (opts.fail !== undefined) return yield* Effect.fail(opts.fail);
          return opts.ok ?? [];
        });
    },
  });
  const v2Proxy = new Proxy({} as ApiClient["v2"], {
    get(_target, prop: string) {
      return () => Effect.die(`Unmocked factory-backed CommandPlatformApi.v2.${prop}`);
    },
  });
  const client = {
    v1: v1Proxy,
    v2: v2Proxy,
    executeRaw: () => Effect.die("Unmocked executeRaw"),
  } as ApiClient;
  const make = opts.makeFails !== undefined ? Effect.fail(opts.makeFails) : Effect.succeed(client);
  const layer = Layer.succeed(CommandPlatformApiFactory, { make });
  return { layer, requests };
}

interface SpawnRecord {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

type RouteResult = {
  readonly exitCode?: number;
  readonly stdout?: ReadonlyArray<string>;
  readonly stderr?: ReadonlyArray<string>;
};

/** Same routing-by-argv mock spawner shape as `stop.integration.test.ts`. */
function mockRoutedContainerCliSpawner(
  route: (args: ReadonlyArray<string>) => RouteResult,
  opts: {
    readonly dockerMissing?: boolean;
    readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  } = {},
) {
  const spawned: Array<SpawnRecord> = [];

  const layer = Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        const cmd = command._tag === "StandardCommand" ? command.command : "";
        const args = command._tag === "StandardCommand" ? command.args : [];
        spawned.push({ command: cmd, args });

        if (opts.dockerMissing === true && cmd === "docker") {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "docker not found",
            }),
          );
        }

        if (opts.failSpawnFor?.(args) === true) {
          return yield* Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              module: "ChildProcess",
              method: "spawn",
              description: "spawn failed",
            }),
          );
        }

        const encoder = new TextEncoder();
        const result = route(args);
        const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        yield* Effect.forkDetach(
          Effect.gen(function* () {
            yield* Effect.sleep("5 millis");
            yield* Deferred.succeed(
              exitDeferred,
              ChildProcessSpawner.ExitCode(result.exitCode ?? 0),
            );
          }),
        );
        const stdoutBytes = (result.stdout ?? []).map((line) => encoder.encode(`${line}\n`));
        const stderrBytes = (result.stderr ?? []).map((line) => encoder.encode(`${line}\n`));

        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(5000 + spawned.length),
          stdout: Stream.fromIterable(stdoutBytes),
          stderr: Stream.fromIterable(stderrBytes),
          all: Stream.empty,
          exitCode: Deferred.await(exitDeferred),
          isRunning: Effect.succeed(false),
          stdin: Sink.drain,
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        });
      }),
    ),
  );

  return {
    layer,
    get spawned() {
      return spawned;
    },
  };
}

const ALL_RUNNING_NAMES = serviceContainerIds("demo");
const HEALTHY_DB_STATE = JSON.stringify({
  Status: "running",
  Running: true,
  Health: { Status: "healthy" },
});

/**
 * Default happy-path router: db container inspect reports healthy+running, `ps`
 * (names format) lists every one of the 13 expected services as running.
 */
function defaultRoute(
  opts: {
    readonly runningNames?: ReadonlyArray<string>;
    readonly dbInspectStdout?: string;
    readonly dbInspectExitCode?: number;
    readonly dbInspectStderr?: ReadonlyArray<string>;
  } = {},
) {
  const runningNames = opts.runningNames ?? ALL_RUNNING_NAMES;
  return (args: ReadonlyArray<string>): RouteResult => {
    if (args[0] === "container" && args[1] === "inspect") {
      return {
        exitCode: opts.dbInspectExitCode ?? 0,
        stdout: [opts.dbInspectStdout ?? HEALTHY_DB_STATE],
        stderr: opts.dbInspectStderr,
      };
    }
    if (args[0] === "ps") return { stdout: runningNames };
    return { exitCode: 0 };
  };
}

interface SetupOpts {
  readonly format?: "text" | "json" | "stream-json";
  readonly goOutput?: Option.Option<"env" | "pretty" | "json" | "toml" | "yaml">;
  readonly route?: (args: ReadonlyArray<string>) => RouteResult;
  readonly dockerMissing?: boolean;
  readonly failSpawnFor?: (args: ReadonlyArray<string>) => boolean;
  readonly skipConfig?: boolean;
  readonly configContents?: string;
  /** Defaults to `tempRoot.current` — override for `--workdir`-resolution tests. */
  readonly workdir?: string;
  /**
   * When set, wires a `CommandPlatformApi` layer stubbing `listAllBranches` for
   * `resolveLinkedState`'s branch lookup. Omitted by default, matching `status`'s real runtime
   * (no Management API layer), so `Effect.serviceOption(CommandPlatformApi)` resolves to `None`.
   */
  readonly branches?: { readonly ok?: LinkedStateBranches; readonly fail?: unknown };
  /**
   * When set instead of `branches`, wires only `CommandPlatformApiFactory` — the shape
   * `status`'s real runtime actually provides. Pins `acquireBranchLookupApi`'s factory-fallback path.
   */
  readonly apiFactory?: {
    readonly ok?: LinkedStateBranches;
    readonly fail?: unknown;
    readonly makeFails?: CommandPlatformApiFactoryError;
  };
  /** `SUPABASE_PROJECT_ID` for the linked-state chain — defaults to unset. */
  readonly projectId?: Option.Option<string>;
}

function setup(opts: SetupOpts = {}) {
  const workdir = opts.workdir ?? tempRoot.current;
  if (opts.skipConfig !== true) {
    writeConfig(workdir, opts.configContents);
  }
  const out = mockOutput({
    format: opts.format ?? "text",
    interactive: (opts.format ?? "text") === "text",
  });
  const telemetry = mockTelemetryStateTracked();
  const cliSettings = mockCommandSettings({
    workdir,
    projectId: opts.projectId ?? Option.none(),
  });
  const child = mockRoutedContainerCliSpawner(opts.route ?? defaultRoute(), {
    dockerMissing: opts.dockerMissing,
    failSpawnFor: opts.failSpawnFor,
  });
  const apiMock =
    opts.branches === undefined
      ? undefined
      : mockCommandPlatformApiService({
          v1: {
            listAllBranches:
              opts.branches.fail !== undefined
                ? () => Effect.fail(opts.branches?.fail)
                : () => Effect.succeed(opts.branches?.ok ?? []),
          },
        });
  const apiFactoryMock =
    opts.apiFactory === undefined
      ? undefined
      : mockCommandPlatformApiFactoryDirect(opts.apiFactory);

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliSettings,
    telemetry.layer,
    child.layer,
    Layer.succeed(OutputFlag, opts.goOutput ?? Option.none()),
    ...(apiMock === undefined ? [] : [apiMock.layer]),
    ...(apiFactoryMock === undefined ? [] : [apiFactoryMock.layer]),
  );

  return { workdir, out, telemetry, child, layer, apiMock, apiFactoryMock };
}

/**
 * A real captured `Stdio` layer (mirrors `output.layer.unit.test.ts`'s local `mockStdio()`) —
 * needed only by the failure-envelope tests below, since the `MachineErrorContext` merge they
 * pin lives inside the real `jsonOutputLayer`/`streamJsonOutputLayer` `fail` implementations,
 * which `setup()`'s `mockOutput()` fake never replicates.
 */
function mockCapturingStdio() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const layer = Layer.succeed(
    Stdio.Stdio,
    Stdio.make({
      args: Effect.succeed([]),
      stdin: Stream.empty,
      stdout: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stdout.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
      stderr: () =>
        Sink.forEach((item: string | Uint8Array) =>
          Effect.sync(() => {
            stderr.push(typeof item === "string" ? item : new TextDecoder().decode(item));
          }),
        ),
    }),
  );
  return { layer, stdout, stderr };
}

interface FailureEnvelopeOpts {
  readonly format: "json" | "stream-json";
  /** Defaults to `true` — pass `false` to reproduce a runtime that never wires
   * the cell at all (the inertness guard). */
  readonly withMachineErrorContext?: boolean;
  readonly branches?: { readonly ok?: LinkedStateBranches; readonly fail?: unknown };
}

/**
 * Dedicated setup for the json/stream-json failure-envelope tests: wires the real
 * `jsonOutputLayer`/`streamJsonOutputLayer` over a captured `Stdio`, a real
 * `mockProcessControl()` (failure in these formats signals via exit code, not `Effect.fail`),
 * and `machineErrorContextLayer` merged alongside the output layer (matching
 * `status.command.ts`'s composition) so the handler and the output layer's `fail` share the same
 * live cell. Every scenario forces a daemon-connection failure (`failSpawnFor: () => true`) so
 * the command fails with `StatusDbInspectError` after the linked-state block has already resolved.
 */
function setupFailureEnvelope(opts: FailureEnvelopeOpts) {
  const workdir = tempRoot.current;
  writeConfig(workdir);
  const stdio = mockCapturingStdio();
  const telemetry = mockTelemetryStateTracked();
  const cliSettings = mockCommandSettings({ workdir, projectId: Option.none() });
  const child = mockRoutedContainerCliSpawner(defaultRoute(), { failSpawnFor: () => true });
  const processControl = mockProcessControl();
  const apiMock =
    opts.branches === undefined
      ? undefined
      : mockCommandPlatformApiService({
          v1: {
            listAllBranches:
              opts.branches.fail !== undefined
                ? () => Effect.fail(opts.branches?.fail)
                : () => Effect.succeed(opts.branches?.ok ?? []),
          },
        });
  const outputLayer = opts.format === "json" ? jsonOutputLayer : streamJsonOutputLayer;

  const layer = Layer.mergeAll(
    BunServices.layer,
    outputLayer.pipe(Layer.provide(stdio.layer)),
    cliSettings,
    telemetry.layer,
    child.layer,
    processControl.layer,
    Layer.succeed(OutputFlag, Option.none()),
    ...(opts.withMachineErrorContext === false ? [] : [machineErrorContextLayer]),
    ...(apiMock === undefined ? [] : [apiMock.layer]),
  );

  return { workdir, layer, stdio, processControl };
}

describe("status integration", () => {
  it.live("shows the running stack as a pretty table", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stderrText).toContain("local development setup is running.");
      expect(out.stdoutText).toContain("🔧 Development Tools");
      expect(out.stdoutText).toContain("🌐 APIs");
      expect(out.stdoutText).toContain("⛁ Database");
      expect(out.stdoutText).toContain("🔑 Authentication Keys");
      expect(out.stdoutText).toContain("📦 Storage (S3)");
      expect(out.stdoutText).toContain("postgresql://postgres:postgres@");
      expect(out.stderrText).not.toContain("Stopped services:");
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "sanitizes a dirty config.toml project_id before filtering, matching start's label",
    () => {
      const { layer, child } = setup({ configContents: 'project_id = "My App!!"\n' });
      return Effect.gen(function* () {
        yield* status(flags());
        const inspectCall = child.spawned.find(
          (s) => s.args[0] === "container" && s.args[1] === "inspect",
        );
        expect(inspectCall?.args[2]).toBe(localDbContainerId("My_App_"));
        const psCall = child.spawned.find((s) => s.args[0] === "ps");
        expect(psCall?.args).toContain("label=com.supabase.cli.project=My_App_");
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("skips the db health check with --ignore-health-check", () => {
    const { layer, child } = setup({
      route: (args) => {
        // db inspect would fail if called; ps still needs to succeed.
        if (args[0] === "container" && args[1] === "inspect") return { exitCode: 1 };
        if (args[0] === "ps") return { stdout: ALL_RUNNING_NAMES };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      yield* status(flags({ ignoreHealthCheck: true }));
      expect(child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "inspect")).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "succeeds against an unhealthy db when --ignore-health-check is set (status.go:104-108)",
    () => {
      // Pairs with "fails when the db container is unhealthy" below to cover both sides of
      // the ignore-health-check gate.
      const { layer, child } = setup({
        route: defaultRoute({
          dbInspectStdout: JSON.stringify({
            Status: "running",
            Running: true,
            Health: { Status: "starting" },
          }),
        }),
      });
      return Effect.gen(function* () {
        yield* status(flags({ ignoreHealthCheck: true }));
        expect(
          child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "inspect"),
        ).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("reports stopped services on stderr", () => {
    const { layer, out } = setup({
      route: defaultRoute({ runningNames: ALL_RUNNING_NAMES.slice(1) }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      const missing = ALL_RUNNING_NAMES[0];
      expect(out.stderrText).toContain(`Stopped services: [${missing}]`);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when config.toml is malformed", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(join(workdir, "supabase", "config.toml"), "not valid toml =====");
    const { layer, child } = setup({ skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when [remotes.*] has a duplicate project_id, even with no projectRef", () => {
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      `project_id = "baseref"

[remotes.a]
project_id = "previewrefaaaaaaaaaa"

[remotes.b]
project_id = "previewrefaaaaaaaaaa"
`,
    );
    const { layer, child } = setup({ skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when a [remotes.*] project_id is not a valid 20-letter ref", () => {
    // Config validation checks every [remotes.*].project_id
    // against the ref pattern unconditionally on every config load — not only a
    // remote that ends up selected — so this must fail closed before status
    // reaches Docker, even with no --project-ref requested.
    const workdir = tempRoot.current;
    mkdirSync(join(workdir, "supabase"), { recursive: true });
    writeFileSync(
      join(workdir, "supabase", "config.toml"),
      `project_id = "baseref"

[remotes.bad]
project_id = "short"
`,
    );
    const { layer, child } = setup({ skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "decodes a comma-separated string into an array field ([]string) for status to proceed",
    () => {
      const { layer } = setup({
        configContents:
          'project_id = "demo"\n[auth]\nadditional_redirect_urls = "http://a,http://b"\n',
      });
      return Effect.gen(function* () {
        yield* status(flags());
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("warns on stderr for a deprecated auth.external provider", () => {
    // `normalizeDeprecatedExternalProviders` (packages/config/src/io.ts) emits this warning via
    // `Console.error` only when `goViperCompat` is set.
    const { layer } = setup({
      configContents: 'project_id = "demo"\n[auth.external.slack]\nenabled = true\n',
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    return Effect.gen(function* () {
      yield* status(flags());
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARN: disabling deprecated "slack" provider'),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
    // Must fail before falling through to the workdir-basename default.
    const missingWorkdir = join(tempRoot.current, "does-not-exist");
    const { layer, child } = setup({ workdir: missingWorkdir, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusWorkdirError");
        expect(JSON.stringify(exit.cause)).toContain(
          `failed to change workdir: chdir ${missingWorkdir}: no such file or directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a file, not a directory", () => {
    const filePath = join(tempRoot.current, "not-a-directory");
    writeFileSync(filePath, "");
    const { layer, child } = setup({ workdir: filePath, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusWorkdirError");
        expect(JSON.stringify(exit.cause)).toContain(
          `failed to change workdir: chdir ${filePath}: not a directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when auth.jwt_secret is configured but shorter than 16 characters", () => {
    const { layer, child } = setup({
      configContents: 'project_id = "demo"\n[auth]\njwt_secret = "too-short"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusInvalidConfigError");
        expect(JSON.stringify(exit.cause)).toContain(
          "Invalid config for auth.jwt_secret. Must be at least 16 characters",
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves auth email content_path keys from the same project-root base", () => {
    const { layer, child, workdir } = setup({
      configContents: `project_id = "demo"
[auth.email.template.recovery]
content_path = "./supabase/templates/recovery.html"
[auth.email.notification.password_changed]
enabled = true
content_path = "./supabase/templates/password_changed_notification.html"
`,
    });
    const templateDir = join(workdir, "supabase", "templates");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "recovery.html"), "<p>Recovery</p>");
    writeFileSync(
      join(templateDir, "password_changed_notification.html"),
      "<p>Password changed</p>",
    );

    return Effect.gen(function* () {
      yield* status(flags());
      expect(child.spawned.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_AUTH_JWT_SECRET over a config.toml value with -o env", () => {
    const { layer, out } = setup({
      goOutput: Option.some("env"),
      configContents: `project_id = "demo"\n[auth]\njwt_secret = "${"a".repeat(32)}"\n`,
    });
    process.env["SUPABASE_AUTH_JWT_SECRET"] = "b".repeat(32);
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stdoutText).toContain(`JWT_SECRET="${"b".repeat(32)}"`);
      expect(out.stdoutText).not.toContain("a".repeat(32));
    }).pipe(Effect.provide(layer));
  });

  it.live("signs anon/service_role keys asymmetrically when signing_keys_path is set", () => {
    // Uses the first key in `auth.signing_keys_path` (RS256/ES256) instead of HMAC.
    const { layer, out, workdir } = setup({
      goOutput: Option.some("json"),
      configContents: 'project_id = "demo"\n[auth]\nsigning_keys_path = "signing_keys.json"\n',
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" };
    writeFileSync(join(workdir, "supabase", "signing_keys.json"), JSON.stringify([jwk]));
    return Effect.gen(function* () {
      yield* status(flags());
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      const [headerSegment] = parsed.ANON_KEY?.split(".") ?? [];
      const header = JSON.parse(Buffer.from(headerSegment ?? "", "base64url").toString());
      expect(header).toEqual({ alg: "RS256", kid: "test-kid", typ: "JWT" });
    }).pipe(Effect.provide(layer));
  });

  it.live("reports status using schema defaults when config.toml is missing entirely", () => {
    // Without config.toml, the resolved project id falls back to the workdir basename, not the
    // module-level `ALL_RUNNING_NAMES` (fixed to "demo") — route `ps` off that basename instead.
    const projectId = basename(tempRoot.current);
    const { layer, out } = setup({
      skipConfig: true,
      route: defaultRoute({ runningNames: serviceContainerIds(projectId) }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stderrText).toContain("local development setup is running.");
      expect(out.stdoutText).toContain("Project URL");
      expect(out.stdoutText).toContain("Database");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env over config.toml", () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=env-file-project\n");
    const { layer, child } = setup({
      configContents: 'project_id = "toml-project"\n',
      route: defaultRoute({ runningNames: serviceContainerIds("env-file-project") }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("env-file-project"));
    }).pipe(Effect.provide(layer));
  });

  it.live("prefers ambient SUPABASE_PROJECT_ID over supabase/.env", () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=env-file-project\n");
    process.env["SUPABASE_PROJECT_ID"] = "ambient-project";
    const { layer, child } = setup({
      configContents: 'project_id = "toml-project"\n',
      route: defaultRoute({ runningNames: serviceContainerIds("ambient-project") }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("ambient-project"));
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => delete process.env["SUPABASE_PROJECT_ID"])),
    );
  });

  it.live("resolves SUPABASE_PROJECT_ID from a project-root .env file", () => {
    writeFileSync(join(tempRoot.current, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const { layer, child } = setup({
      configContents: 'project_id = "toml-project"\n',
      route: defaultRoute({ runningNames: serviceContainerIds("root-env-project") }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("root-env-project"));
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not climb to an ancestor project's config.toml when workdir has none of its own",
    () => {
      const nestedWorkdir = join(tempRoot.current, "nested");
      mkdirSync(nestedWorkdir, { recursive: true });
      writeConfig(tempRoot.current, 'project_id = "ancestor-project"\n');
      const projectId = basename(nestedWorkdir);
      const { layer, child } = setup({
        workdir: nestedWorkdir,
        skipConfig: true,
        route: defaultRoute({ runningNames: serviceContainerIds(projectId) }),
      });
      return Effect.gen(function* () {
        yield* status(flags());
        const inspectCall = child.spawned.find(
          (s) => s.args[0] === "container" && s.args[1] === "inspect",
        );
        expect(inspectCall?.args).toContain(localDbContainerId(projectId));
        expect(inspectCall?.args).not.toContain(localDbContainerId("ancestor-project"));
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env even when config.toml is absent", () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=no-config-project\n");
    const { layer, child } = setup({
      skipConfig: true,
      route: defaultRoute({ runningNames: serviceContainerIds("no-config-project") }),
    });
    return Effect.gen(function* () {
      yield* status(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("no-config-project"));
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_AUTH_JWT_SECRET from supabase/.env, not just the ambient shell", () => {
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), `SUPABASE_AUTH_JWT_SECRET=${"c".repeat(32)}\n`);
    const { layer, out } = setup({
      goOutput: Option.some("env"),
      configContents: `project_id = "demo"\n[auth]\njwt_secret = "${"a".repeat(32)}"\n`,
    });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stdoutText).toContain(`JWT_SECRET="${"c".repeat(32)}"`);
      expect(out.stdoutText).not.toContain("a".repeat(32));
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when both docker and podman are missing", () => {
    const { layer } = setup({ failSpawnFor: () => true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to podman when docker is absent", () => {
    const { layer, child } = setup({ dockerMissing: true });
    return Effect.gen(function* () {
      yield* status(flags());
      // The failed `docker` attempt is recorded before the `podman` fallback fires, so the last
      // matching record for a given argv is the successful one.
      const psCalls = child.spawned.filter((s) => s.args[0] === "ps");
      expect(psCalls.at(-1)?.command).toBe("podman");
      expect(psCalls.some((s) => s.command === "docker")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when listing running containers errors", () => {
    const { layer } = setup({
      route: (args) => {
        if (args[0] === "container" && args[1] === "inspect") {
          return { exitCode: 0, stdout: [HEALTHY_DB_STATE] };
        }
        if (args[0] === "ps") return { exitCode: 1, stderr: ["daemon down"] };
        return { exitCode: 0 };
      },
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusListError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the db container is not running", () => {
    const { layer } = setup({
      route: defaultRoute({
        dbInspectStdout: JSON.stringify({ Status: "exited", Running: false }),
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const serialized = JSON.stringify(exit.cause);
        expect(serialized).toContain("StatusDbNotRunningError");
        expect(serialized).toContain(localDbContainerId("demo"));
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "succeeds against a paused-but-healthy db, matching Go's boolean-based running gate",
    () => {
      // Gates on the boolean `Running`, not the status string — `Running: true` can coexist
      // with `Status: "paused"`, and the handler continues past the not-running branch.
      const { layer } = setup({
        route: defaultRoute({
          dbInspectStdout: JSON.stringify({
            Status: "paused",
            Running: true,
            Health: { Status: "healthy" },
          }),
        }),
      });
      return Effect.gen(function* () {
        yield* status(flags());
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when the db container is absent, preserving the real Docker stderr text", () => {
    const { layer } = setup({
      route: defaultRoute({
        dbInspectExitCode: 1,
        dbInspectStderr: ["Error response from daemon: No such container: x"],
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const serialized = JSON.stringify(exit.cause);
        expect(serialized).toContain("StatusDbInspectError");
        expect(serialized).toContain(
          "failed to inspect container health: Error response from daemon: No such container: x",
        );
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when the db container is unhealthy", () => {
    const { layer } = setup({
      route: defaultRoute({
        dbInspectStdout: JSON.stringify({
          Status: "running",
          Running: true,
          Health: { Status: "starting" },
        }),
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusDbNotReadyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when db inspect errors for a reason other than not-found", () => {
    const { layer } = setup({
      route: defaultRoute({ dbInspectExitCode: 1, dbInspectStderr: ["permission denied"] }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs env vars with -o env", () => {
    const { layer, out } = setup({ goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.stdoutText).toContain("DB_URL=");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs a json object with -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* status(flags());
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.DB_URL).toContain("postgresql://postgres:postgres@");
    }).pipe(Effect.provide(layer));
  });

  it.live("omits excluded services from -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      const storageId = serviceContainerIds("demo")[5]!;
      yield* status(flags({ exclude: [storageId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.STORAGE_S3_URL).toBeUndefined();
      expect(parsed.API_URL).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("omits every service named across multiple --exclude entries", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      const authId = serviceContainerIds("demo")[1]!;
      const storageId = serviceContainerIds("demo")[5]!;
      yield* status(flags({ exclude: [authId, storageId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.PUBLISHABLE_KEY).toBeUndefined();
      expect(parsed.STORAGE_S3_URL).toBeUndefined();
      expect(parsed.API_URL).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("merges an auto-detected stopped service with a --exclude entry (status.go:116)", () => {
    const { layer, out } = setup({
      goOutput: Option.some("json"),
      // kong (index 0) is absent from the running set, so it's auto-detected as stopped.
      route: defaultRoute({ runningNames: ALL_RUNNING_NAMES.slice(1) }),
    });
    return Effect.gen(function* () {
      const authId = serviceContainerIds("demo")[1]!;
      yield* status(flags({ exclude: [authId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.API_URL).toBeUndefined(); // excluded via the auto-detected stopped kong
      expect(parsed.PUBLISHABLE_KEY).toBeUndefined(); // excluded via --exclude
      expect(parsed.DB_URL).toBeDefined(); // db.url is set unconditionally, before any gating
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs yaml with -o yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stdoutText).toContain("API_URL:");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs toml with -o toml", () => {
    const { layer, out } = setup({ goOutput: Option.some("toml") });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stdoutText).toContain("API_URL =");
    }).pipe(Effect.provide(layer));
  });

  it.live("remaps an output key with --override-name api.url=NEXT_PUBLIC_SUPABASE_URL", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* status(flags({ overrideName: ["api.url=NEXT_PUBLIC_SUPABASE_URL"] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.API_URL).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on a malformed --override-name entry", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(status(flags({ overrideName: ["not-a-kv-pair"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("StatusOverrideParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("silently ignores an --override-name entry with an unknown field key", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* status(flags({ overrideName: ["not.a.real.field=NAME"] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NAME).toBeUndefined();
      expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
    }).pipe(Effect.provide(layer));
  });

  it.live("applies a valid --override-name entry alongside an unknown one", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* status(
        flags({ overrideName: ["not.a.real.field=NAME", "api.url=NEXT_PUBLIC_SUPABASE_URL"] }),
      );
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.NAME).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a machine result with --output-format json when -o is unset", () => {
    const { layer, out } = setup({ format: "json" });
    return Effect.gen(function* () {
      yield* status(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ API_URL: "http://127.0.0.1:54321" });
      expect(out.stdoutText).not.toContain("\x1b[?25l");
    }).pipe(Effect.provide(layer));
  });

  it.live("-o takes priority over --output-format when both are passed", () => {
    const { layer, out } = setup({ format: "json", goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* status(flags());
      // -o env wins: raw KEY="VALUE" text on stdout, not a structured success message.
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("lets --output pretty win over --output-format json", () => {
    // `-o pretty` is a complete format choice and must render the table, not defer to
    // --output-format.
    const { layer, out } = setup({ format: "json", goOutput: Option.some("pretty") });
    return Effect.gen(function* () {
      yield* status(flags());
      expect(out.stderrText).toContain("local development setup is running.");
      expect(out.stdoutText).toContain("🌐 APIs");
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("flushes telemetry via ensuring even on failure", () => {
    const { layer, telemetry } = setup({
      route: (args) =>
        args[0] === "container" && args[1] === "inspect" ? { exitCode: 1 } : { exitCode: 0 },
    });
    return Effect.gen(function* () {
      yield* Effect.exit(status(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("linked-state display (CLI-2167 follow-up)", () => {
    it.live(
      "not linked: prints Not linked. as the first stdout line, then normal status output",
      () => {
        const { layer, out } = setup();
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText.startsWith("Not linked.\n")).toBe(true);
          expect(out.stdoutText).toContain("🌐 APIs");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "linked to a real project: prints the Linked Project block (Org + Project) with zero Management API calls",
      () => {
        // A mock is wired here (unlike the "no layer at all" test below), so the empty
        // `requests` count is a genuine runtime assertion, not just "no layer" avoidance.
        const { layer, out, workdir, apiMock } = setup({ branches: { ok: [] } });
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, { name: "My Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n  Org: acme (org_1)\n  Project: My Project (${LINKED_PLAIN_REF})\n`,
            ),
          ).toBe(true);
          expect(apiMock?.requests).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with an api mock: prints the full block (Org + parent Project + resolved Branch) with a Checking linked branch... spinner",
      () => {
        const { layer, out, workdir } = setup({ branches: { ok: [LINKED_BRANCH] } });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: feature-x (${LINKED_BRANCH_REF})\n`,
            ),
          ).toBe(true);
          expect(out.progressEvents).toContainEqual({
            type: "start",
            message: "Checking linked branch...",
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with the production factory-fallback path (CommandPlatformApiFactory, not CommandPlatformApi directly): resolves the branch",
      () => {
        const { layer, out, workdir, apiFactoryMock } = setup({
          apiFactory: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: feature-x (${LINKED_BRANCH_REF})\n`,
            ),
          ).toBe(true);
          expect(apiFactoryMock?.requests).toEqual([
            { method: "listAllBranches", input: { ref: LINKED_PARENT_REF } },
          ]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "factory present but make() itself fails (e.g. no/invalid token): degrades the same as no API at all",
      () => {
        const { layer, out, workdir, apiFactoryMock } = setup({
          apiFactory: {
            makeFails: new AccessTokenRequiredError({ message: "no token" }),
          },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
          expect(apiFactoryMock?.requests).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with no Management API layer/factory at all: RICH degraded block (Org + parent Project + bare Branch ref), still succeeds",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          // The cache confirms a distinct parent, so org/name still show; only the branch's
          // own name is missing, rendered as a bare ref rather than silently collapsing to a
          // plain-project line.
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "resolves the linked ref from SUPABASE_PROJECT_ID (env) when no project-ref file exists",
      () => {
        const { layer, out, workdir } = setup({ projectId: Option.some(LINKED_PLAIN_REF) });
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, { name: "My Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n  Org: acme (org_1)\n  Project: My Project (${LINKED_PLAIN_REF})\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with no cache file at all and no API confirmation: no-false-claim rule renders the bare project line only",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(`Linked Project:\n  Project: ${LINKED_BRANCH_REF}\n`),
          ).toBe(true);
          // `startsWith` alone would still pass a wrongly-appended Branch:/Org: line —
          // assert their absence explicitly.
          expect(out.stdoutText).not.toContain("\n  Branch:");
          expect(out.stdoutText).not.toContain("\n  Org:");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "no-false-claim rule: no cache, an API IS available but finds no matching branch — still the bare project line, no Branch/parent claim",
      () => {
        // Distinct from the "no API at all" test above: here a lookup runs and returns
        // branches, none matching — finding nothing is not positive confirmation either.
        const { layer, out, workdir } = setup({
          branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(`Linked Project:\n  Project: ${LINKED_BRANCH_REF}\n`),
          ).toBe(true);
          // Same over-broad-assertion trap as above: a wrongly-appended
          // Branch:/Org: line would still satisfy a bare `startsWith` check.
          expect(out.stdoutText).not.toContain("\n  Branch:");
          expect(out.stdoutText).not.toContain("\n  Org:");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "no-false-claim rule, -o env: no matching branch found emits only LINKED_PROJECT_REF, no LINKED_BRANCH or LINKED_PARENT_PROJECT_REF",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("env"),
          branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain(`LINKED_PROJECT_REF="${LINKED_BRANCH_REF}"`);
          expect(out.stdoutText).not.toContain("LINKED_BRANCH");
          expect(out.stdoutText).not.toContain("LINKED_PARENT_PROJECT_REF");
          expect(out.stdoutText).not.toContain("LINKED_ORG_");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "linked ref is non-ref-shaped: treated as not linked, the file content never reaches output (PR #6168 review)",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, "not-a-real-ref!!");
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText.startsWith("Not linked.\n")).toBe(true);
          expect(out.stdoutText).not.toContain("not-a-real-ref!!");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o json: a symlink/garbage project-ref file's content never reaches machine output (PR #6168 review, token-exfiltration vector)",
      () => {
        // A malicious worktree can symlink `supabase/.temp/project-ref` at a real token file;
        // the pattern gate must keep non-ref-shaped content (e.g. a token) out of every
        // output channel.
        const { layer, out, workdir } = setup({ goOutput: Option.some("json") });
        writeProjectRefFile(workdir, "sbp_0102030405060708090a0b0c0d0e0f10111213");
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).not.toContain("sbp_");
          expect(out.stdoutText).not.toContain("LINKED_PROJECT_REF");
          expect(out.stdoutText).not.toContain("linked_project_ref");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "linked to a real project with no cached name: bare Project value, Org line still shown",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        // No `name` field in the cache — org fields are still known.
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n  Org: acme (org_1)\n  Project: ${LINKED_PLAIN_REF}\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "--output-format json, linked to a real (non-branch) project with no name: linked_project has project_ref + org fields but no project_name",
      () => {
        const { layer, out, workdir } = setup({ format: "json" });
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          const success = out.messages.find((m) => m.type === "success");
          const linkedProject = (success?.data as { linked_project?: Record<string, unknown> })
            ?.linked_project;
          expect(linkedProject).toEqual({
            project_ref: LINKED_PLAIN_REF,
            org_slug: "acme",
            org_id: "org_1",
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with no cache at all: plain project block, ZERO API calls (cache alone is never proof of a link, PR #6168 review)",
      () => {
        // A mock is wired here (self-referential branch) so the zero-requests assertion is a
        // genuine runtime count: with no `linked-project.json`, there is no parent to resolve,
        // so `resolveLinkedState` never attempts a lookup at all.
        const { layer, out, workdir, apiMock } = setup({
          branches: {
            ok: [{ ...LINKED_BRANCH, parent_project_ref: LINKED_BRANCH_REF }],
          },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(`Linked Project:\n  Project: ${LINKED_BRANCH_REF}\n`),
          ).toBe(true);
          expect(out.stdoutText).not.toContain("\n  Branch:");
          expect(out.stdoutText).not.toContain("\n  Org:");
          expect(apiMock?.requests).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with the branch lookup failing (status error): RICH degraded block, still succeeds",
      () => {
        const { layer, out, workdir } = setup({
          branches: { fail: statusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "branch-linked with the branch lookup failing (transport error): RICH degraded block, still succeeds",
      () => {
        const { layer, out, workdir } = setup({
          branches: { fail: transportFailureForMock() },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o env, branch-linked with the branch lookup failing: degraded machine payload still carries parent/name/org, only LINKED_BRANCH absent",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("env"),
          branches: { fail: statusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain(`LINKED_PROJECT_REF="${LINKED_BRANCH_REF}"`);
          expect(out.stdoutText).toContain(`LINKED_PARENT_PROJECT_REF="${LINKED_PARENT_REF}"`);
          expect(out.stdoutText).toContain('LINKED_PROJECT_NAME="Parent Project"');
          expect(out.stdoutText).toContain('LINKED_ORG_SLUG="acme"');
          expect(out.stdoutText).toContain('LINKED_ORG_ID="org_1"');
          expect(out.stdoutText).not.toContain("LINKED_BRANCH=");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o json, branch-linked with the branch lookup failing: degraded machine payload still carries parent/name/org, only linked_branch absent",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("json"),
          branches: { fail: statusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
          expect(parsed.linked_project_ref).toBe(LINKED_BRANCH_REF);
          expect(parsed.linked_parent_project_ref).toBe(LINKED_PARENT_REF);
          expect(parsed.linked_project_name).toBe("Parent Project");
          expect(parsed.linked_org_slug).toBe("acme");
          expect(parsed.linked_org_id).toBe("org_1");
          expect(parsed.linked_branch).toBeUndefined();
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "--output-format json, branch-linked with the branch lookup failing: structured linked_project still carries parent/name/org, no branch key",
      () => {
        const { layer, out, workdir } = setup({
          format: "json",
          branches: { fail: statusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          const success = out.messages.find((m) => m.type === "success");
          const linkedProject = (success?.data as { linked_project?: Record<string, unknown> })
            ?.linked_project;
          expect(linkedProject).toEqual({
            project_ref: LINKED_BRANCH_REF,
            parent_project_ref: LINKED_PARENT_REF,
            project_name: "Parent Project",
            org_slug: "acme",
            org_id: "org_1",
          });
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "failure preservation: a daemon connection failure still fails with its existing error, with the linked block already on stdout",
      () => {
        const { layer, out, workdir } = setup({
          failSpawnFor: () => true,
        });
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, { name: "My Project" });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(status(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("StatusDbInspectError");
          }
          expect(out.stdoutText).toBe(
            `Linked Project:\n  Org: acme (org_1)\n  Project: My Project (${LINKED_PLAIN_REF})\n`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    describe("env-override guard (PR #6168 review)", () => {
      // SUPABASE_PROJECT_ID (env) always wins before the project-ref file is ever read, so none
      // of these write a project-ref file — the cache below belongs to the workdir (project A),
      // not necessarily to whatever the env override points at (B).
      it.live(
        "SUPABASE_PROJECT_ID overriding an unrelated workdir's cache: no positive lookup match degrades to the plain project line, no parent claim on cache presence alone",
        () => {
          const { layer, out, workdir } = setup({
            projectId: Option.some(LINKED_BRANCH_REF),
            branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
          });
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags());
            expect(
              out.stdoutText.startsWith(`Linked Project:\n  Project: ${LINKED_BRANCH_REF}\n`),
            ).toBe(true);
            expect(out.stdoutText).not.toContain("\n  Branch:");
            expect(out.stdoutText).not.toContain("\n  Org:");
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "--output-format json, SUPABASE_PROJECT_ID override with no positive match: linked_project has only project_ref, no parent/org fields leaking from the unrelated cache",
        () => {
          const { layer, out, workdir } = setup({
            format: "json",
            projectId: Option.some(LINKED_BRANCH_REF),
            branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
          });
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags());
            const success = out.messages.find((m) => m.type === "success");
            const linkedProject = (success?.data as { linked_project?: Record<string, unknown> })
              ?.linked_project;
            expect(linkedProject).toEqual({ project_ref: LINKED_BRANCH_REF });
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "SUPABASE_PROJECT_ID pointing at a real branch of the cached parent: the lookup's POSITIVE confirmation still renders the full branch block (env-override CI workflow)",
        () => {
          const { layer, out, workdir } = setup({
            projectId: Option.some(LINKED_BRANCH_REF),
            branches: { ok: [LINKED_BRANCH] },
          });
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags());
            expect(
              out.stdoutText.startsWith(
                `Linked Project:\n` +
                  `  Org: acme (org_1)\n` +
                  `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                  `  Branch: feature-x (${LINKED_BRANCH_REF})\n`,
              ),
            ).toBe(true);
          }).pipe(Effect.provide(layer));
        },
      );
    });

    it.live(
      "a branch lookup that never resolves times out and degrades to the RICH block (real 5s wait — BRANCH_LOOKUP_TIMEOUT is an exported constant in branch-target.ts, but its VALUE isn't overridable without changing the source; accepted as a real-time test for this one scenario, PR #6168 review)",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        const neverApi = mockCommandPlatformApiService({
          v1: { listAllBranches: () => Effect.never },
        });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
        }).pipe(Effect.provide(Layer.mergeAll(layer, neverApi.layer)));
      },
      10_000,
    );

    it.live(
      "a control-char/ANSI-laden project-ref file is treated as not linked; nothing of it reaches stdout (PR #6168 review)",
      () => {
        // The pattern gate in `resolveSoftLinkedRef` rejects any non-ref-shaped content
        // outright, closing the symlink-to-secret exfiltration vector; sanitization is
        // defense-in-depth behind it.
        const DIRTY_REF = "\x1b[31mmalicious\x1b[0m";
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, DIRTY_REF);
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText.startsWith("Not linked.\n")).toBe(true);
          expect(out.stdoutText).not.toContain("\x1b");
          expect(out.stdoutText).not.toContain("malicious");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o json, --override-name collides with the linked_project_ref field name: the overridden base value wins, the linked field never clobbers it (PR #6168 review)",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("json"),
          branches: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags({ overrideName: ["api.url=linked_project_ref"] }));
          const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
          // `values` spreads last over `linkedStateGoFields`, so the API URL, not the branch
          // ref, ends up under this key.
          expect(parsed.linked_project_ref).toBe("http://127.0.0.1:54321");
          expect(parsed.API_URL).toBeUndefined();
        }).pipe(Effect.provide(layer));
      },
    );

    describe("org line variants", () => {
      it.live(
        "slug and id differ: renders `<slug> (<id>)` (Colum's default real-world state)",
        () => {
          const { layer, out, workdir } = setup();
          writeProjectRefFile(workdir, LINKED_PLAIN_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
            name: "My Project",
            orgSlug: "acme",
            orgId: "org_1",
          });
          return Effect.gen(function* () {
            yield* status(flags());
            expect(out.stdoutText).toContain("  Org: acme (org_1)\n");
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "slug === id: renders the bare value once (Colum's real staging state), machine formats still carry both keys",
        () => {
          const { layer, out, workdir } = setup({
            goOutput: Option.some("env"),
          });
          writeProjectRefFile(workdir, LINKED_PLAIN_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
            name: "My Project",
            orgSlug: "sameorg",
            orgId: "sameorg",
          });
          return Effect.gen(function* () {
            yield* status(flags());
            expect(out.stdoutText).toContain('LINKED_ORG_SLUG="sameorg"');
            expect(out.stdoutText).toContain('LINKED_ORG_ID="sameorg"');
          }).pipe(Effect.provide(layer));
        },
      );

      it.live("slug === id, text mode: renders the bare value once, not duplicated", () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
          name: "My Project",
          orgSlug: "sameorg",
          orgId: "sameorg",
        });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain("  Org: sameorg\n");
          expect(out.stdoutText).not.toContain("sameorg (sameorg)");
        }).pipe(Effect.provide(layer));
      });

      it.live(
        "neither slug nor id known: the Org line is omitted entirely, and no org machine keys appear",
        () => {
          const { layer, out, workdir } = setup({ goOutput: Option.some("env") });
          writeProjectRefFile(workdir, LINKED_PLAIN_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
            name: "My Project",
            orgSlug: null,
            orgId: null,
          });
          return Effect.gen(function* () {
            yield* status(flags());
            expect(out.stdoutText).not.toContain("LINKED_ORG_");
            expect(out.stdoutText).toContain(`LINKED_PROJECT_REF="${LINKED_PLAIN_REF}"`);
            expect(out.stdoutText).toContain('LINKED_PROJECT_NAME="My Project"');
          }).pipe(Effect.provide(layer));
        },
      );

      it.live("neither slug nor id known, text mode: the Org line is omitted entirely", () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
          name: "My Project",
          orgSlug: null,
          orgId: null,
        });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n  Project: My Project (${LINKED_PLAIN_REF})\n`,
            ),
          ).toBe(true);
          expect(out.stdoutText).not.toContain("Org:");
        }).pipe(Effect.provide(layer));
      });

      it.live("only the org slug is known (no id): renders the bare slug value", () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
          name: "My Project",
          orgSlug: "acme",
          orgId: null,
        });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain("  Org: acme\n");
        }).pipe(Effect.provide(layer));
      });

      it.live("only the org id is known (no slug): renders the bare id value", () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
          name: "My Project",
          orgSlug: null,
          orgId: "org_1",
        });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain("  Org: org_1\n");
        }).pipe(Effect.provide(layer));
      });

      it.live(
        "--output-format json, neither org field known: linked_project omits org_slug and org_id",
        () => {
          const { layer, out, workdir } = setup({ format: "json" });
          writeProjectRefFile(workdir, LINKED_PLAIN_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, {
            name: "My Project",
            orgSlug: null,
            orgId: null,
          });
          return Effect.gen(function* () {
            yield* status(flags());
            const success = out.messages.find((m) => m.type === "success");
            const linkedProject = (success?.data as { linked_project?: Record<string, unknown> })
              ?.linked_project;
            expect(linkedProject).toEqual({
              project_ref: LINKED_PLAIN_REF,
              project_name: "My Project",
            });
          }).pipe(Effect.provide(layer));
        },
      );
    });

    it.live("-o env, branch-linked: emits the six LINKED_ keys alongside the existing keys", () => {
      const { layer, out, workdir } = setup({
        goOutput: Option.some("env"),
        branches: { ok: [LINKED_BRANCH] },
      });
      writeProjectRefFile(workdir, LINKED_BRANCH_REF);
      writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
      return Effect.gen(function* () {
        yield* status(flags());
        expect(out.stdoutText).toContain(`LINKED_PROJECT_REF="${LINKED_BRANCH_REF}"`);
        expect(out.stdoutText).toContain('LINKED_BRANCH="feature-x"');
        expect(out.stdoutText).toContain(`LINKED_PARENT_PROJECT_REF="${LINKED_PARENT_REF}"`);
        expect(out.stdoutText).toContain('LINKED_PROJECT_NAME="Parent Project"');
        expect(out.stdoutText).toContain('LINKED_ORG_SLUG="acme"');
        expect(out.stdoutText).toContain('LINKED_ORG_ID="org_1"');
        expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      }).pipe(Effect.provide(layer));
    });

    it.live("-o env, not linked: emits no LINKED_ key at all", () => {
      const { layer, out } = setup({ goOutput: Option.some("env") });
      return Effect.gen(function* () {
        yield* status(flags());
        expect(out.stdoutText).not.toContain("LINKED_");
        expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "-o json, branch-linked: includes the six linked_ keys alongside the existing keys",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("json"),
          branches: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
          expect(parsed.linked_project_ref).toBe(LINKED_BRANCH_REF);
          expect(parsed.linked_branch).toBe("feature-x");
          expect(parsed.linked_parent_project_ref).toBe(LINKED_PARENT_REF);
          expect(parsed.linked_project_name).toBe("Parent Project");
          expect(parsed.linked_org_slug).toBe("acme");
          expect(parsed.linked_org_id).toBe("org_1");
          expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("-o json, not linked: omits every linked_ key", () => {
      const { layer, out } = setup({ goOutput: Option.some("json") });
      return Effect.gen(function* () {
        yield* status(flags());
        const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
        expect(parsed.linked_project_ref).toBeUndefined();
        expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
      }).pipe(Effect.provide(layer));
    });

    it.live(
      "-o yaml, branch-linked: includes linked_project_ref and linked_org_slug (smoke)",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("yaml"),
          branches: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain(`linked_project_ref: ${LINKED_BRANCH_REF}`);
          expect(out.stdoutText).toContain("linked_org_slug: acme");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o toml, branch-linked: includes linked_project_ref and linked_org_slug (smoke)",
      () => {
        const { layer, out, workdir } = setup({
          goOutput: Option.some("toml"),
          branches: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          expect(out.stdoutText).toContain(`linked_project_ref = "${LINKED_BRANCH_REF}"`);
          expect(out.stdoutText).toContain('linked_org_slug = "acme"');
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "--output-format json, branch-linked: nests linked_project (with org) with zero progress events",
      () => {
        const { layer, out, workdir } = setup({
          format: "json",
          branches: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* status(flags());
          const success = out.messages.find((m) => m.type === "success");
          expect(success?.data).toMatchObject({
            linked_project: {
              project_ref: LINKED_BRANCH_REF,
              branch: "feature-x",
              parent_project_ref: LINKED_PARENT_REF,
              project_name: "Parent Project",
              org_slug: "acme",
              org_id: "org_1",
            },
          });
          expect(out.progressEvents).toEqual([]);
        }).pipe(Effect.provide(layer));
      },
    );

    it.live("--output-format json, not linked: linked_project is null", () => {
      const { layer, out } = setup({ format: "json" });
      return Effect.gen(function* () {
        yield* status(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({ linked_project: null });
      }).pipe(Effect.provide(layer));
    });

    it.live("--output-format stream-json, branch-linked: nests linked_project (smoke)", () => {
      const { layer, out, workdir } = setup({
        format: "stream-json",
        branches: { ok: [LINKED_BRANCH] },
      });
      writeProjectRefFile(workdir, LINKED_BRANCH_REF);
      writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
      return Effect.gen(function* () {
        yield* status(flags());
        const success = out.messages.find((m) => m.type === "success");
        expect(success?.data).toMatchObject({
          linked_project: { project_ref: LINKED_BRANCH_REF },
        });
      }).pipe(Effect.provide(layer));
    });

    describe("json/stream-json FAILURE envelope carries linked_project (CLI-2167 follow-up)", () => {
      it.live(
        "--output-format json, branch-linked, daemon connection failure: envelope carries the full linked_project at the top level, error untouched",
        () => {
          const { layer, workdir, stdio, processControl } = setupFailureEnvelope({
            format: "json",
            branches: { ok: [LINKED_BRANCH] },
          });
          writeProjectRefFile(workdir, LINKED_BRANCH_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope._tag).toBe("Error");
            expect(envelope.error.code).toBe("StatusDbInspectError");
            expect(envelope.linked_project).toEqual({
              project_ref: LINKED_BRANCH_REF,
              branch: "feature-x",
              parent_project_ref: LINKED_PARENT_REF,
              project_name: "Parent Project",
              org_slug: "acme",
              org_id: "org_1",
            });
            expect(Object.keys(envelope).sort()).toEqual(["_tag", "error", "linked_project"]);
            expect(processControl.exitCode).toBe(1);
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "--output-format json, degraded branch-linked (no Management API layer at all), daemon connection failure: linked_project present without a branch key",
        () => {
          const { layer, workdir, stdio } = setupFailureEnvelope({ format: "json" });
          writeProjectRefFile(workdir, LINKED_BRANCH_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags()).pipe(withJsonErrorHandling);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope.error.code).toBe("StatusDbInspectError");
            expect(envelope.linked_project).toEqual({
              project_ref: LINKED_BRANCH_REF,
              parent_project_ref: LINKED_PARENT_REF,
              project_name: "Parent Project",
              org_slug: "acme",
              org_id: "org_1",
            });
            expect("branch" in envelope.linked_project).toBe(false);
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "--output-format json, not linked, daemon connection failure: linked_project is explicitly null, not absent",
        () => {
          const { layer, stdio } = setupFailureEnvelope({ format: "json" });
          return Effect.gen(function* () {
            yield* status(flags()).pipe(withJsonErrorHandling);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope.error.code).toBe("StatusDbInspectError");
            expect("linked_project" in envelope).toBe(true);
            expect(envelope.linked_project).toBeNull();
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "--output-format stream-json, branch-linked, daemon connection failure: the terminal error event carries linked_project",
        () => {
          const { layer, workdir, stdio } = setupFailureEnvelope({
            format: "stream-json",
            branches: { ok: [LINKED_BRANCH] },
          });
          writeProjectRefFile(workdir, LINKED_BRANCH_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const event = JSON.parse(stdio.stdout[0]!);
            expect(event.type).toBe("error");
            expect(event.error.code).toBe("StatusDbInspectError");
            expect(event.linked_project).toEqual({
              project_ref: LINKED_BRANCH_REF,
              branch: "feature-x",
              parent_project_ref: LINKED_PARENT_REF,
              project_name: "Parent Project",
              org_slug: "acme",
              org_id: "org_1",
            });
            expect(Object.keys(event).sort()).toEqual([
              "error",
              "linked_project",
              "timestamp",
              "type",
            ]);
          }).pipe(Effect.provide(layer));
        },
      );

      it.live(
        "inertness guard: without machineErrorContextLayer in scope, the envelope has no linked_project key at all, and the command still fails identically",
        () => {
          // Omitting the cell from the layer graph must silently skip both the handler's
          // `Effect.serviceOption(MachineErrorContext)` write and the output layer's read.
          const { layer, workdir, stdio, processControl } = setupFailureEnvelope({
            format: "json",
            branches: { ok: [LINKED_BRANCH] },
            withMachineErrorContext: false,
          });
          writeProjectRefFile(workdir, LINKED_BRANCH_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* status(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope).toEqual({
              _tag: "Error",
              error: {
                code: "StatusDbInspectError",
                message: expect.stringContaining("command not found"),
              },
            });
            expect("linked_project" in envelope).toBe(false);
            expect(processControl.exitCode).toBe(1);
          }).pipe(Effect.provide(layer));
        },
      );
    });
  });
});
