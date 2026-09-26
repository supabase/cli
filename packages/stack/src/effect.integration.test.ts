import { NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, expectTypeOf, it } from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Redacted,
  Schema,
  Scope,
  Stream,
} from "effect";
import { tmpdir } from "node:os";
import {
  create,
  discover,
  find,
  open,
  postgres,
  type DatabaseInstance,
  type ServiceInstance,
} from "./effect.ts";
import { fileURLToPath } from "node:url";
import { launchHost } from "./HostProcess.ts";
import * as PromiseApi from "./index.ts";
import * as State from "./State.ts";
import { assertOwnerExited } from "../tests/owner.ts";
import { foreignRelease } from "../tests/release-owner-fixture.ts";
import { destroyTestStack } from "../tests/stack-cleanup.ts";
import { deriveStackId, resolveStackIdentity } from "./identity/Identity.ts";

const layer = Layer.merge(NodeServices.layer, NodeHttpClient.layerNodeHttp);
// Below every OS ephemeral range, so another test's outbound socket cannot already hold it.
const FIXED_API_PORT = 24_393;
const databaseOwnerMarker = Schema.fromJsonString(
  Schema.Struct({ stackId: Schema.String, instanceId: Schema.String }),
);

it.live("registers and discovers saved definitions without inventing live observations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const entries = yield* discover(options);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.definition.id).toBe(stack.id);
    expect(entries[0]?.host).toBeUndefined();
    expect(entries[0]?.definition.instances).toEqual([]);
    expect(yield* stack.services.list).toEqual([]);
    expect(yield* stack.composition.describe).toEqual({ members: [], dependencies: [] });
    expect((yield* discover(options))[0]?.host).toBeUndefined();
    const duplicate = yield* Effect.flip(create(options));
    expect(duplicate.message).toContain("already exists");
    const reopened = yield* open({ ...options, id: stack.id });
    expect(reopened.id).toBe(stack.id);
    const missing = yield* Effect.flip(open({ ...options, id: "missing" }));
    expect(missing.message).toContain("does not exist");

    const database = stack.services.create({
      service: "database",
      config: {
        version: "17",
        databasePassword: Redacted.make("test"),
        jwtSecret: Redacted.make("test"),
        jwtExpiry: 3600,
      },
    });
    const rest = stack.services.create({
      service: "rest",
      config: { databaseUrl: "postgres://external" },
    });
    expectTypeOf<Effect.Success<typeof database>>().toEqualTypeOf<DatabaseInstance>();
    expectTypeOf<Effect.Success<typeof rest>>().toEqualTypeOf<ServiceInstance<"rest">>();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("discovers readable stacks past invalid siblings and reports each skipped entry", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-invalid-" });
    const stateRoot = `${root}/state`;
    const stack = yield* create({
      projectRoot: root,
      stateRoot,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    });
    yield* fs.makeDirectory(`${stateRoot}/malformed`);
    yield* fs.writeFileString(`${stateRoot}/malformed/state.json`, "{broken");
    yield* fs.makeDirectory(`${stateRoot}/unreadable/state.json`, { recursive: true });

    const silent = yield* discover({ stateRoot });
    expect(silent.map(({ definition }) => definition.id)).toEqual([stack.id]);

    const reported: Array<string> = [];
    const observed = yield* discover({
      stateRoot,
      onInvalidState: (id) => Effect.sync(() => reported.push(id)),
    });
    expect(observed.map(({ definition }) => definition.id)).toEqual([stack.id]);
    expect(reported.toSorted()).toEqual(["malformed", "unreadable"]);

    const promiseReported: Array<string> = [];
    const promiseObserved = yield* Effect.promise(() =>
      PromiseApi.discover({ stateRoot, onInvalidState: (id) => promiseReported.push(id) }),
    );
    expect(promiseObserved.map(({ definition }) => definition.id)).toEqual([stack.id]);
    expect(promiseReported.toSorted()).toEqual(["malformed", "unreadable"]);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("starts the owner on opt-in reopen without starting saved services", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-open-owner-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const mail = yield* stack.services.create({ service: "mail", config: {} });
        yield* stack.stop;

        const offline = yield* open({ ...options, id: stack.id });
        expect(offline.id).toBe(stack.id);
        expect(Exit.isFailure(yield* Effect.exit(mail.status))).toBe(true);

        const reopened = yield* open({ ...options, id: stack.id, startOwner: true });
        expect(reopened.id).toBe(stack.id);
        const observation = yield* (yield* reopened.services.get(mail.id)).status;
        expect(observation.lifecycle).toBe("stopped");
      }),
      destroyTestStack(stack),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "stops the owner after destroy fails and retains saved data for retry",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-failure-" });
        const options = {
          projectRoot: root,
          stateRoot: `${root}/state`,
          cacheRoot: `${root}/cache`,
          runtime: "native",
        } satisfies Parameters<typeof create>[0];
        const stack = yield* create(options);
        yield* Effect.addFinalizer(() => stack.stop.pipe(Effect.ignore));
        const instance = yield* stack.services.create({
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("destroy-test-password"),
            jwtSecret: Redacted.make("destroy-test-jwt-secret-at-least-thirty-two-characters"),
            jwtExpiry: 3600,
          },
        });
        const dataRoot = `${options.stateRoot}/${stack.id}/data/${instance.id}`;
        const marker = `${dataRoot}/.supabase-database-owner.json`;
        yield* fs.makeDirectory(dataRoot, { recursive: true });
        const writeMarker = Schema.encodeEffect(databaseOwnerMarker);
        yield* writeMarker({ stackId: "another-stack", instanceId: instance.id }).pipe(
          Effect.flatMap((value) => fs.writeFileString(marker, value)),
        );
        const running = yield* discover(options);
        expect(running).toHaveLength(1);
        expect(running[0]?.host).toBeDefined();

        const destroyExit = yield* stack.destroy.pipe(Effect.exit);
        expect(Exit.isFailure(destroyExit)).toBe(true);
        if (Exit.isFailure(destroyExit)) {
          const error = Option.getOrUndefined(Cause.findErrorOption(destroyExit.cause));
          expect(error).toMatchObject({
            operation: "shutdown",
            message: "Composition destroy had failures",
            outcomes: [
              {
                id: instance.id,
                succeeded: false,
                error: expect.stringContaining("Database root belongs to another instance"),
              },
            ],
          });
        }
        expect(yield* fs.readFileString(marker)).toContain("another-stack");
        const retained = yield* discover(options);
        expect(retained).toHaveLength(1);
        expect(retained[0]?.host).toBeUndefined();

        yield* writeMarker({ stackId: stack.id, instanceId: instance.id }).pipe(
          Effect.flatMap((value) => fs.writeFileString(marker, value)),
        );
        yield* stack.destroy;
        expect(yield* discover(options)).toHaveLength(0);
      }),
    ).pipe(Effect.provide(layer)),
  { timeout: 30_000 },
);

const resetDataStory = (runtime: "native" | "docker") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: `stack-reset-data-${runtime}-` });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
      runtime,
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    yield* Effect.acquireUseRelease(
      Effect.succeed(stack),
      (current) =>
        Effect.gen(function* () {
          const target = yield* current.services.create({
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("reset-shared-password"),
              jwtSecret: Redacted.make("reset-shared-jwt-secret-long-enough-32chars"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          });
          const sibling = yield* current.services.create({
            service: "database",
            config: {
              version: "17",
              databasePassword: Redacted.make("reset-shared-password"),
              jwtSecret: Redacted.make("reset-shared-jwt-secret-long-enough-32chars"),
              jwtExpiry: 3600,
            },
            endpoints: { sql: { port: "auto" } },
          });
          const composition = {
            members: [
              { id: target.id, activation: "lazy" as const },
              { id: sibling.id, activation: "eager" as const },
            ],
            dependencies: [],
          };
          yield* current.composition.configure(composition);

          yield* current.composition.start;
          const armed = yield* target.status;
          expect(armed.lifecycle).toBe("stopped");
          expect(armed.wakeEnabled).toBe(true);
          const armedReset = yield* Effect.flip(target.resetData);
          expect(armedReset.message).toContain("must be stopped with wake disabled");
          yield* current.composition.stop;
          expect((yield* target.status).wakeEnabled).toBe(false);

          yield* target.start;
          yield* target.ready;
          yield* sibling.start;
          yield* sibling.ready;
          const targetCredentials = yield* target.credentials({ from: "runtime" });
          const siblingCredentials = yield* sibling.credentials({ from: "runtime" });
          const targetUrl = targetCredentials.databaseUrl;
          const siblingUrl = siblingCredentials.databaseUrl;
          if (targetUrl === undefined || siblingUrl === undefined)
            return yield* Effect.die("database credentials missing");

          const runSql = Effect.fn("ResetData.runSql")((
            client: typeof current,
            url: string,
            sql: string,
          ) => {
            const stdout: Array<string> = [];
            const stderr: Array<string> = [];
            return client.tools
              .run(postgres.psql({ major: 17 }), {
                args: ["--dbname", url, "-Atc", sql],
                stdout: (bytes) => Effect.sync(() => stdout.push(new TextDecoder().decode(bytes))),
                stderr: (bytes) => Effect.sync(() => stderr.push(new TextDecoder().decode(bytes))),
              })
              .pipe(
                Effect.map((result) => ({
                  ...result,
                  stdout: stdout.join(""),
                  stderr: stderr.join(""),
                })),
              );
          });
          const assertSql = Effect.fn("ResetData.assertSql")(
            (client: typeof current, url: string, sql: string) =>
              runSql(client, url, sql).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    expect(result.exitCode, result.stderr).toBe(0);
                  }),
                ),
              ),
          );

          const runningReset = yield* Effect.flip(target.resetData);
          expect(runningReset.message).toContain("must be stopped with wake disabled");
          yield* assertSql(
            current,
            siblingUrl,
            "CREATE TABLE reset_sibling_sentinel(value text NOT NULL); INSERT INTO reset_sibling_sentinel VALUES ('survives');",
          );
          yield* assertSql(
            current,
            targetUrl,
            "CREATE TABLE reset_rows(value text NOT NULL); INSERT INTO reset_rows VALUES ('owned'); CREATE ROLE reset_role",
          );
          yield* assertSql(current, targetUrl, "CREATE DATABASE reset_extra");
          const beforeStatus = yield* target.status;
          const beforeComposition = yield* current.composition.describe;
          const targetPort = new URL(targetUrl).port;

          yield* target.stop;
          yield* target.resetData;
          const resetStatus = yield* target.status;
          expect(resetStatus.lifecycle).toBe("stopped");
          expect(resetStatus.wakeEnabled).toBe(false);
          expect(resetStatus.config).toEqual(beforeStatus.config);
          expect(resetStatus.id).toBe(target.id);
          expect(yield* current.composition.describe).toEqual(beforeComposition);
          const resetCredentials = yield* target.credentials({ from: "runtime" });
          if (resetCredentials.databaseUrl === undefined)
            return yield* Effect.die("reset database credentials missing");
          expect(new URL(resetCredentials.databaseUrl).port).toBe(targetPort);
          expect((yield* sibling.status).lifecycle).toBe("running");
          const siblingMarker = yield* assertSql(
            current,
            siblingUrl,
            "SELECT value FROM reset_sibling_sentinel",
          );
          expect(siblingMarker.stdout.trim()).toBe("survives");

          yield* target.start;
          yield* target.ready;
          const cleared = yield* assertSql(
            current,
            targetUrl,
            "SELECT to_regclass('public.reset_rows') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reset_role') AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'reset_extra')",
          );
          expect(cleared.stdout.trim()).toBe("t");

          yield* target.stop;
          yield* target.resetData;
          yield* current.stop;
          const reopened = yield* open({ ...options, id: current.id });
          const reopenedTarget = yield* reopened.services.get(target.id);
          if (reopenedTarget.service !== "database")
            return yield* Effect.die("reopened target is not a database");
          yield* reopenedTarget.start;
          yield* reopenedTarget.ready;
          const reopenedCredentials = yield* reopenedTarget.credentials({ from: "runtime" });
          if (reopenedCredentials.databaseUrl === undefined)
            return yield* Effect.die("reopened database credentials missing");
          expect(new URL(reopenedCredentials.databaseUrl).port).toBe(targetPort);
          const reopenedCleared = yield* assertSql(
            reopened,
            reopenedCredentials.databaseUrl,
            "SELECT to_regclass('public.reset_rows') IS NULL AND NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'reset_role') AND NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'reset_extra')",
          );
          expect(reopenedCleared.stdout.trim()).toBe("t");
        }),
      destroyTestStack,
    );
  }).pipe(Effect.scoped, Effect.provide(layer));

it.live("resets native database data through the public RPC", () => resetDataStory("native"), {
  timeout: 10 * 60_000,
});

it.live("resets Docker database data through the public RPC", () => resetDataStory("docker"), {
  timeout: 15 * 60_000,
});

it.live("stops an instance without starting an owner when none is live", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-idle-stop-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const mail = yield* stack.services.create({ service: "mail", config: {} });
        yield* stack.stop;
        expect((yield* discover(options))[0]?.host).toBeUndefined();

        yield* mail.stop;
        expect(yield* stack.composition.stop).toEqual([]);
        yield* stack.stop;
        expect((yield* discover(options))[0]?.host).toBeUndefined();
      }),
      destroyTestStack(stack),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("rejects an owner of another release while stop and destroy still reach it", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-release-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const state = yield* State.Service.pipe(
      Effect.provide(State.layer({ root: options.stateRoot })),
    );
    const startForeignOwner = launchHost(state, {
      ...options,
      stackId: stack.id,
      entrypoint: fileURLToPath(new URL("../tests/release-owner-fixture.ts", import.meta.url)),
    });

    const stale = yield* startForeignOwner;
    expect(stale.endpoint.release).toBe(foreignRelease);
    const rejected = yield* Effect.flip(stack.composition.start);
    expect(rejected.reason).toBe("release-mismatch");
    expect(rejected.message).toContain(`served by release ${foreignRelease}`);
    expect(rejected.message).toContain("stop or destroy the stack");
    yield* stack.stop;
    yield* assertOwnerExited(stale.endpoint.pid);

    const doomed = yield* startForeignOwner;
    yield* stack.destroy;
    yield* assertOwnerExited(doomed.endpoint.pid);
    expect(yield* state.read(stack.id)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("treats a sweeper's hold as no owner and starts one once the sweep ends", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-sweeping-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const state = yield* State.Service.pipe(
      Effect.provide(State.layer({ root: options.stateRoot })),
    );
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const sweep = yield* Scope.make();
        expect(yield* state.lease(stack.id).pipe(Scope.provide(sweep))).toBe(true);
        yield* state.publishHolder(stack.id, {
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        });
        yield* stack.stop;
        expect(yield* stack.composition.stop).toEqual([]);
        expect((yield* discover(options))[0]?.host).toBeUndefined();

        const starting = yield* stack.composition.start.pipe(
          Effect.forkChild({ startImmediately: true }),
        );
        yield* state.retractHolder(stack.id);
        yield* Scope.close(sweep, Exit.void);
        expect(yield* Fiber.join(starting)).toEqual([]);
        expect((yield* discover(options))[0]?.host).toBeDefined();
      }),
      destroyTestStack(stack),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("interrupts a call waiting for an owner while a sweeper holds the stack", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-interrupt-launch-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const state = yield* State.Service.pipe(
      Effect.provide(State.layer({ root: options.stateRoot })),
    );
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const sweep = yield* Scope.make();
        expect(yield* state.lease(stack.id).pipe(Scope.provide(sweep))).toBe(true);
        yield* state.publishHolder(stack.id, {
          role: "sweeper",
          pid: process.pid,
          startedAt: "2026-01-01T00:00:00.000Z",
        });

        const waited = yield* stack.composition.start.pipe(Effect.timeoutOption("200 millis"));

        expect(Option.isNone(waited), "the wait for the sweeper ends at the timeout").toBe(true);
        yield* state.retractHolder(stack.id);
        yield* Scope.close(sweep, Exit.void);
        expect(yield* stack.composition.start, "the handle still launches afterwards").toEqual([]);
      }),
      destroyTestStack(stack),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("reports a stopped owner as unavailable to attach-only calls", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-unavailable-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const mail = yield* stack.services.create({ service: "mail", config: {} });
    yield* stack.stop;

    const unavailable = yield* Effect.flip(mail.status);

    expect(unavailable.reason).toBe("owner-unavailable");
    yield* destroyTestStack(stack);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "releases each call's owner connection in the call's scope, not the handle's",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-call-scope-" });
      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
        runtime: "native",
      } satisfies Parameters<typeof create>[0];
      const handleScope = yield* Scope.make();
      const stack = yield* create(options).pipe(Scope.provide(handleScope));
      const handleFinalizers = () =>
        handleScope.state._tag === "Open"
          ? (handleScope.state.finalizers?.size ?? 0) +
            (handleScope.state.finalizerKey === undefined ? 0 : 1)
          : 0;
      const useHandle = (mail: ServiceInstance<"mail">) =>
        Effect.gen(function* () {
          yield* mail.status;
          yield* mail.followStatus.pipe(Stream.take(1), Stream.runDrain);
          const version = yield* stack.tools.run(postgres.psql({ major: 17 }), {
            args: ["--version"],
            stdout: () => Effect.void,
            stderr: () => Effect.void,
          });
          expect(version.exitCode).toBe(0);
        });
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const mail = yield* stack.services.create({ service: "mail", config: {} });
          yield* useHandle(mail);
          const settled = handleFinalizers();

          yield* useHandle(mail);
          yield* useHandle(mail);
          expect(handleFinalizers(), "repeated calls add nothing to the handle").toBe(settled);

          const other = yield* open({ ...options, id: stack.id });
          yield* other.stop;
          expect(yield* other.composition.start).toEqual([]);
          yield* useHandle(mail);
          expect(handleFinalizers(), "the retired connection closed after its last use").toBe(
            settled,
          );
        }),
        destroyTestStack(stack).pipe(Effect.andThen(Scope.close(handleScope, Exit.void))),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 120_000 },
);

it.live("confirms owner exit after shutdown even while a stray handle keeps its loop alive", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-owner-exit-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    } satisfies Parameters<typeof create>[0];
    const stack = yield* create(options);
    const state = yield* State.Service.pipe(
      Effect.provide(State.layer({ root: options.stateRoot })),
    );
    const owner = yield* launchHost(state, {
      ...options,
      stackId: stack.id,
      entrypoint: fileURLToPath(new URL("../tests/lingering-owner-fixture.ts", import.meta.url)),
    });

    yield* stack.stop;

    yield* assertOwnerExited(owner.endpoint.pid);
    yield* destroyTestStack(stack);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("replaces a dead session stack that holds the requested identity", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-session-replace-" });
    const options = {
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
      lifetime: "session",
    } satisfies Parameters<typeof create>[0];
    const identity = yield* resolveStackIdentity(options);
    const id = yield* deriveStackId(identity);
    const state = yield* State.Service.pipe(
      Effect.provide(State.layer({ root: options.stateRoot })),
    );
    yield* state.save({
      id,
      identity,
      lifetime: "session",
      runtime: "native",
      instances: [{ id: "abandoned", creation: { service: "mail", config: {} } }],
      composition: { members: [], dependencies: [] },
      ports: [],
    });

    yield* Effect.scoped(
      Effect.gen(function* () {
        const stack = yield* create(options);
        expect(stack.id).toBe(id);
        expect(yield* stack.services.list).toEqual([]);
      }),
    );
    expect(yield* state.read(id)).toBeUndefined();
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live(
  "re-resolves a restarted owner for calls and tools on a long-lived handle",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-reconnect-" });
      const options = {
        projectRoot: root,
        stateRoot: `${root}/state`,
        cacheRoot: `${tmpdir()}/supabase-stack-artifacts`,
        runtime: "native",
      } satisfies Parameters<typeof create>[0];
      const stack = yield* create(options);
      const version = (stack: Effect.Success<ReturnType<typeof open>>) =>
        stack.tools.run(postgres.psql({ major: 17 }), {
          args: ["--version"],
          stdout: () => Effect.void,
          stderr: () => Effect.void,
        });
      yield* Effect.ensuring(
        Effect.gen(function* () {
          const mail = yield* stack.services.create({ service: "mail", config: {} });
          expect((yield* version(stack)).exitCode).toBe(0);
          const first = (yield* discover(options))[0]?.host;

          const other = yield* open({ ...options, id: stack.id });
          yield* other.stop;
          expect(yield* other.composition.start).toEqual([]);
          const second = (yield* discover(options))[0]?.host;
          expect(second?.port).toBeDefined();
          expect(second?.pid).not.toBe(first?.pid);

          expect((yield* version(stack)).exitCode, "a tools-only call follows the new owner").toBe(
            0,
          );
          yield* other.stop;
          expect(yield* other.composition.start).toEqual([]);
          expect((yield* mail.status).lifecycle, "a call follows the new owner").toBe("stopped");
        }),
        destroyTestStack(stack),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  { timeout: 120_000 },
);

it.live("finds one saved stack by identity or id and fails on unreadable state", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-find-" });
    const stateRoot = `${root}/state`;
    expect(Option.isNone(yield* find({ stateRoot, projectRoot: root }))).toBe(true);
    const stack = yield* create({
      projectRoot: root,
      name: "feature",
      stateRoot,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    });

    const byIdentity = Option.getOrUndefined(
      yield* find({ stateRoot, projectRoot: root, name: "feature" }),
    );
    expect(byIdentity?.definition.id).toBe(stack.id);
    expect(byIdentity?.host).toBeUndefined();
    expect(Option.isNone(yield* find({ stateRoot, projectRoot: root }))).toBe(true);
    const byId = yield* Effect.promise(() => PromiseApi.find({ stateRoot, id: stack.id }));
    expect(byId?.definition.identity.stackName).toBe("feature");

    yield* fs.writeFileString(`${stateRoot}/${stack.id}/state.json`, "{broken");
    const failure = yield* find({ stateRoot, projectRoot: root, name: "feature" }).pipe(
      Effect.flip,
    );
    expect(failure.operation).toBe("find");
    expect(failure.message).toContain(stack.id);
  }).pipe(Effect.scoped, Effect.provide(layer)),
);

it.live("plans requested creations against the saved composition and honours eager", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-api-plan-" });
    const stack = yield* create({
      projectRoot: root,
      stateRoot: `${root}/state`,
      cacheRoot: `${root}/cache`,
      runtime: "native",
    });
    yield* Effect.ensuring(
      Effect.gen(function* () {
        const database = {
          service: "database",
          config: {
            version: "17",
            databasePassword: Redacted.make("plan-database-password"),
            jwtSecret: Redacted.make("plan-database-jwt-secret-at-least-32-chars"),
            jwtExpiry: 3600,
          },
          endpoints: { sql: { port: "auto" } },
        } as const;
        const rest = {
          service: "rest",
          config: { maxRows: 100 },
          endpoints: { http: { port: FIXED_API_PORT } },
        } as const;
        const auth = {
          service: "auth",
          config: {},
          endpoints: { http: { port: "auto" } },
        } as const;
        const members = yield* stack.composition.supabase([database, rest, auth]);
        const databaseId = members.find(({ service }) => service === "database")?.id;
        const restId = members.find(({ service }) => service === "rest")?.id;
        const authId = members.find(({ service }) => service === "auth")?.id;
        expect((yield* stack.composition.describe).members).toEqual([
          { id: databaseId, activation: "eager" },
          { id: restId, activation: "lazy", idleMillis: 60_000 },
          { id: authId, activation: "lazy", idleMillis: 60_000 },
        ]);

        expect(
          yield* stack.composition.plan([
            database,
            { ...rest, config: { maxRows: 500 } },
            auth,
            { service: "mail", config: {} },
          ]),
        ).toEqual([
          { id: databaseId, service: "database", member: true, change: "unchanged" },
          {
            id: restId,
            service: "rest",
            member: true,
            change: "changed",
            paths: ["config.maxRows"],
          },
          { id: authId, service: "auth", member: true, change: "unchanged" },
        ]);
        const client = yield* Effect.promise(() =>
          PromiseApi.open({ id: stack.id, stateRoot: `${root}/state`, cacheRoot: `${root}/cache` }),
        );
        const promisePlan = yield* Effect.promise(() =>
          client.composition
            .plan([{ ...rest, config: { maxRows: 100 } }])
            .finally(() => client.close()),
        );
        expect(promisePlan).toEqual([
          { id: restId, service: "rest", member: true, change: "unchanged" },
        ]);
        expect(
          yield* stack.composition.plan([
            { ...database, config: { ...database.config, version: "15" } },
            { ...rest, endpoints: { http: { port: 54_999 } } },
          ]),
        ).toEqual([
          {
            id: databaseId,
            service: "database",
            member: true,
            change: "incompatible",
            paths: ["config.version"],
          },
          {
            id: restId,
            service: "rest",
            member: true,
            change: "incompatible",
            paths: ["endpoints.http.port"],
          },
        ]);

        yield* stack.composition.supabase([database, rest], {
          reuseIds: [databaseId, restId].filter((id) => id !== undefined),
          eager: true,
        });
        expect((yield* stack.composition.describe).members).toEqual([
          { id: databaseId, activation: "eager" },
          { id: restId, activation: "eager" },
        ]);
      }),
      destroyTestStack(stack),
    );
  }).pipe(Effect.scoped, Effect.provide(layer)),
);
