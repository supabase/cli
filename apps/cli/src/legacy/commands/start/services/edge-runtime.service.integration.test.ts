import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { beforeEach } from "vitest";

import { useLegacyTempWorkdir } from "../../../../../tests/helpers/legacy-mocks.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  legacyStartEdgeRuntimeContainer,
  type LegacyEdgeRuntimeBringUpInput,
} from "./edge-runtime.service.ts";

/**
 * A spawner that answers every `docker` invocation
 * `legacyStartEdgeRuntimeContainer`'s call chain makes
 * (`ensureDockerNamedVolume`/`ensureDockerNetwork`/the `docker run -d` bring-up
 * itself) with success, recording every invocation's argv for assertions —
 * same shape as `health-check.unit.test.ts`'s `mockHealthSpawner`. Secret
 * values are delivered to the `run -d` call via `--env-file`/a bind-mounted
 * script, not this spawned process's own environment (see
 * `edge-runtime.service.ts`'s header for why), so there is nothing to capture
 * beyond argv. Note `legacyStartEdgeRuntimeContainer` never issues a
 * `docker exec ... kong reload` — that only happens in `functions serve`'s own
 * `restartEdgeRuntime`-equivalent wrapper (`shared/functions/serve.ts`'s
 * `startEdgeRuntime`), not in the shared bring-up core this module calls
 * directly — see the "does not reload Kong" test below.
 */
function mockDockerSpawner() {
  const calls: Array<{ args: ReadonlyArray<string> }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      calls.push({ args });

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(0));
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.empty,
        stderr: Stream.empty,
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
  );

  return {
    spawner,
    get calls() {
      return calls;
    },
    get runCall() {
      return calls.find((call) => call.args[0] === "run" && call.args[1] === "-d");
    },
  };
}

function baseInput(workdir: string): LegacyEdgeRuntimeBringUpInput {
  return {
    projectId: "proj",
    networkId: "supabase_network_proj",
    image: "registry.example.com/supabase/edge-runtime:v1.74.2",
    workdir,
    // `authenticator:postgres@127.0.0.1:54322/postgres` — password "postgres", matching every
    // other service's `dbUrl` input shape (`LegacyLocalConfigValues.dbUrl`).
    dbUrl: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
    apiPort: 54321,
    edgeRuntimePolicy: "oneshot",
    edgeRuntimeInspectorPort: 8083,
    edgeRuntimeSecrets: {},
    configDeclaredFunctions: {},
    configFunctions: {},
    rawConfigFunctions: {},
    authArtifacts: {
      publishableKey: "sb_publishable_local",
      secretKey: "sb_secret_local",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
      anonKey: "anon.jwt.value",
      serviceRoleKey: "service-role.jwt.value",
      jwks: '{"keys":[]}',
    },
    debug: false,
    platform: "darwin",
  };
}

function envEntries(runCall: {
  args: ReadonlyArray<string>;
  env?: Readonly<Record<string, string>>;
}) {
  const envFileArgIndex = runCall.args.indexOf("--env-file");
  const envFilePath = runCall.args[envFileArgIndex + 1];
  expect(envFilePath).toBeDefined();
  return readFileSync(envFilePath!, "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("legacyStartEdgeRuntimeContainer", () => {
  const tempWorkdir = useLegacyTempWorkdir("supabase-edge-runtime-service-int-");

  // An empty functions directory — every scenario here has zero declared
  // functions (`configDeclaredFunctions`/`configFunctions` in `baseInput`),
  // so nothing under it is ever read; it only needs to exist.
  beforeEach(() => {
    mkdirSync(join(tempWorkdir.current, "supabase", "functions"), { recursive: true });
  });

  it.effect(
    "sends the real internal db url (db container name, port 5432, config.db.password) — NOT functions serve's `db`-alias default",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        const entries = envEntries(mock.runCall!);
        expect(entries).toContain(
          "SUPABASE_DB_URL=postgresql://postgres:postgres@supabase_db_proj:5432/postgres",
        );
      }),
  );

  it.effect("passes every already-resolved auth artifact through unchanged", () =>
    Effect.gen(function* () {
      const mock = mockDockerSpawner();
      const out = mockOutput();

      yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
        Effect.provide(out.layer),
      );

      const entries = envEntries(mock.runCall!);
      expect(entries).toContain("SUPABASE_ANON_KEY=anon.jwt.value");
      expect(entries).toContain("SUPABASE_SERVICE_ROLE_KEY=service-role.jwt.value");
      expect(entries).toContain(
        "SUPABASE_INTERNAL_JWT_SECRET=super-secret-jwt-token-with-at-least-32-characters-long",
      );
      expect(entries).toContain("SUPABASE_INTERNAL_PUBLISHABLE_KEY=sb_publishable_local");
      expect(entries).toContain("SUPABASE_INTERNAL_SECRET_KEY=sb_secret_local");
      expect(entries).toContain('SUPABASE_JWKS={"keys":[]}');
      expect(entries).toContain("SUPABASE_INTERNAL_HOST_PORT=54321");
    }),
  );

  it.effect(
    "never applies functions serve's own CLI-only overrides (no inspector port, verifyJWT defaults on)",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        const runCall = mock.runCall!;
        expect(runCall.args).not.toContain("-p");
        expect(runCall.args.join(" ")).not.toContain("--inspect");
      }),
  );

  it.effect(
    "sets --workdir and --ulimit nofile=65536:65536, matching Go's WorkingDir/Ulimits container.Config",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        const runCall = mock.runCall!;
        const workdirIndex = runCall.args.indexOf("--workdir");
        expect(workdirIndex).toBeGreaterThanOrEqual(0);
        expect(runCall.args[workdirIndex + 1]).toBe(tempWorkdir.current);
        const ulimitIndex = runCall.args.indexOf("--ulimit");
        expect(runCall.args[ulimitIndex + 1]).toBe("nofile=65536:65536");
      }),
  );

  it.effect(
    "stamps its own com.supabase.cli.workdir label so a later stop from a different cwd can reclaim this container's staged-secret directory",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        const runCall = mock.runCall!;
        expect(runCall.args).toContain(`com.supabase.cli.workdir=${tempWorkdir.current}`);
      }),
  );

  it.effect(
    "joins the caller-supplied network id and uses the already-resolved image, unmodified",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();
        const input = {
          ...baseInput(tempWorkdir.current),
          networkId: "custom_network_override",
          image: "registry.example.com/supabase/edge-runtime:v1.99.9",
        };

        yield* legacyStartEdgeRuntimeContainer(input).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        const runCall = mock.runCall!;
        const networkIndex = runCall.args.indexOf("--network");
        expect(runCall.args[networkIndex + 1]).toBe("custom_network_override");
        expect(runCall.args).toContain("registry.example.com/supabase/edge-runtime:v1.99.9");
      }),
  );

  it.effect(
    "resolves with the started container's id and a cleanup effect left for the caller to run",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        const started = yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        expect(started.containerId).toBe("supabase_edge_runtime_proj");
        yield* started.cleanup;
      }),
  );

  it.effect(
    "cleans up a stale staging directory from a previous invocation even when this invocation fails before ever reaching docker run",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();
        const stagingDir = join(
          tempWorkdir.current,
          "supabase",
          ".temp",
          "start-secrets",
          "supabase_edge_runtime_proj",
        );
        // Simulates a leftover from an earlier invocation (e.g. `functions serve`'s watch-mode
        // restart loop) that was never reclaimed — `writeDockerEnvFile`'s own header explains why
        // this path is deterministic/reused rather than a fresh mkdtemp per call.
        mkdirSync(join(stagingDir, "env"), { recursive: true });
        writeFileSync(join(stagingDir, "env", "docker.env"), "STALE=1");

        const input = {
          ...baseInput(tempWorkdir.current),
          // A multiline secret with a name that fails `validateDockerMultilineEnvNames` (must
          // match a shell variable name) — this throws before any of THIS invocation's staging
          // writes happen, proving cleanup covers the whole staging-write window, not just a
          // failure at (or after) the `docker run` step.
          edgeRuntimeSecrets: { "1BAD_NAME": "line one\nline two" },
        };

        const exit = yield* Effect.exit(
          legacyStartEdgeRuntimeContainer(input).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
            Effect.provide(out.layer),
          ),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(existsSync(stagingDir)).toBe(false);
      }),
  );

  it.effect(
    "never reloads Kong — Go's `start` bring-up (`ServeFunctions`) never does, unlike `functions serve`'s own restart wrapper",
    () =>
      Effect.gen(function* () {
        const mock = mockDockerSpawner();
        const out = mockOutput();

        yield* legacyStartEdgeRuntimeContainer(baseInput(tempWorkdir.current)).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, mock.spawner),
          Effect.provide(out.layer),
        );

        expect(
          mock.calls.some((call) => call.args[0] === "exec" && call.args.includes("kong")),
        ).toBe(false);
      }),
  );
});
