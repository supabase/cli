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

import { mockOutput, mockProcessControl } from "../../../../tests/helpers/mocks.ts";
import {
  legacyStatusCodeFailure,
  legacyTransportFailure,
  mockLegacyCliSettings,
  mockLegacyPlatformApiService,
  mockLegacyTelemetryStateTracked,
  useLegacyTempWorkdir,
} from "../../../../tests/helpers/legacy-mocks.ts";
import type { LegacyPlatformApiFactoryError } from "../../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformApiFactory } from "../../auth/legacy-platform-api-factory.service.ts";
import { LegacyPlatformAuthRequiredError } from "../../auth/legacy-errors.ts";
import { LegacyOutputFlag } from "../../../shared/legacy/global-flags.ts";
import { withJsonErrorHandling } from "../../../shared/output/json-error-handling.ts";
import { machineErrorContextLayer } from "../../../shared/output/machine-error-context.layer.ts";
import { jsonOutputLayer, streamJsonOutputLayer } from "../../../shared/output/output.layer.ts";
import { legacyServiceContainerIds, localDbContainerId } from "../../shared/legacy-docker-ids.ts";
import type { LegacyStatusFlags } from "./status.command.ts";
import { legacyStatus } from "./status.handler.ts";

type LinkedStateBranches = typeof V1ListAllBranchesOutput.Type;
type LinkedStateBranch = LinkedStateBranches[number];

const tempRoot = useLegacyTempWorkdir("supabase-status-int-");

afterEach(() => {
  delete process.env["SUPABASE_AUTH_JWT_SECRET"];
});

function flags(overrides: Partial<LegacyStatusFlags> = {}): LegacyStatusFlags {
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

// ---------------------------------------------------------------------------
// Linked-state fixtures (CLI-2167 follow-up: `status` shows the linked
// project/branch in every output mode). Distinct 20-lowercase-letter refs so
// it's unambiguous which candidate (branch vs. parent) a given assertion
// targets.
// ---------------------------------------------------------------------------

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

function legacyTransportFailureForMock() {
  return legacyTransportFailure(HttpClientRequestModule.get("https://api.supabase.com/mock"));
}

/**
 * Wires `LegacyPlatformApiFactory` directly (`make` resolves immediately to a
 * stubbed client) — NOT `LegacyPlatformApi`. Pins the actual production
 * acquisition path `legacyAcquireLinkedStateApi` falls back to when only the
 * lazy factory is in scope (`status`'s real runtime shape, via
 * `legacyPlatformApiFactoryLayer` in `status.command.ts`), as opposed to the
 * direct-service `branches` mock above, which existing tests provide and which
 * a real `status` invocation never has.
 */
function mockLegacyPlatformApiFactoryDirect(opts: {
  readonly ok?: LinkedStateBranches;
  readonly fail?: unknown;
  /** When set, `factory.make` itself fails (e.g. no/invalid token) before any
   * `v1` call is ever attempted — distinct from `fail`, which lets `make`
   * succeed and fails the `listAllBranches` call instead. */
  readonly makeFails?: LegacyPlatformApiFactoryError;
}) {
  const requests: Array<{ method: string; input: unknown }> = [];
  const v1Proxy = new Proxy({} as ApiClient["v1"], {
    get(_target, prop: string) {
      return (input: unknown) =>
        Effect.gen(function* () {
          requests.push({ method: prop, input });
          if (prop !== "listAllBranches") {
            return yield* Effect.die(`Unmocked factory-backed LegacyPlatformApi.v1.${prop}`);
          }
          if (opts.fail !== undefined) return yield* Effect.fail(opts.fail);
          return opts.ok ?? [];
        });
    },
  });
  const v2Proxy = new Proxy({} as ApiClient["v2"], {
    get(_target, prop: string) {
      return () => Effect.die(`Unmocked factory-backed LegacyPlatformApi.v2.${prop}`);
    },
  });
  const client = {
    v1: v1Proxy,
    v2: v2Proxy,
    executeRaw: () => Effect.die("Unmocked executeRaw"),
  } as ApiClient;
  const make = opts.makeFails !== undefined ? Effect.fail(opts.makeFails) : Effect.succeed(client);
  const layer = Layer.succeed(LegacyPlatformApiFactory, { make });
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

const ALL_RUNNING_NAMES = legacyServiceContainerIds("demo");
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
   * When set, wires a `LegacyPlatformApi` layer stubbing `listAllBranches` for
   * `legacyResolveLinkedState`'s branch lookup (CLI-2167 follow-up). Omitted
   * entirely by default — matching `status`'s real runtime, which never wires
   * a Management API layer at all — so `Effect.serviceOption(LegacyPlatformApi)`
   * resolves to `None` unless a test opts in here.
   */
  readonly branches?: { readonly ok?: LinkedStateBranches; readonly fail?: unknown };
  /**
   * When set INSTEAD of `branches`, wires only `LegacyPlatformApiFactory`
   * (never `LegacyPlatformApi` directly) — the shape `status`'s real runtime
   * actually provides. Pins `legacyAcquireLinkedStateApi`'s factory-fallback
   * path (CLI-2167 follow-up bug fix).
   */
  readonly apiFactory?: {
    readonly ok?: LinkedStateBranches;
    readonly fail?: unknown;
    readonly makeFails?: LegacyPlatformApiFactoryError;
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
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliSettings = mockLegacyCliSettings({
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
      : mockLegacyPlatformApiService({
          v1: {
            listAllBranches:
              opts.branches.fail !== undefined
                ? () => Effect.fail(opts.branches?.fail)
                : () => Effect.succeed(opts.branches?.ok ?? []),
          },
        });
  const apiFactoryMock =
    opts.apiFactory === undefined ? undefined : mockLegacyPlatformApiFactoryDirect(opts.apiFactory);

  const layer = Layer.mergeAll(
    BunServices.layer,
    out.layer,
    cliSettings,
    telemetry.layer,
    child.layer,
    Layer.succeed(LegacyOutputFlag, opts.goOutput ?? Option.none()),
    ...(apiMock === undefined ? [] : [apiMock.layer]),
    ...(apiFactoryMock === undefined ? [] : [apiFactoryMock.layer]),
  );

  return { workdir, out, telemetry, child, layer, apiMock, apiFactoryMock };
}

/**
 * A REAL captured `Stdio` layer (mirrors `output.layer.unit.test.ts`'s local
 * `mockStdio()`) — needed only by the failure-envelope tests below, since the
 * `MachineErrorContext` merge they pin lives inside the real
 * `jsonOutputLayer`/`streamJsonOutputLayer` `fail` implementations, which
 * `setup()`'s `mockOutput()` fake never replicates.
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
 * Dedicated setup for the json/stream-json FAILURE-envelope tests (CLI-2167
 * follow-up): wires the REAL `jsonOutputLayer`/`streamJsonOutputLayer` over a
 * captured `Stdio`, a real `mockProcessControl()` (failure in these formats
 * signals via exit code, not `Effect.fail` — see `withJsonErrorHandling`),
 * and — merged ALONGSIDE the output layer, not nested inside its own
 * `Layer.provide`, matching how `status.command.ts` composes
 * `legacyStatusRuntimeLayer` — `machineErrorContextLayer`, so the SAME live
 * cell both the handler (`legacyStatus`) and the output layer's `fail` see is
 * one instance. Every scenario forces a daemon-connection failure
 * (`failSpawnFor: () => true`, the same "docker and podman both missing"
 * mechanism as the existing text-mode daemon-failure test) so the command
 * fails with `LegacyStatusDbInspectError` after the linked-state block has
 * already resolved.
 */
function setupFailureEnvelope(opts: FailureEnvelopeOpts) {
  const workdir = tempRoot.current;
  writeConfig(workdir);
  const stdio = mockCapturingStdio();
  const telemetry = mockLegacyTelemetryStateTracked();
  const cliSettings = mockLegacyCliSettings({ workdir, projectId: Option.none() });
  const child = mockRoutedContainerCliSpawner(defaultRoute(), { failSpawnFor: () => true });
  const processControl = mockProcessControl();
  const apiMock =
    opts.branches === undefined
      ? undefined
      : mockLegacyPlatformApiService({
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
    Layer.succeed(LegacyOutputFlag, Option.none()),
    ...(opts.withMachineErrorContext === false ? [] : [machineErrorContextLayer]),
    ...(apiMock === undefined ? [] : [apiMock.layer]),
  );

  return { workdir, layer, stdio, processControl };
}

describe("legacy status integration", () => {
  it.live("shows the running stack as a pretty table", () => {
    const { layer, out } = setup();
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
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
      // Config validation rewrites the resolved project id to its sanitized form once
      // at config-load time; every later reader —
      // including the Docker label `start` writes — sees that same sanitized
      // string. Filtering/inspecting with the raw value here would target
      // containers `start` never created.
      const { layer, child } = setup({ configContents: 'project_id = "My App!!"\n' });
      return Effect.gen(function* () {
        yield* legacyStatus(flags());
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
      yield* legacyStatus(flags({ ignoreHealthCheck: true }));
      expect(child.spawned.some((s) => s.args[0] === "container" && s.args[1] === "inspect")).toBe(
        false,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "succeeds against an unhealthy db when --ignore-health-check is set (status.go:104-108)",
    () => {
      // Pairs with "fails when the db container is unhealthy" below (ignoreHealthCheck: false,
      // the default) to cover both sides of the `if !ignoreHealthCheck { assertContainerHealthy }` gate.
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
        yield* legacyStatus(flags({ ignoreHealthCheck: true }));
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
      yield* legacyStatus(flags());
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when [remotes.*] has a duplicate project_id, even with no projectRef", () => {
    // The duplicate-project_id check runs unconditionally
    // on every config load, inside the same loop that resolves the [remotes.*]
    // override — it is not gated on a caller actually selecting a remote.
    // `status` never binds a --project-ref flag, so it must still fail on a
    // config-wide duplicate, before ever reaching Docker.
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusConfigLoadError");
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusConfigLoadError");
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "decodes a comma-separated string into an array field ([]string) for status to proceed",
    () => {
      // The decode hook splits a plain string literal
      // into a []string for a []string field like additional_redirect_urls —
      // this only runs when goViperCompat is on. Pin that status still proceeds
      // past config load (and on to a successful Docker inspect/list) rather
      // than treating the string literal as a decode error.
      const { layer } = setup({
        configContents:
          'project_id = "demo"\n[auth]\nadditional_redirect_urls = "http://a,http://b"\n',
      });
      return Effect.gen(function* () {
        yield* legacyStatus(flags());
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("warns on stderr for a deprecated auth.external provider", () => {
    // External-provider validation disables a bare
    // [auth.external.slack] block and warns — mirrored by
    // `normalizeDeprecatedExternalProviders` in packages/config's io.ts, gated
    // on `goViperCompat` (confirmed already wired in status.handler.ts). The
    // WARN goes out via Effect's `Console.error`, not this file's `Output`
    // service, so it must be observed with a raw console.error spy — same
    // idiom as packages/config/src/io.unit.test.ts's deprecated-provider tests.
    const { layer } = setup({
      configContents: 'project_id = "demo"\n[auth.external.slack]\nenabled = true\n',
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('WARN: disabling deprecated "slack" provider'),
      );
    }).pipe(Effect.provide(layer), Effect.ensuring(Effect.sync(() => errorSpy.mockRestore())));
  });

  it.live("fails when --workdir/SUPABASE_WORKDIR points at a missing path", () => {
    // The explicit workdir is `chdir`'d into before config
    // load or any Docker call — a missing path must fail immediately, not
    // fall through to the workdir-basename default and inspect Docker.
    const missingWorkdir = join(tempRoot.current, "does-not-exist");
    const { layer, child } = setup({ workdir: missingWorkdir, skipConfig: true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusWorkdirError");
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusWorkdirError");
        expect(JSON.stringify(exit.cause)).toContain(
          `failed to change workdir: chdir ${filePath}: not a directory`,
        );
      }
      expect(child.spawned).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when auth.jwt_secret is configured but shorter than 16 characters", () => {
    // Config validation rejects this at config-load time, entirely before the
    // health check/
    // container listing — so no Docker
    // call happens, same as the malformed config.toml case above.
    const { layer, child } = setup({
      configContents: 'project_id = "demo"\n[auth]\njwt_secret = "too-short"\n',
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusInvalidConfigError");
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
      yield* legacyStatus(flags());
      expect(child.spawned.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_AUTH_JWT_SECRET over a config.toml value with -o env", () => {
    // Env vars resolve with higher precedence than config.toml —
    // a stack started with this env var set
    // must report the env-derived secret, not the one in config.toml.
    const { layer, out } = setup({
      goOutput: Option.some("env"),
      configContents: `project_id = "demo"\n[auth]\njwt_secret = "${"a".repeat(32)}"\n`,
    });
    process.env["SUPABASE_AUTH_JWT_SECRET"] = "b".repeat(32);
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain(`JWT_SECRET="${"b".repeat(32)}"`);
      expect(out.stdoutText).not.toContain("a".repeat(32));
    }).pipe(Effect.provide(layer));
  });

  it.live("signs anon/service_role keys asymmetrically when signing_keys_path is set", () => {
    // JWT generation signs with the first key in auth.signing_keys_path
    // (RS256/ES256) instead of HMAC when that file resolves to a non-empty JWK
    // array.
    const { layer, out, workdir } = setup({
      goOutput: Option.some("json"),
      configContents: 'project_id = "demo"\n[auth]\nsigning_keys_path = "signing_keys.json"\n',
    });
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...privateKey.export({ format: "jwk" }), alg: "RS256", kid: "test-kid" };
    writeFileSync(join(workdir, "supabase", "signing_keys.json"), JSON.stringify([jwk]));
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      const [headerSegment] = parsed.ANON_KEY?.split(".") ?? [];
      const header = JSON.parse(Buffer.from(headerSegment ?? "", "base64url").toString());
      expect(header).toEqual({ alg: "RS256", kid: "test-kid", typ: "JWT" });
    }).pipe(Effect.provide(layer));
  });

  it.live("reports status using schema defaults when config.toml is missing entirely", () => {
    // Config loading treats a missing file as a no-op, not an error —
    // `status` proceeds
    // using template defaults. Only a malformed file is a hard failure (see
    // the sibling "malformed" test above).
    //
    // Without config.toml, the resolved project id falls back to the workdir
    // basename (not the module-level `ALL_RUNNING_NAMES`, which is fixed to
    // "demo") — route `ps` off that so the expected services actually show as
    // running rather than all appearing "stopped" and excluded.
    const projectId = basename(tempRoot.current);
    const { layer, out } = setup({
      skipConfig: true,
      route: defaultRoute({ runningNames: legacyServiceContainerIds(projectId) }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stderrText).toContain("local development setup is running.");
      expect(out.stdoutText).toContain("Project URL");
      expect(out.stdoutText).toContain("Database");
    }).pipe(Effect.provide(layer));
  });

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env over config.toml", () => {
    // Config loading loads the nested env (supabase/.env(.local))
    // before reading SUPABASE_PROJECT_ID from the resolved environment —
    // an env-file-only value overrides
    // config.toml's project_id too, not just an ambient shell export.
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=env-file-project\n");
    const { layer, child } = setup({
      configContents: 'project_id = "toml-project"\n',
      route: defaultRoute({ runningNames: legacyServiceContainerIds("env-file-project") }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
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
      route: defaultRoute({ runningNames: legacyServiceContainerIds("ambient-project") }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
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
    // The nested env load walks past supabase/ one more level, to the project
    // root/workdir — a project-root-only
    // dotenv value must override config.toml too, not just supabase/.env.
    writeFileSync(join(tempRoot.current, ".env"), "SUPABASE_PROJECT_ID=root-env-project\n");
    const { layer, child } = setup({
      configContents: 'project_id = "toml-project"\n',
      route: defaultRoute({ runningNames: legacyServiceContainerIds("root-env-project") }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("root-env-project"));
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "does not climb to an ancestor project's config.toml when workdir has none of its own",
    () => {
      // The resolved workdir is used exactly, with no
      // ancestor search — mirrored
      // here by `search: false`. A workdir with no supabase/config.toml of its
      // own must fall back to defaults (workdir-basename project id), not an
      // ancestor project's config.toml, even though `cliSettings.workdir` sits
      // right inside one.
      const nestedWorkdir = join(tempRoot.current, "nested");
      mkdirSync(nestedWorkdir, { recursive: true });
      writeConfig(tempRoot.current, 'project_id = "ancestor-project"\n');
      const projectId = basename(nestedWorkdir);
      const { layer, child } = setup({
        workdir: nestedWorkdir,
        skipConfig: true,
        route: defaultRoute({ runningNames: legacyServiceContainerIds(projectId) }),
      });
      return Effect.gen(function* () {
        yield* legacyStatus(flags());
        const inspectCall = child.spawned.find(
          (s) => s.args[0] === "container" && s.args[1] === "inspect",
        );
        expect(inspectCall?.args).toContain(localDbContainerId(projectId));
        expect(inspectCall?.args).not.toContain(localDbContainerId("ancestor-project"));
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("resolves SUPABASE_PROJECT_ID from supabase/.env even when config.toml is absent", () => {
    // The nested env load runs unconditionally, before config.toml is ever
    // opened — a supabase/.env-only project id
    // must still be honored even when there's no config.toml to fall back to
    // template defaults from.
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), "SUPABASE_PROJECT_ID=no-config-project\n");
    const { layer, child } = setup({
      skipConfig: true,
      route: defaultRoute({ runningNames: legacyServiceContainerIds("no-config-project") }),
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const inspectCall = child.spawned.find(
        (s) => s.args[0] === "container" && s.args[1] === "inspect",
      );
      expect(inspectCall?.args).toContain(localDbContainerId("no-config-project"));
    }).pipe(Effect.provide(layer));
  });

  it.live("honors SUPABASE_AUTH_JWT_SECRET from supabase/.env, not just the ambient shell", () => {
    // Config loading loads the nested env (supabase/.env(.local))
    // before reading SUPABASE_AUTH_JWT_SECRET from the resolved environment —
    // a dotenv-file-only value must be visible here too, not just an ambient
    // shell export (see the sibling "-o env" ambient test above).
    const supabaseDir = join(tempRoot.current, "supabase");
    mkdirSync(supabaseDir, { recursive: true });
    writeFileSync(join(supabaseDir, ".env"), `SUPABASE_AUTH_JWT_SECRET=${"c".repeat(32)}\n`);
    const { layer, out } = setup({
      goOutput: Option.some("env"),
      configContents: `project_id = "demo"\n[auth]\njwt_secret = "${"a".repeat(32)}"\n`,
    });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain(`JWT_SECRET="${"c".repeat(32)}"`);
      expect(out.stdoutText).not.toContain("a".repeat(32));
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when both docker and podman are missing", () => {
    // Neither container runtime can be spawned at all — distinct from a spawned
    // process exiting non-zero (covered by the malformed/unhealthy scenarios
    // above).
    const { layer } = setup({ failSpawnFor: () => true });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("falls back to podman when docker is absent", () => {
    const { layer, child } = setup({ dockerMissing: true });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      // The failed `docker` attempt is recorded before the `podman` fallback fires
      // (`spawnContainerCli`'s `Effect.catch` retries the same argv), so the last
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusListError");
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const serialized = JSON.stringify(exit.cause);
        expect(serialized).toContain("LegacyStatusDbNotRunningError");
        expect(serialized).toContain(localDbContainerId("demo"));
      }
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "succeeds against a paused-but-healthy db, matching Go's boolean-based running gate",
    () => {
      // The health check gates on the boolean
      // `resp.State.Running`, not the status string — a paused container can
      // report `Running: true` alongside `Status: "paused"`, and the handler continues
      // past the not-running branch to the health check in that case.
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
        yield* legacyStatus(flags());
      }).pipe(Effect.provide(layer));
    },
  );

  it.live("fails when the db container is absent, preserving the real Docker stderr text", () => {
    // The health check never special-cases "not found" — it wraps
    // whatever the inspect call returns, so the real
    // Docker stderr must flow through rather than a hardcoded TS string.
    const { layer } = setup({
      route: defaultRoute({
        dbInspectExitCode: 1,
        dbInspectStderr: ["Error response from daemon: No such container: x"],
      }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const serialized = JSON.stringify(exit.cause);
        expect(serialized).toContain("LegacyStatusDbInspectError");
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
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbNotReadyError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails when db inspect errors for a reason other than not-found", () => {
    const { layer } = setup({
      route: defaultRoute({ dbInspectExitCode: 1, dbInspectStderr: ["permission denied"] }),
    });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags()));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs env vars with -o env", () => {
    const { layer, out } = setup({ goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.stdoutText).toContain("DB_URL=");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs a json object with -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.DB_URL).toContain("postgresql://postgres:postgres@");
    }).pipe(Effect.provide(layer));
  });

  it.live("omits excluded services from -o json", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      const storageId = legacyServiceContainerIds("demo")[5]!;
      yield* legacyStatus(flags({ exclude: [storageId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.STORAGE_S3_URL).toBeUndefined();
      expect(parsed.API_URL).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("omits every service named across multiple --exclude entries", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      const authId = legacyServiceContainerIds("demo")[1]!;
      const storageId = legacyServiceContainerIds("demo")[5]!;
      yield* legacyStatus(flags({ exclude: [authId, storageId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.PUBLISHABLE_KEY).toBeUndefined();
      expect(parsed.STORAGE_S3_URL).toBeUndefined();
      expect(parsed.API_URL).toBeDefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("merges an auto-detected stopped service with a --exclude entry (status.go:116)", () => {
    // The exclusion list merges the health-derived
    // stopped list with the user-supplied --exclude list — both must take effect
    // together, not just whichever one the command would have applied alone.
    const { layer, out } = setup({
      goOutput: Option.some("json"),
      // kong (index 0) is absent from the running set, so it's auto-detected as stopped.
      route: defaultRoute({ runningNames: ALL_RUNNING_NAMES.slice(1) }),
    });
    return Effect.gen(function* () {
      const authId = legacyServiceContainerIds("demo")[1]!;
      yield* legacyStatus(flags({ exclude: [authId] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.API_URL).toBeUndefined(); // excluded via the auto-detected stopped kong
      expect(parsed.PUBLISHABLE_KEY).toBeUndefined(); // excluded via --exclude
      expect(parsed.DB_URL).toBeDefined(); // db.url is set unconditionally, before any gating
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs yaml with -o yaml", () => {
    const { layer, out } = setup({ goOutput: Option.some("yaml") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain("API_URL:");
    }).pipe(Effect.provide(layer));
  });

  it.live("outputs toml with -o toml", () => {
    const { layer, out } = setup({ goOutput: Option.some("toml") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      expect(out.stdoutText).toContain("API_URL =");
    }).pipe(Effect.provide(layer));
  });

  it.live("remaps an output key with --override-name api.url=NEXT_PUBLIC_SUPABASE_URL", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags({ overrideName: ["api.url=NEXT_PUBLIC_SUPABASE_URL"] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NEXT_PUBLIC_SUPABASE_URL).toBe("http://127.0.0.1:54321");
      expect(parsed.API_URL).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("fails on a malformed --override-name entry", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyStatus(flags({ overrideName: ["not-a-kv-pair"] })));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyStatusOverrideParseError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("silently ignores an --override-name entry with an unknown field key", () => {
    // The override-name resolver walks the known field keys
    // and looks up each one in the override map — it never checks
    // for leftover/unmatched keys, so an unrecognized key is a no-op, not an error.
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags({ overrideName: ["not.a.real.field=NAME"] }));
      const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
      expect(parsed.NAME).toBeUndefined();
      expect(parsed.API_URL).toBe("http://127.0.0.1:54321");
    }).pipe(Effect.provide(layer));
  });

  it.live("applies a valid --override-name entry alongside an unknown one", () => {
    const { layer, out } = setup({ goOutput: Option.some("json") });
    return Effect.gen(function* () {
      yield* legacyStatus(
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
      yield* legacyStatus(flags());
      const success = out.messages.find((m) => m.type === "success");
      expect(success?.data).toMatchObject({ API_URL: "http://127.0.0.1:54321" });
      expect(out.stdoutText).not.toContain("\x1b[?25l");
    }).pipe(Effect.provide(layer));
  });

  it.live("-o takes priority over --output-format when both are passed", () => {
    const { layer, out } = setup({ format: "json", goOutput: Option.some("env") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
      // -o env wins: raw KEY="VALUE" text on stdout, not a structured success message.
      expect(out.stdoutText).toContain('API_URL="http://127.0.0.1:54321"');
      expect(out.messages.find((m) => m.type === "success")).toBeUndefined();
    }).pipe(Effect.provide(layer));
  });

  it.live("lets --output pretty win over --output-format json", () => {
    // Explicit `-o pretty` is a complete format choice (matching functions/list)
    // and must render the table, not defer to the
    // TS-only --output-format json/stream-json branch.
    const { layer, out } = setup({ format: "json", goOutput: Option.some("pretty") });
    return Effect.gen(function* () {
      yield* legacyStatus(flags());
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
      yield* Effect.exit(legacyStatus(flags()));
      expect(telemetry.flushed).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  describe("linked-state display (CLI-2167 follow-up)", () => {
    it.live(
      "not linked: prints Not linked. as the first stdout line, then normal status output",
      () => {
        const { layer, out } = setup();
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
          expect(out.stdoutText.startsWith("Not linked.\n")).toBe(true);
          expect(out.stdoutText).toContain("🌐 APIs");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "linked to a real project: prints the Linked Project block (Org + Project) with zero Management API calls",
      () => {
        // An api mock IS wired here (unlike the "no layer at all" test below) so
        // the assertion is a genuine runtime count, not just "we didn't ask for
        // one" — the plain-project match must return before ever touching it.
        const { layer, out, workdir, apiMock } = setup({ branches: { ok: [] } });
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, { name: "My Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
      "branch-linked with the production factory-fallback path (LegacyPlatformApiFactory, not LegacyPlatformApi directly): resolves the branch",
      () => {
        // Pins the actual bug this feature shipped to fix: `status`'s real
        // runtime never wires `LegacyPlatformApi` directly (only the lazy
        // `LegacyPlatformApiFactory`, via `legacyPlatformApiFactoryLayer` in
        // `status.command.ts`) — a test using the `branches` mock above
        // would pass even if `legacyAcquireLinkedStateApi`'s factory fallback
        // were broken or missing entirely.
        const { layer, out, workdir, apiFactoryMock } = setup({
          apiFactory: { ok: [LINKED_BRANCH] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
            makeFails: new LegacyPlatformAuthRequiredError({ message: "no token" }),
          },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
          expect(
            out.stdoutText.startsWith(
              `Linked Project:\n` +
                `  Org: acme (org_1)\n` +
                `  Project: Parent Project (${LINKED_PARENT_REF})\n` +
                `  Branch: ${LINKED_BRANCH_REF}\n`,
            ),
          ).toBe(true);
          // `make` failed before any `v1` call was attempted.
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
          yield* legacyStatus(flags());
          // The cache CONFIRMS a distinct parent, so the degraded state still
          // carries it (and the org/name) — only the branch's own name is
          // missing, rendered as a bare ref so the user still sees they're on
          // a branch (never silently collapsing to a plain-project line).
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
          yield* legacyStatus(flags());
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
        // No linked-project.json and no API at all — the parent-chain's only
        // candidate (the project-ref file itself) is never trustworthy enough
        // on its own to claim a branch link; there must be no Org/Branch line.
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
          expect(
            out.stdoutText.startsWith(`Linked Project:\n  Project: ${LINKED_BRANCH_REF}\n`),
          ).toBe(true);
          // `startsWith` alone would still pass if a Branch:/Org: line were
          // wrongly appended right after (a real regression this rule guards
          // against) — assert their absence explicitly, everywhere.
          expect(out.stdoutText).not.toContain("\n  Branch:");
          expect(out.stdoutText).not.toContain("\n  Org:");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "no-false-claim rule: no cache, an API IS available but finds no matching branch — still the bare project line, no Branch/parent claim",
      () => {
        // Distinct from the "no API at all" test above: here a lookup DOES run
        // (against the project-ref file's own value as the query target) and
        // comes back with branches, none of which match — a real, connected
        // API that simply found nothing is not "positive confirmation" either.
        const { layer, out, workdir } = setup({
          branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
          expect(out.stdoutText.startsWith("Not linked.\n")).toBe(true);
          expect(out.stdoutText).not.toContain("not-a-real-ref!!");
        }).pipe(Effect.provide(layer));
      },
    );

    it.live(
      "-o json: a symlink/garbage project-ref file's content never reaches machine output (PR #6168 review, token-exfiltration vector)",
      () => {
        // A malicious worktree can symlink supabase/.temp/project-ref at
        // ~/.supabase/access-token; the pattern gate must keep any
        // non-ref-shaped content (e.g. a token) out of every output channel.
        const { layer, out, workdir } = setup({ goOutput: Option.some("json") });
        writeProjectRefFile(workdir, "sbp_0102030405060708090a0b0c0d0e0f10111213");
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
        // An api mock IS wired (matching LINKED_BRANCH_REF as a self-referential
        // branch) so the zero-requests assertion below is a genuine runtime
        // count, not just "we didn't need one" — with no `linked-project.json`,
        // `legacyResolveLinkedParentRef`'s cache candidate never participates
        // either (its own fix), so there is no parent to resolve at all, and
        // `legacyResolveLinkedState` never attempts the old self-referential
        // branch lookup.
        const { layer, out, workdir, apiMock } = setup({
          branches: {
            ok: [{ ...LINKED_BRANCH, parent_project_ref: LINKED_BRANCH_REF }],
          },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          branches: { fail: legacyTransportFailureForMock() },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          branches: { fail: legacyStatusCodeFailure(500) },
        });
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
        // Extends the existing "fails when both docker and podman are missing"
        // scenario: linking a real project must not change the failure, and the
        // linked-state block — resolved and printed BEFORE any daemon work —
        // must already be present on stdout when the command fails.
        const { layer, out, workdir } = setup({
          failSpawnFor: () => true,
        });
        writeProjectRefFile(workdir, LINKED_PLAIN_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PLAIN_REF, { name: "My Project" });
        return Effect.gen(function* () {
          const exit = yield* Effect.exit(legacyStatus(flags()));
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            expect(JSON.stringify(exit.cause)).toContain("LegacyStatusDbInspectError");
          }
          expect(out.stdoutText).toBe(
            `Linked Project:\n  Org: acme (org_1)\n  Project: My Project (${LINKED_PLAIN_REF})\n`,
          );
        }).pipe(Effect.provide(layer));
      },
    );

    describe("env-override guard (PR #6168 review)", () => {
      // SUPABASE_PROJECT_ID (env) always wins before the project-ref FILE is
      // ever read, so none of these write a project-ref file — the cache
      // below belongs to the WORKDIR (an unrelated project A), not
      // necessarily to whatever the env override happens to point at (B).
      it.live(
        "SUPABASE_PROJECT_ID overriding an unrelated workdir's cache: no positive lookup match degrades to the plain project line, no parent claim on cache presence alone",
        () => {
          const { layer, out, workdir } = setup({
            projectId: Option.some(LINKED_BRANCH_REF),
            branches: { ok: [{ ...LINKED_BRANCH, project_ref: "unrelatedbranchrefaaaa" }] },
          });
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* legacyStatus(flags());
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
            yield* legacyStatus(flags());
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
            yield* legacyStatus(flags());
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
      "a branch lookup that never resolves times out and degrades to the RICH block (real 5s wait — LEGACY_LINKED_STATE_LOOKUP_TIMEOUT is a module-private constant in legacy-linked-state.ts, not monkey-patchable; accepted as a real-time test for this one scenario, PR #6168 review)",
      () => {
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, LINKED_BRANCH_REF);
        writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
        const neverApi = mockLegacyPlatformApiService({
          v1: { listAllBranches: () => Effect.never },
        });
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
        // Superseded behavior: this used to render a sanitized block. The
        // pattern gate in legacyResolveSoftLinkedRef now rejects any
        // non-ref-shaped content outright (stronger: also closes the
        // symlink-to-secret exfiltration vector), so sanitization is
        // defense-in-depth behind it.
        const DIRTY_REF = "\x1b[31mmalicious\x1b[0m";
        const { layer, out, workdir } = setup();
        writeProjectRefFile(workdir, DIRTY_REF);
        return Effect.gen(function* () {
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags({ overrideName: ["api.url=linked_project_ref"] }));
          const parsed = JSON.parse(out.stdoutText) as Record<string, string>;
          // `values` (the override-renamed field) spreads LAST over
          // `legacyLinkedStateGoFields`, so the API URL — not the branch ref —
          // is what ends up under this key.
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
            yield* legacyStatus(flags());
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
            yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
            yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
            yield* legacyStatus(flags());
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
        yield* legacyStatus(flags());
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
        yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
        yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
          yield* legacyStatus(flags());
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
        yield* legacyStatus(flags());
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
        yield* legacyStatus(flags());
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
            yield* legacyStatus(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope._tag).toBe("Error");
            expect(envelope.error.code).toBe("LegacyStatusDbInspectError");
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
            yield* legacyStatus(flags()).pipe(withJsonErrorHandling);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope.error.code).toBe("LegacyStatusDbInspectError");
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
            yield* legacyStatus(flags()).pipe(withJsonErrorHandling);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope.error.code).toBe("LegacyStatusDbInspectError");
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
            yield* legacyStatus(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const event = JSON.parse(stdio.stdout[0]!);
            expect(event.type).toBe("error");
            expect(event.error.code).toBe("LegacyStatusDbInspectError");
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
          // Same branch-linked setup as the enriched test above — the point is
          // that resolving linked state successfully is not enough on its own;
          // omitting the cell from the layer graph must silently skip both the
          // handler's `Effect.serviceOption(MachineErrorContext)` write AND the
          // output layer's read, leaving the envelope byte-identical to the
          // pre-feature shape.
          const { layer, workdir, stdio, processControl } = setupFailureEnvelope({
            format: "json",
            branches: { ok: [LINKED_BRANCH] },
            withMachineErrorContext: false,
          });
          writeProjectRefFile(workdir, LINKED_BRANCH_REF);
          writeLinkedProjectCacheFile(workdir, LINKED_PARENT_REF, { name: "Parent Project" });
          return Effect.gen(function* () {
            yield* legacyStatus(flags()).pipe(withJsonErrorHandling);
            expect(stdio.stdout).toHaveLength(1);
            const envelope = JSON.parse(stdio.stdout[0]!);
            expect(envelope).toEqual({
              _tag: "Error",
              error: {
                code: "LegacyStatusDbInspectError",
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
