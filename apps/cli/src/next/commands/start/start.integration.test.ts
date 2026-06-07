import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Layer } from "effect";
import type { StackServiceStatus } from "@supabase/stack";
import { DEFAULT_VERSIONS, stackMetadata, type StackInfo } from "@supabase/stack/effect";
import { start } from "./start.handler.ts";
import { StartVersionState } from "./start.command.ts";
import { startForegroundWithStopSignal } from "./flows/foreground.flow.ts";
import type { ResolvedServiceVersionContext } from "../../config/service-version-resolution.ts";
import {
  emptyEnv,
  mockAnalytics,
  mockInk,
  mockOutput,
  mockProjectLocalServiceVersions,
  mockStateManager,
  mockStack,
} from "../../../../tests/helpers/mocks.ts";

const foregroundFlags = {
  stack: "default",
  mode: "auto" as const,
  exclude: [],
  serviceVersion: [],
  detach: false,
};
const backgroundFlags = {
  stack: "default",
  mode: "auto" as const,
  exclude: [],
  serviceVersion: [],
  detach: true,
};

function mockStartVersionState(
  opts: {
    metadata?: ReturnType<typeof stackMetadata>;
    serviceVersionContext?: Partial<ResolvedServiceVersionContext>;
  } = {},
) {
  return Layer.succeed(
    StartVersionState,
    StartVersionState.of({
      metadata:
        opts.metadata ??
        stackMetadata({
          ports: {
            apiPort: 54321,
            dbPort: 54322,
            authPort: 54323,
            postgrestPort: 54324,
            postgrestAdminPort: 54325,
            edgeRuntimePort: 54337,
            edgeRuntimeInspectorPort: 54338,
            realtimePort: 54326,
            storagePort: 54327,
            imgproxyPort: 54328,
            mailpitPort: 54329,
            mailpitSmtpPort: 54330,
            mailpitPop3Port: 54331,
            pgmetaPort: 54332,
            studioPort: 54333,
            analyticsPort: 54334,
            poolerPort: 54335,
            poolerApiPort: 54336,
          },
          services: {
            postgres: "17.6.1.081",
            postgrest: "14.5",
            auth: "2.188.0-rc.15",
            "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
            realtime: "2.78.10",
            storage: "1.41.8",
            imgproxy: "v3.8.0",
            mailpit: "v1.22.3",
            pgmeta: "0.96.1",
            studio: "2026.03.04-sha-0043607",
            analytics: "1.34.7",
            vector: "0.28.1-alpine",
            pooler: "2.7.4",
          },
          launch: { mode: "auto", excludedServices: [] },
        }),
      serviceVersionContext: {
        candidateBaseline: {
          postgres: "17.6.1.081",
          postgrest: "14.5",
          auth: "2.188.0-rc.15",
          "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
          realtime: "2.78.10",
          storage: "1.41.8",
          imgproxy: "v3.8.0",
          mailpit: "v1.22.3",
          pgmeta: "0.96.1",
          studio: "2026.03.04-sha-0043607",
          analytics: "1.34.7",
          vector: "0.28.1-alpine",
          pooler: "2.7.4",
        },
        pinnedBaseline: {
          postgres: "17.6.1.081",
          postgrest: "14.5",
          auth: "2.188.0-rc.15",
          "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
          realtime: "2.78.10",
          storage: "1.41.8",
          imgproxy: "v3.8.0",
          mailpit: "v1.22.3",
          pgmeta: "0.96.1",
          studio: "2026.03.04-sha-0043607",
          analytics: "1.34.7",
          vector: "0.28.1-alpine",
          pooler: "2.7.4",
        },
        runtimeVersions: {
          postgres: "17.6.1.081",
          postgrest: "14.5",
          auth: "2.188.0-rc.15",
          "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
          realtime: "2.78.10",
          storage: "1.41.8",
          imgproxy: "v3.8.0",
          mailpit: "v1.22.3",
          pgmeta: "0.96.1",
          studio: "2026.03.04-sha-0043607",
          analytics: "1.34.7",
          vector: "0.28.1-alpine",
          pooler: "2.7.4",
        },
        activeOverrides: [],
        availableUpdates: [],
        updateFingerprint: undefined,
        ...opts.serviceVersionContext,
      },
    }),
  );
}

function setupInteractive(
  opts: {
    info?: Partial<StackInfo>;
    startError?: unknown;
    startPending?: boolean;
    manualExit?: boolean;
  } = {},
) {
  const stack = mockStack({
    info: opts.info,
    startError: opts.startError,
    startPending: opts.startPending,
  });
  const analytics = mockAnalytics();
  const out = mockOutput({ format: "text", interactive: true });
  const ink = mockInk({ manualExit: opts.manualExit });
  const layer = Layer.mergeAll(
    emptyEnv(),
    stack.layer,
    analytics.layer,
    out.layer,
    ink.layer,
    mockStartVersionState(),
  );
  return { layer, stack, out, ink, analytics };
}

function setupNonInteractive(
  opts: {
    info?: Partial<StackInfo>;
    stateChanges?: Array<{ name: string; status: StackServiceStatus }>;
  } = {},
) {
  const stack = mockStack({ info: opts.info, stateChanges: opts.stateChanges });
  const analytics = mockAnalytics();
  const out = mockOutput({ format: "text", interactive: false });
  const ink = mockInk();
  const layer = Layer.mergeAll(
    emptyEnv(),
    stack.layer,
    analytics.layer,
    out.layer,
    ink.layer,
    mockStartVersionState(),
  );
  return { layer, stack, out, ink, analytics };
}

const waitFor = Effect.fnUntraced(function* (
  condition: () => boolean,
  message: string,
  attempts = 50,
) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (condition()) {
      return;
    }
    yield* Effect.sleep("1 millis");
  }
  throw new Error(message);
});

describe("start", () => {
  it.live("runs detached mode in the background and prints connection info", () => {
    const { layer, stack, out, ink, analytics } = setupNonInteractive();
    return Effect.gen(function* () {
      yield* start(backgroundFlags);

      expect(stack.started).toBe(true);
      expect(analytics.captured).toContainEqual({
        event: "cli_stack_started",
        properties: {
          mode: "auto",
          detach: true,
          stack: "default",
        },
      });
      expect(ink.rendered).toBe(false);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "success", message: "Local Supabase started" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "outro", message: "Local Supabase stack is ready." }),
      );

      const infoMessages = out.messages.filter((message) => message.type === "info");
      expect(infoMessages).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("API URL:") }),
      );
      expect(infoMessages).toContainEqual(
        expect.objectContaining({ message: expect.stringContaining("DB URL:") }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts explicit docker mode for detached start", () => {
    const { layer, stack } = setupNonInteractive();
    return Effect.gen(function* () {
      yield* start({
        ...backgroundFlags,
        mode: "docker",
      });

      expect(stack.started).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("accepts explicit native mode for detached start", () => {
    const { layer, stack } = setupNonInteractive();
    return Effect.gen(function* () {
      yield* start({
        ...backgroundFlags,
        mode: "native",
      });

      expect(stack.started).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs foreground mode with Ink and disposes the stack on exit", () => {
    const { layer, stack, ink } = setupInteractive({ startPending: true, manualExit: true });
    return Effect.gen(function* () {
      const fiber = yield* start(foregroundFlags).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(() => ink.rendered, "dashboard did not render");
      stack.resolveStart();
      ink.exit();
      yield* Fiber.join(fiber);

      expect(stack.started).toBe(true);
      expect(stack.stopped).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("propagates foreground startup failures", () => {
    const { layer, stack } = setupInteractive({ startError: new Error("startup failed") });
    return Effect.gen(function* () {
      const exit = yield* start(foregroundFlags).pipe(Effect.exit);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(stack.started).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("runs non-interactive mode and streams service state updates", () => {
    const { layer, stack, out, ink } = setupNonInteractive({
      stateChanges: [{ name: "postgres", status: "Healthy" }],
    });
    return Effect.gen(function* () {
      yield* start(foregroundFlags);

      expect(ink.rendered).toBe(false);
      expect(stack.started).toBe(true);
      expect(stack.stopped).toBe(true);
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "postgres: Healthy" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("shows Downloading updates before services become healthy", () => {
    const { layer, out } = setupNonInteractive({
      stateChanges: [
        { name: "postgres", status: "Downloading" },
        { name: "postgres", status: "Healthy" },
      ],
    });

    return Effect.gen(function* () {
      yield* start(foregroundFlags);

      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "postgres: Downloading" }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({ type: "info", message: "postgres: Healthy" }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("treats a stop signal as a successful foreground exit", () => {
    const { layer, stack, ink } = setupInteractive({ manualExit: true });
    return Effect.gen(function* () {
      const stopRequested = yield* Deferred.make<void>();
      const fiber = yield* startForegroundWithStopSignal(Deferred.await(stopRequested)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );

      yield* waitFor(() => ink.rendered, "dashboard did not render");
      yield* Deferred.succeed(stopRequested, void 0);

      const exit = yield* Fiber.await(fiber);
      expect(Exit.isSuccess(exit)).toBe(true);
      expect(stack.stopped).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when newer linked or default versions are available for the pinned stack", () => {
    const { stack, ink } = setupNonInteractive();
    const analytics = mockAnalytics();
    const out = mockOutput({ format: "text", interactive: false });
    const layer = Layer.mergeAll(
      emptyEnv(),
      stack.layer,
      analytics.layer,
      out.layer,
      ink.layer,
      mockStartVersionState({
        metadata: stackMetadata({
          ports: {
            apiPort: 54321,
            dbPort: 54322,
            authPort: 54323,
            postgrestPort: 54324,
            postgrestAdminPort: 54325,
            edgeRuntimePort: 54337,
            edgeRuntimeInspectorPort: 54338,
            realtimePort: 54326,
            storagePort: 54327,
            imgproxyPort: 54328,
            mailpitPort: 54329,
            mailpitSmtpPort: 54330,
            mailpitPop3Port: 54331,
            pgmetaPort: 54332,
            studioPort: 54333,
            analyticsPort: 54334,
            poolerPort: 54335,
            poolerApiPort: 54336,
          },
          services: {
            postgres: "17.6.1.081",
            postgrest: "14.5",
            auth: "2.187.0",
            "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
            realtime: "2.78.10",
            storage: "1.41.8",
            imgproxy: "v3.8.0",
            mailpit: "v1.22.3",
            pgmeta: "0.96.1",
            studio: "2026.03.04-sha-0043607",
            analytics: "1.34.7",
            vector: "0.28.1-alpine",
            pooler: "2.7.4",
          },
          launch: { mode: "auto", excludedServices: [] },
        }),
        serviceVersionContext: {
          availableUpdates: [
            {
              service: "auth",
              pinnedVersion: "2.187.0",
              availableVersion: "2.190.0",
            },
          ],
          updateFingerprint: "auth:2.187.0->2.190.0",
        },
      }),
      mockStateManager({
        metadata: [
          {
            name: "default",
            metadata: stackMetadata({
              ports: {
                apiPort: 54321,
                dbPort: 54322,
                authPort: 54323,
                postgrestPort: 54324,
                postgrestAdminPort: 54325,
                edgeRuntimePort: 54337,
                edgeRuntimeInspectorPort: 54338,
                realtimePort: 54326,
                storagePort: 54327,
                imgproxyPort: 54328,
                mailpitPort: 54329,
                mailpitSmtpPort: 54330,
                mailpitPop3Port: 54331,
                pgmetaPort: 54332,
                studioPort: 54333,
                analyticsPort: 54334,
                poolerPort: 54335,
                poolerApiPort: 54336,
              },
              services: {
                postgres: "17.6.1.081",
                postgrest: "14.5",
                auth: "2.187.0",
                "edge-runtime": DEFAULT_VERSIONS["edge-runtime"],
                realtime: "2.78.10",
                storage: "1.41.8",
                imgproxy: "v3.8.0",
                mailpit: "v1.22.3",
                pgmeta: "0.96.1",
                studio: "2026.03.04-sha-0043607",
                analytics: "1.34.7",
                vector: "0.28.1-alpine",
                pooler: "2.7.4",
              },
              launch: { mode: "auto", excludedServices: [] },
            }),
          },
        ],
      }),
    );

    return Effect.gen(function* () {
      yield* start(backgroundFlags);
      yield* waitFor(
        () =>
          out.messages.some(
            (message) =>
              message.type === "warn" &&
              message.message.includes("Updated linked or default service versions are available"),
          ),
        "update warning did not render",
      );

      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("auth: 2.187.0 -> 2.190.0"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when local service version overrides are active", () => {
    const { stack, ink } = setupNonInteractive();
    const analytics = mockAnalytics();
    const out = mockOutput({ format: "text", interactive: false });
    const layer = Layer.mergeAll(
      emptyEnv(),
      stack.layer,
      analytics.layer,
      out.layer,
      ink.layer,
      mockStartVersionState({
        serviceVersionContext: {
          activeOverrides: [{ service: "storage", version: "1.40.0", source: "local" }],
        },
      }),
      mockProjectLocalServiceVersions({
        updatedAt: "2026-03-20T12:00:00.000Z",
        versions: {
          storage: "1.40.0",
        },
      }),
    );

    return Effect.gen(function* () {
      yield* start(backgroundFlags);
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("Local service version overrides are active"),
        }),
      );
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("storage: 1.40.0 [local]"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("warns when one-off flag overrides are active", () => {
    const { stack, ink } = setupNonInteractive();
    const analytics = mockAnalytics();
    const out = mockOutput({ format: "text", interactive: false });
    const layer = Layer.mergeAll(
      emptyEnv(),
      stack.layer,
      analytics.layer,
      out.layer,
      ink.layer,
      mockStartVersionState({
        serviceVersionContext: {
          activeOverrides: [{ service: "auth", version: "2.180.0", source: "flag" }],
        },
      }),
    );

    return Effect.gen(function* () {
      yield* start({
        ...backgroundFlags,
        serviceVersion: ["auth=v2.180.0"],
      });
      expect(out.messages).toContainEqual(
        expect.objectContaining({
          type: "warn",
          message: expect.stringContaining("auth: 2.180.0 [flag]"),
        }),
      );
    }).pipe(Effect.provide(layer));
  });
});
