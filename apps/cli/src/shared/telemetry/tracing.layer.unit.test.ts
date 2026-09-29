import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Fiber,
  Layer,
  Option,
  Path,
  PlatformError,
  Schema,
  Sink,
  Stdio,
  Tracer,
} from "effect";
import { TestClock } from "effect/testing";
import { CliSettings } from "../config/cli-settings.service.ts";
import { TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";
import { useTempWorkdir } from "../../../tests/helpers/command-mocks.ts";
import { mockCliProjectContext, mockRuntimeInfo, mockTty } from "../../../tests/helpers/mocks.ts";
import { tracingLayer } from "./tracing.layer.ts";

const fsLayer = BunServices.layer;

const tempRoot = useTempWorkdir("supabase-tracing-test-");

const TelemetryConfigJson = Schema.fromJsonString(TelemetryConfigSchema);

const writeConfig = (dir: string, config: TelemetryConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(
      path.join(dir, "telemetry.json"),
      yield* Schema.encodeEffect(TelemetryConfigJson)(config),
    );
  });

const readConfig = (configPath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeEffect(TelemetryConfigJson)(yield* fs.readFileString(configPath));
  });

const hasNdjsonTrace = (tracesDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    if (!(yield* fs.exists(tracesDir))) return false;
    return (yield* fs.readDirectory(tracesDir)).some((file) => file.endsWith(".ndjson"));
  });

const readTraceFile = (tracesDir: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const traceFile = (yield* fs.readDirectory(tracesDir)).find((file) => file.endsWith(".ndjson"));
    expect(traceFile).toBeDefined();
    return yield* fs.readFileString(path.join(tracesDir, traceFile!));
  });

function buildLayer(opts: {
  home: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
  fileSystem?: Layer.Layer<FileSystem.FileSystem>;
  stdio?: Layer.Layer<Stdio.Stdio>;
}) {
  const env: Record<string, string> = {
    HOME: opts.home,
    ...opts.env,
  };
  const runtimeInfoLayer = mockRuntimeInfo({
    homeDir: opts.home,
    cwd: opts.home,
    platform: "linux",
    arch: "x64",
  });
  const cliProjectContextLayer = mockCliProjectContext();
  const setting = (key: string) => {
    const value = opts.env?.[key];
    return value === undefined ? Option.none<string>() : Option.some(value);
  };
  const settingsLayer = Layer.effect(
    CliSettings,
    Effect.gen(function* () {
      const path = yield* Path.Path;
      return CliSettings.of({
        apiUrl: "https://api.supabase.com",
        dashboardUrl: "https://supabase.com/dashboard",
        projectHost: "supabase.co",
        telemetryPosthogHost: "https://eu.i.posthog.com",
        telemetryPosthogKey: Option.none(),
        accessToken: Option.none(),
        noKeyring: Option.none(),
        supabaseHome: path.join(opts.home, ".supabase"),
        debug: setting("SUPABASE_DEBUG"),
        telemetryDebug: setting("SUPABASE_TELEMETRY_DEBUG"),
        telemetryDisabled: setting("SUPABASE_TELEMETRY_DISABLED"),
        doNotTrack: Option.none(),
      });
    }),
  ).pipe(Layer.provide(fsLayer));
  return Layer.mergeAll(
    fsLayer,
    opts.fileSystem ?? Layer.empty,
    runtimeInfoLayer,
    cliProjectContextLayer,
    ConfigProvider.layer(ConfigProvider.fromEnvRecord(env, { preserveEmptyStrings: true })),
    settingsLayer,
    mockTty({
      stdoutIsTty: opts.stdoutIsTty ?? false,
      stdinIsTty: false,
    }),
    opts.stdio ?? Layer.empty,
  );
}

function buildTracingLayer(opts: {
  home: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
  fileSystem?: Layer.Layer<FileSystem.FileSystem>;
  stdio?: Layer.Layer<Stdio.Stdio>;
}) {
  return tracingLayer.pipe(Layer.provide(buildLayer(opts)));
}

function blockingFileSystemLayer(
  started: Deferred.Deferred<void>,
  release: Deferred.Deferred<void>,
  order: Array<string>,
  finished?: Deferred.Deferred<void>,
) {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return {
        ...fs,
        writeFileString: (
          filePath: string,
          content: string,
          options?: Parameters<FileSystem.FileSystem["writeFileString"]>[2],
        ): Effect.Effect<void, PlatformError.PlatformError> =>
          Effect.gen(function* () {
            if (!filePath.endsWith(".ndjson")) {
              yield* fs.writeFileString(filePath, content, options);
              return;
            }
            order.push("started");
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release);
            order.push("finished");
            if (finished !== undefined) yield* Deferred.succeed(finished, undefined);
          }),
      };
    }),
  ).pipe(Layer.provide(BunServices.layer));
}

function capturingStdio(chunks: Array<string>): Layer.Layer<Stdio.Stdio> {
  return Stdio.layerTest({
    stderr: () =>
      Sink.forEach((chunk: string | Uint8Array) =>
        Effect.sync(() =>
          chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk)),
        ),
      ),
  });
}

const makeSpanOptions = (
  overrides: Partial<{
    name: string;
    sampled: boolean;
    parent: Option.Option<Tracer.AnySpan>;
  }> = {},
) =>
  Effect.map(Clock.currentTimeMillis, (now) => ({
    name: overrides.name ?? "test-span",
    parent: overrides.parent ?? Option.none(),
    annotations: Context.empty(),
    links: [] as Tracer.SpanLink[],
    startTime: BigInt(now) * 1_000_000n,
    kind: "internal" as Tracer.SpanKind,
    root: false,
    sampled: overrides.sampled ?? true,
  }));

describe("tracingLayer – layer construction & first-run", () => {
  it.live("first-run TTY: creates telemetry.json with consent=granted", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      yield* Effect.void.pipe(Effect.provide(buildTracingLayer({ home, stdoutIsTty: true })));

      const configPath = path.join(configDir, "telemetry.json");
      expect(yield* fs.exists(configPath)).toBe(true);
      const config = yield* readConfig(configPath);
      expect(config.consent).toBe("granted");
      expect(typeof config.device_id).toBe("string");
      expect(config.device_id.length).toBeGreaterThan(0);
      expect(typeof config.session_id).toBe("string");
      expect(config.session_id.length).toBeGreaterThan(0);
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("first-run non-TTY: creates telemetry.json with consent=granted", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      yield* Effect.void.pipe(Effect.provide(buildTracingLayer({ home, stdoutIsTty: false })));

      const configPath = path.join(configDir, "telemetry.json");
      expect(yield* fs.exists(configPath)).toBe(true);
      const config = yield* readConfig(configPath);
      expect(config.consent).toBe("granted");
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("existing config with consent=granted: layer builds and tracer is usable", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      yield* writeConfig(configDir, {
        consent: "granted",
        device_id: "existing-device",
        session_id: "existing-session",
        session_last_active: yield* Clock.currentTimeMillis,
      });
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        expect(span).toBeDefined();
        expect(span.name).toBe("test-span");
      }).pipe(Effect.provide(buildTracingLayer({ home })));
    }).pipe(Effect.provide(fsLayer));
  });

  it.live(
    "SUPABASE_TELEMETRY_DISABLED=1 overrides consent=granted: no NDJSON export on span end",
    () => {
      const home = tempRoot.current;
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const configDir = path.join(home, ".supabase");
        const tracesDir = path.join(configDir, "traces");
        yield* writeConfig(configDir, {
          consent: "granted",
          device_id: "existing-device",
          session_id: "existing-session",
          session_last_active: yield* Clock.currentTimeMillis,
        });
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions());
          span.end(BigInt((yield* Clock.currentTimeMillis) + 100) * 1_000_000n, Exit.void);
        }).pipe(
          Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
        );

        expect(yield* hasNdjsonTrace(tracesDir)).toBe(false);
      }).pipe(Effect.provide(fsLayer));
    },
  );
});

describe("tracingLayer – span behaviour", () => {
  it.live("waits for a blocked exporter before closing its scope", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const run = Effect.scoped(
        Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          tracer.span(yield* makeSpanOptions()).end(1_000_000_000n, Exit.void);
        }).pipe(
          Effect.provide(
            buildTracingLayer({
              home,
              fileSystem: blockingFileSystemLayer(started, release, order),
            }),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(order).toEqual(["started"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiber);
      expect(order.length).toBeGreaterThan(0);
      expect(
        order.every(
          (entry, index) =>
            (entry === "started" && order[index + 1] === "finished") ||
            (entry === "finished" && order[index - 1] === "started"),
        ),
      ).toBe(true);
    });
  });

  it.live("drains a blocked exporter when the scoped program fails", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const run = Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        tracer.span(yield* makeSpanOptions()).end(1_000_000_000n, Exit.void);
        return yield* Effect.fail("injected program failure");
      }).pipe(
        Effect.provide(
          buildTracingLayer({
            home,
            fileSystem: blockingFileSystemLayer(started, release, order),
          }),
        ),
      );

      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      expect(fiber.pollUnsafe()).toBeUndefined();
      yield* Deferred.succeed(release, undefined);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(order.at(-1)).toBe("finished");
    });
  });

  it.live("drains a blocked exporter when the scoped program is interrupted", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const run = Effect.scoped(
        Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          tracer.span(yield* makeSpanOptions()).end(1_000_000_000n, Exit.void);
          return yield* Effect.never.pipe(
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          );
        }).pipe(
          Effect.provide(
            buildTracingLayer({
              home,
              fileSystem: blockingFileSystemLayer(started, release, order, finished),
            }),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      expect(fiber.pollUnsafe()).toBeUndefined();
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      yield* Deferred.await(interrupted);
      expect(order).toEqual(["started"]);
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(finished);
      yield* Fiber.join(interrupt);
      const exit = yield* Fiber.await(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(order.at(-1)).toBe("finished");
    });
  });

  it.effect("bounds shutdown when an exporter never completes", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const order: Array<string> = [];
      const run = Effect.scoped(
        Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          tracer.span(yield* makeSpanOptions()).end(1_000_000_000n, Exit.void);
        }).pipe(
          Effect.provide(
            buildTracingLayer({
              home,
              fileSystem: blockingFileSystemLayer(started, release, order),
            }),
          ),
        ),
      );

      const fiber = yield* Effect.forkChild(run);
      yield* Deferred.await(started);
      const result = yield* Fiber.await(fiber).pipe(Effect.forkChild);
      yield* TestClock.adjust(Duration.seconds(2));
      const exit = yield* Fiber.join(result);

      expect(Exit.isSuccess(exit)).toBe(true);
      expect(order).toEqual(["started"]);
    });
  });

  it.live("keeps exporting after debug formatting fails", () => {
    const home = tempRoot.current;
    const stderrChunks: string[] = [];
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const tracesDir = path.join(home, ".supabase", "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const badSpan = tracer.span(yield* makeSpanOptions({ name: "bad-debug-span" }));
        badSpan.attribute("cyclic", cyclic);
        badSpan.end(1_000_000_000n, Exit.void);
        tracer
          .span(yield* makeSpanOptions({ name: "good-debug-span" }))
          .end(1_000_000_000n, Exit.void);
      }).pipe(
        Effect.provide(
          buildTracingLayer({
            home,
            env: { SUPABASE_DEBUG: "1" },
            stdio: capturingStdio(stderrChunks),
          }),
        ),
      );

      const traces = yield* readTraceFile(tracesDir);
      expect(traces).toContain("good-debug-span");
      expect(stderrChunks.join(" ")).toContain("good-debug-span");
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("continues file export when debug output fails", () => {
    const home = tempRoot.current;
    const failure = PlatformError.systemError({
      _tag: "Unknown",
      module: "stderr",
      method: "write",
      description: "injected debug export failure",
      pathOrDescriptor: "stderr",
    });
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const tracesDir = path.join(home, ".supabase", "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        tracer
          .span(yield* makeSpanOptions())
          .end(BigInt(yield* Clock.currentTimeMillis) * 1_000_000n, Exit.void);
      }).pipe(
        Effect.provide(
          buildTracingLayer({
            home,
            env: { SUPABASE_TELEMETRY_DEBUG: "1" },
            stdio: Stdio.layerTest({ stderr: () => Sink.fail(failure) }),
          }),
        ),
      );

      expect(yield* hasNdjsonTrace(tracesDir)).toBe(true);
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("span creation attaches global attributes", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(yield* makeSpanOptions());
      expect(span.attributes.get("schema_version")).toBe(1);
      expect(typeof span.attributes.get("device_id")).toBe("string");
      expect(typeof span.attributes.get("session_id")).toBe("string");
      expect(typeof span.attributes.get("is_first_run")).toBe("boolean");
      expect(span.attributes.get("is_tty")).toBe(false);
      expect(typeof span.attributes.get("is_ci")).toBe("boolean");
      expect(span.attributes.get("os")).toBe("linux");
      expect(span.attributes.get("arch")).toBe("x64");
      expect(span.attributes.get("cli_version")).toBe("0.0.0-dev");
    }).pipe(Effect.provide(buildTracingLayer({ home })));
  });

  it.live("span end exports to debug console when SUPABASE_DEBUG=1", () => {
    const home = tempRoot.current;
    const stderrChunks: string[] = [];
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      tracer.span(yield* makeSpanOptions({ name: "debug-span" })).end(1_000_000_000n, Exit.void);
    }).pipe(
      Effect.provide(
        buildTracingLayer({
          home,
          env: { SUPABASE_DEBUG: "1" },
          stdio: capturingStdio(stderrChunks),
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          expect(stderrChunks.join(" ")).toContain("debug-span");
        }),
      ),
    );
  });

  it.live("span end exports to debug console when SUPABASE_TELEMETRY_DEBUG=1", () => {
    const home = tempRoot.current;
    const stderrChunks: string[] = [];
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      tracer
        .span(yield* makeSpanOptions({ name: "telemetry-debug-span" }))
        .end(1_000_000_000n, Exit.void);
    }).pipe(
      Effect.provide(
        buildTracingLayer({
          home,
          env: { SUPABASE_TELEMETRY_DEBUG: "1" },
          stdio: capturingStdio(stderrChunks),
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          expect(stderrChunks.join(" ")).toContain("telemetry-debug-span");
        }),
      ),
    );
  });

  it.live("span end exports to NDJSON file when consent=granted", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      const tracesDir = path.join(configDir, "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        span.end(BigInt((yield* Clock.currentTimeMillis) + 100) * 1_000_000n, Exit.void);
      }).pipe(Effect.provide(buildTracingLayer({ home })));

      expect(yield* hasNdjsonTrace(tracesDir)).toBe(true);
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("does not write API keys to trace files", () => {
    const home = tempRoot.current;
    const secretKey = `sb_secret_${"a".repeat(40)}`;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const tracesDir = path.join(home, ".supabase", "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        span.attribute("http.request.header.apikey", secretKey);
        span.end(BigInt((yield* Clock.currentTimeMillis) + 100) * 1_000_000n, Exit.void);
      }).pipe(Effect.provide(buildTracingLayer({ home })));

      const trace = yield* readTraceFile(tracesDir);
      expect(trace).not.toContain(secretKey);
      expect(trace).not.toContain("http.request.header.apikey");
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("span end does NOT export to NDJSON when SUPABASE_TELEMETRY_DISABLED=1", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      const tracesDir = path.join(configDir, "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        span.end(BigInt((yield* Clock.currentTimeMillis) + 100) * 1_000_000n, Exit.void);
      }).pipe(
        Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
      );

      expect(yield* hasNdjsonTrace(tracesDir)).toBe(false);
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("span end skips unsampled spans – no NDJSON export", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const configDir = path.join(home, ".supabase");
      const tracesDir = path.join(configDir, "traces");
      yield* Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions({ sampled: false }));
        span.end(BigInt((yield* Clock.currentTimeMillis) + 100) * 1_000_000n, Exit.void);
      }).pipe(Effect.provide(buildTracingLayer({ home })));

      expect(yield* hasNdjsonTrace(tracesDir)).toBe(false);
    }).pipe(Effect.provide(fsLayer));
  });

  it.live("CI detection via CI env var sets is_ci=true on span", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(yield* makeSpanOptions());
      expect(span.attributes.get("is_ci")).toBe(true);
    }).pipe(Effect.provide(buildTracingLayer({ home, env: { CI: "true" } })));
  });
});

describe("ExportableSpan unit tests", () => {
  it.live("child span inherits traceId from parent span", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const parent = tracer.span(yield* makeSpanOptions({ name: "parent" }));
      const child = tracer.span(
        yield* makeSpanOptions({ name: "child", parent: Option.some(parent) }),
      );
      expect(child.traceId).toBe(parent.traceId);
    }).pipe(Effect.provide(buildTracingLayer({ home })));
  });

  it.live("event() and addLinks() are no-ops that do not throw", () => {
    const home = tempRoot.current;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(yield* makeSpanOptions());
      span.event("test-event", BigInt(yield* Clock.currentTimeMillis) * 1_000_000n, { key: "val" });
      span.addLinks([]);
    }).pipe(Effect.provide(buildTracingLayer({ home })));
  });

  it.live("span without parent generates 32-char hex traceId and 16-char hex spanId", () => {
    const home = tempRoot.current;
    const HEX_32 = /^[0-9a-f]{32}$/;
    const HEX_16 = /^[0-9a-f]{16}$/;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(yield* makeSpanOptions());
      expect(span.traceId).toMatch(HEX_32);
      expect(span.spanId).toMatch(HEX_16);
    }).pipe(Effect.provide(buildTracingLayer({ home })));
  });
});
