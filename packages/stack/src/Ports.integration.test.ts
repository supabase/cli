import { NodeFileSystem, NodeHttpClient, NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  Context,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Hash,
  Layer,
  Path,
  Schedule,
  Scope,
} from "effect";
import * as Net from "node:net";
import { randomUUID } from "node:crypto";
import {
  makePorts,
  nativePortBase,
  nativePortSpan,
  PortError,
  probeVacant,
  reserveNativePort,
} from "./Ports.ts";
import { systemError } from "effect/PlatformError";
import { bindTcp } from "./Proxy.ts";
import { CONTAINER_ENV_DIRNAME } from "./namespace/Paths.ts";
import * as PortReservations from "./namespace/PortReservations.ts";
import * as StackNamespace from "./StackNamespace.ts";
import { ownerFor } from "../tests/owner-rpc.ts";

/**
 * Scenarios the public `effect.ts` facade cannot reach deterministically: forcing an
 * auto-allocation retry onto a known candidate, which needs the exact first port a real round trip
 * picked; a real TCP bind failure, which a probe-equipped `Network.ts` callback would otherwise
 * intercept first on a platform where overlapping binds succeed; and a stack-wide destroy's
 * retained row release through a real, in-process `Owner`, whose first attempt a concrete sweep
 * failure leaves uncertain. All exercise the real per-user registry and real sockets; see
 * `port-reservation.e2e.test.ts` for the end-to-end scenarios, and `Network.integration.test.ts`'s
 * "keeps shared routes independent and retains the shared claim" for the shared-listener
 * self-reuse case.
 */

const makeTestState = (root: string) =>
  Layer.build(StackNamespace.layer({ root })).pipe(
    Effect.map((context) => Context.get(context, StackNamespace.Service)),
  );

const saveStack = (state: StackNamespace.Interface, root: string, id: string) =>
  state.save({
    id,
    runtime: "native",
    identity: { projectRoot: root, branchContext: "test", stackName: id },
    instances: [],
    lifetime: "detached",
    composition: { members: [], dependencies: [] },
  });

/** Binds like a brand-new listener Network.ts would create: probed first, then really bound, so
 * the assertion exercises Linux's real EADDRINUSE path and macOS's probe alike. */
const probedBind = (key: string) => (host: string, port: number) =>
  probeVacant(process.platform)(key, host, port).pipe(Effect.andThen(bindTcp(host, port)));

/**
 * Binds a real wildcard listener directly in the native span, skipping any already-occupied
 * candidate, instead of reserving a port through the allocator and racing to rebind it as a
 * blocker afterward.
 */
const bindNativeWildcard = (): Effect.Effect<{
  readonly port: number;
  readonly server: Net.Server;
}> =>
  Effect.gen(function* () {
    for (let offset = 0; offset < nativePortSpan; offset++) {
      const port = nativePortBase + offset;
      const attempt = yield* Effect.exit(
        Effect.callback<Net.Server, Error>((resume) => {
          const server = Net.createServer();
          server.once("error", (cause) => resume(Effect.fail(cause)));
          server.listen(port, "0.0.0.0", () => resume(Effect.succeed(server)));
        }),
      );
      if (Exit.isSuccess(attempt)) return { port, server: attempt.value };
    }
    return yield* Effect.die("No port in the native span was free for the fixture");
  });

/**
 * Brute-forces a key whose hash-seeded first scan candidate is exactly `port`, so a test can plant
 * a blocker there ahead of time and assert the scan skips it, rather than merely missing it by
 * chance.
 */
const keyWithFirstCandidate = (port: number): string => {
  const offset = port - nativePortBase;
  for (let attempt = 0; attempt < nativePortSpan * 20; attempt++) {
    const key = `native-fixture-${attempt}`;
    if (Math.abs(Hash.string(key)) % nativePortSpan === offset) return key;
  }
  throw new Error(`No key found whose first candidate is port ${port}`);
};

it.live(
  "on this platform, auto allocation skips a port a foreign listener occupies, even where overlapping binds would otherwise succeed",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const id = `auto-skip-${randomUUID()}`;
        const state = yield* makeTestState(root);
        yield* saveStack(state, root, id);
        const ports = yield* makePorts(state);
        const request = { stackId: id, key: "api", host: "127.0.0.1", port: "auto" as const };
        const bind = probedBind("api");

        const firstScope = yield* Scope.make();
        const first = yield* ports
          .acquire(request, bind)
          .pipe(Effect.provideService(Scope.Scope, firstScope));
        yield* Scope.close(firstScope, Exit.void);
        yield* ports.release(id, "api");

        // Reacquiring the same stack and key retries the same hash-seeded candidate first, so
        // whatever now occupies it deterministically forces the scan onto the next one.
        const foreign = Net.createServer();
        yield* Effect.callback<void, Error>((resume) => {
          foreign.once("error", (cause) => resume(Effect.fail(cause)));
          foreign.listen(first.port, "127.0.0.1", () => resume(Effect.void));
        });
        yield* Effect.addFinalizer(() =>
          Effect.callback<void>((resume) => {
            foreign.close(() => resume(Effect.void));
          }),
        );

        const second = yield* ports.acquire(request, bind);
        expect(second.port).not.toBe(first.port);
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);

it.live(
  "a fixed TCP request surfaces a structured, foreign conflict when a real bind fails with EADDRINUSE",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const id = `tcp-foreign-${randomUUID()}`;
        const state = yield* makeTestState(root);
        yield* saveStack(state, root, id);
        const ports = yield* makePorts(state);

        const foreign = yield* Effect.acquireRelease(
          Effect.callback<Net.Server, Error>((resume) => {
            const server = Net.createServer();
            server.once("error", (cause) => resume(Effect.fail(cause)));
            server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.callback<void>((resume) => {
              server.close(() => resume(Effect.void));
            }),
        );
        const address = foreign.address();
        if (address === null || typeof address === "string")
          return yield* Effect.die("Unable to reserve a test port");

        // No probe wrapper here, unlike `Network.ts`'s own callback: this exercises the real TCP
        // bind failure (EADDRINUSE) directly, which the probe would otherwise intercept first on a
        // platform where overlapping binds succeed.
        const failure = yield* ports
          .acquire({ stackId: id, key: "api", host: "127.0.0.1", port: address.port }, bindTcp)
          .pipe(Effect.flip);
        if (!(failure instanceof PortError)) return yield* Effect.die("expected a PortError");
        expect(failure.conflict?.holder).toBe("foreign");
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);

it.live(
  "interrupting an initial auto acquisition while its bind attempt is pending leaves no row behind",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const id = `auto-interrupt-${randomUUID()}`;
        const state = yield* makeTestState(root);
        yield* saveStack(state, root, id);
        const ports = yield* makePorts(state);
        const realRoot = yield* fs.realPath(root);
        const portReservations = yield* PortReservations.Service.pipe(
          Effect.provide(PortReservations.layer),
        );

        // Stands in for a probe or bind that never settles: the first candidate's row is
        // committed, then the acquisition is interrupted while still inside it.
        const bind = (_host: string, _port: number) => Effect.never;
        const fiber = yield* ports
          .acquire({ stackId: id, key: "api", host: "127.0.0.1", port: "auto" }, bind)
          .pipe(Effect.forkChild);
        const scanned = yield* portReservations.find(realRoot, id, "api").pipe(
          Effect.repeat({
            while: (port) => port === undefined,
            schedule: Schedule.spaced("5 millis"),
          }),
          Effect.timeout("5 seconds"),
        );
        expect(scanned).toBeDefined();

        yield* Fiber.interrupt(fiber);
        expect(yield* portReservations.find(realRoot, id, "api")).toBeUndefined();
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
);

it.live(
  "a stack-wide destroy retains a dedicated row; a cleanup failure keeps it, and the next destroy, once resolved, releases it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-defer-destroy-" });
        const id = `defer-destroy-${randomUUID()}`;
        const state = yield* makeTestState(`${root}/state`);
        const saved = {
          id,
          runtime: "native" as const,
          identity: { projectRoot: root, branchContext: "test", stackName: id },
          instances: [],
          lifetime: "detached" as const,
          composition: { members: [], dependencies: [] },
        };
        yield* state.save(saved);

        // Fails removing the stack's scratch directory on the first attempt only, standing in for
        // any concrete cleanup failure (an unreachable engine, a locked file, and so on); resolved
        // for the retry once the uncertainty would realistically have cleared.
        const scratch = path.join(root, "data", CONTAINER_ENV_DIRNAME);
        let resolved = false;
        const unreliableFileSystem = Layer.effect(
          FileSystem.FileSystem,
          Effect.map(FileSystem.FileSystem, (real) =>
            FileSystem.FileSystem.of({
              ...real,
              remove: (target, options) =>
                Effect.suspend(() =>
                  target === scratch && !resolved
                    ? Effect.fail(
                        systemError({
                          _tag: "PermissionDenied",
                          module: "test",
                          method: "remove",
                          description: "Injected cleanup failure",
                        }),
                      )
                    : real.remove(target, options),
                ),
            }),
          ),
        ).pipe(Layer.provide(NodeFileSystem.layer));

        const owner = yield* ownerFor({
          saved,
          state,
          root: `${root}/data`,
          cacheRoot: `${root}/cache`,
        }).pipe(Effect.provide(unreliableFileSystem));
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            resolved = true;
            yield* owner.namespace.destroy;
          }).pipe(Effect.ignore),
        );
        // Composing reserves every member's public port up front (including a lazy one like
        // mail), with no member ever started: a real reservation with no native artifact needed,
        // so this runs on every platform, Windows included.
        const definitions = yield* owner.rpc.supabaseComposition({
          services: [{ service: "mail", config: {}, endpoints: { http: { port: "auto" } } }],
        });
        const mail = definitions.find((entry) => entry.creation.service === "mail");
        if (mail === undefined) return yield* Effect.die("mail missing from the composition");

        const realStateRoot = yield* fs.realPath(`${root}/state`);
        const portReservations = yield* PortReservations.Service.pipe(
          Effect.provide(PortReservations.layer),
        );
        expect(yield* portReservations.find(realStateRoot, id, `${mail.id}:http`)).toBeDefined();

        const firstAttempt = yield* owner.namespace.destroy.pipe(Effect.exit);
        expect(firstAttempt._tag).toBe("Failure");
        // Retained: the row survives a destroy that could not confirm nothing remains.
        expect(yield* portReservations.find(realStateRoot, id, `${mail.id}:http`)).toBeDefined();

        resolved = true;
        yield* owner.namespace.destroy;
        expect(yield* portReservations.find(realStateRoot, id, `${mail.id}:http`)).toBeUndefined();
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          Layer.merge(
            NodeHttpClient.layerNodeHttp,
            PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
          ),
        ),
      ),
    ),
);

it.live("a destroy that cannot remove the registration keeps every reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "stack-destroy-remove-fails-" });
      const id = `destroy-remove-fails-${randomUUID()}`;
      const state = yield* makeTestState(`${root}/state`);
      const saved = {
        id,
        runtime: "native" as const,
        identity: { projectRoot: root, branchContext: "test", stackName: id },
        instances: [],
        lifetime: "detached" as const,
        composition: { members: [], dependencies: [] },
      };
      yield* state.save(saved);
      let removable = false;
      const unremovableState: StackNamespace.Interface = {
        ...state,
        remove: (target) =>
          removable
            ? state.remove(target)
            : Effect.fail(
                new StackNamespace.NamespaceError({
                  operation: "remove",
                  message: "injected failure",
                }),
              ),
      };
      const owner = yield* ownerFor({
        saved,
        state: unremovableState,
        root: `${root}/data`,
        cacheRoot: `${root}/cache`,
      });
      yield* Effect.addFinalizer(() =>
        Effect.suspend(() => {
          removable = true;
          return owner.namespace.destroy;
        }).pipe(Effect.ignore),
      );
      const definitions = yield* owner.rpc.supabaseComposition({
        services: [{ service: "mail", config: {}, endpoints: { http: { port: "auto" } } }],
      });
      const mail = definitions.find((entry) => entry.creation.service === "mail");
      if (mail === undefined) return yield* Effect.die("mail missing from the composition");
      const realStateRoot = yield* fs.realPath(`${root}/state`);
      const portReservations = yield* PortReservations.Service.pipe(
        Effect.provide(PortReservations.layer),
      );
      const assigned = yield* portReservations.find(realStateRoot, id, `${mail.id}:http`);
      expect(assigned).toBeDefined();

      const failed = yield* owner.namespace.destroy.pipe(Effect.exit);

      expect(failed._tag).toBe("Failure");
      expect(yield* portReservations.find(realStateRoot, id, `${mail.id}:http`)).toBe(assigned);
    }),
  ).pipe(
    Effect.provide(
      Layer.merge(
        NodeServices.layer,
        Layer.merge(
          NodeHttpClient.layerNodeHttp,
          PortReservations.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  ),
);

it.live("reserveNativePort skips a port a wildcard listener already holds", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const blocked = yield* bindNativeWildcard();
      yield* Effect.addFinalizer(() =>
        Effect.callback<void>((resume) => {
          blocked.server.close(() => resume(Effect.void));
        }),
      );
      // A key whose hash-seeded first candidate is exactly the blocked port, so the scan must skip
      // past the wildcard listener instead of merely missing it by chance.
      const key = keyWithFirstCandidate(blocked.port);

      const reserved = yield* reserveNativePort(key, new Set());
      expect(reserved.port).not.toBe(blocked.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("reserveNativePort excludes a port a previous attempt lost from the next reservation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const key = `native-exclude-${randomUUID()}`;
      const firstScope = yield* Scope.make();
      const first = yield* reserveNativePort(key, new Set()).pipe(
        Effect.provideService(Scope.Scope, firstScope),
      );
      yield* Scope.close(firstScope, Exit.void);

      const second = yield* reserveNativePort(key, new Set([first.port]));
      expect(second.port).not.toBe(first.port);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
