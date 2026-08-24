import { describe, expect, it, vi } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import process from "node:process";
import {
  Clock,
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Schema,
  Tracer,
} from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import { TelemetryConfigSchema, type TelemetryConfig } from "./types.ts";
import { mockProjectContext, mockRuntimeInfo, mockTty } from "../../../tests/helpers/mocks.ts";
import { tracingLayer } from "./tracing.layer.ts";

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const fsLayer = BunServices.layer;

const makeTempDir = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.makeTempDirectory({ prefix: "supabase-tracing-test-" });
});

const pathJoin = (...parts: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    return path.join(...parts);
  });

const pathExists = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.exists(pathname);
  });

const readText = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(pathname);
  });

const readNames = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readDirectory(pathname);
  });

const removePath = (pathname: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(pathname, { recursive: true, force: true });
  }).pipe(Effect.ignore);

const writeConfig = (dir: string, config: TelemetryConfig) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(TelemetryConfigSchema))(
      config,
    );
    yield* fs.makeDirectory(dir, { recursive: true });
    yield* fs.writeFileString(path.join(dir, "telemetry.json"), encoded);
  });

const decodeTelemetryConfig = (content: string) =>
  Schema.decodeEffect(Schema.fromJsonString(TelemetryConfigSchema))(content);

const withHome = <A, E, R>(use: (home: string) => Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const home = yield* makeTempDir;
    return yield* use(home).pipe(Effect.ensuring(removePath(home)));
  }).pipe(Effect.provide(fsLayer));

// ---------------------------------------------------------------------------
// Layer builder helpers
// ---------------------------------------------------------------------------

function buildLayer(opts: {
  home: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
  fsLayer?: Layer.Layer<FileSystem.FileSystem>;
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
  const projectContextLayer = mockProjectContext({
    projectEnv: Option.some({
      paths: {
        projectRoot: opts.home,
        supabaseDir: `${opts.home}/supabase`,
        configPath: `${opts.home}/supabase/config.toml`,
        envPath: `${opts.home}/supabase/.env`,
        envLocalPath: `${opts.home}/supabase/.env.local`,
      },
      values: env,
      loadedPaths: [],
      sources: {},
    }),
  });
  const configLayer = cliConfigLayer.pipe(
    Layer.provide(runtimeInfoLayer),
    Layer.provide(projectContextLayer),
    Layer.provideMerge(BunServices.layer),
  );
  return Layer.mergeAll(
    runtimeInfoLayer,
    projectContextLayer,
    configLayer,
    ConfigProvider.layer(ConfigProvider.fromEnv({ env })),
    mockTty({
      stdoutIsTty: opts.stdoutIsTty ?? false,
      stdinIsTty: false,
    }),
    opts.fsLayer ?? fsLayer,
  );
}

function gatedFileSystem(opts: {
  writeStarted: Deferred.Deferred<void>;
  releaseWrite: Deferred.Deferred<void>;
  writeFinished: Deferred.Deferred<void>;
  setCompletedBeforeScopeClose: (value: boolean) => void;
  isScopeClosed: () => boolean;
}) {
  return Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const base = yield* FileSystem.FileSystem;
      return FileSystem.make({
        ...base,
        open: (pathname, options) =>
          base.open(pathname, options).pipe(
            Effect.map((file) =>
              pathname.endsWith(".ndjson")
                ? {
                    ...file,
                    writeAll: (data: Uint8Array) =>
                      Effect.gen(function* () {
                        yield* Deferred.succeed(opts.writeStarted, undefined);
                        yield* Deferred.await(opts.releaseWrite);
                        yield* Effect.yieldNow;
                        yield* file.writeAll(data);
                        opts.setCompletedBeforeScopeClose(!opts.isScopeClosed());
                        yield* Deferred.succeed(opts.writeFinished, undefined);
                      }),
                  }
                : file,
            ),
          ),
      });
    }).pipe(Effect.provide(BunServices.layer)),
  );
}

function buildTracingLayer(opts: {
  home: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
  fsLayer?: Layer.Layer<FileSystem.FileSystem>;
}) {
  return tracingLayer.pipe(Layer.provide(buildLayer(opts)));
}

// ---------------------------------------------------------------------------
// Span factory helper (mirrors ExportableSpan constructor options)
// ---------------------------------------------------------------------------

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

const endSpan = (span: Tracer.Span, offsetMs: number) =>
  Effect.map(Clock.currentTimeMillis, (now) => {
    span.end(BigInt(now + offsetMs) * 1_000_000n, Exit.void);
  });

// ---------------------------------------------------------------------------
// Layer construction & first-run
// ---------------------------------------------------------------------------

describe("tracingLayer – layer construction & first-run", () => {
  it.live("first-run TTY: creates telemetry.json with consent=granted", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.provide(buildTracingLayer({ home, stdoutIsTty: true })));
        const configPath = yield* pathJoin(home, ".supabase", "telemetry.json");
        expect(yield* pathExists(configPath)).toBe(true);
        const config = yield* decodeTelemetryConfig(yield* readText(configPath));
        expect(config.consent).toBe("granted");
        expect(config.device_id.length).toBeGreaterThan(0);
        expect(config.session_id.length).toBeGreaterThan(0);
      }),
    );
  });

  it.live("first-run non-TTY: creates telemetry.json with consent=granted", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.void.pipe(Effect.provide(buildTracingLayer({ home, stdoutIsTty: false })));
        const configPath = yield* pathJoin(home, ".supabase", "telemetry.json");
        expect(yield* pathExists(configPath)).toBe(true);
        const config = yield* decodeTelemetryConfig(yield* readText(configPath));
        expect(config.consent).toBe("granted");
      }),
    );
  });

  it.live("existing config with consent=granted: layer builds and tracer is usable", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* writeConfig(yield* pathJoin(home, ".supabase"), {
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
      }),
    );
  });

  it.live(
    "SUPABASE_TELEMETRY_DISABLED=1 overrides consent=granted: no NDJSON export on span end",
    () => {
      return withHome((home) =>
        Effect.gen(function* () {
          const configDir = yield* pathJoin(home, ".supabase");
          yield* writeConfig(configDir, {
            consent: "granted",
            device_id: "existing-device",
            session_id: "existing-session",
            session_last_active: yield* Clock.currentTimeMillis,
          });
          yield* Effect.gen(function* () {
            const tracer = yield* Tracer.Tracer;
            const span = tracer.span(yield* makeSpanOptions());
            yield* endSpan(span, 100);
          }).pipe(
            Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
          );
          const tracesDir = yield* pathJoin(configDir, "traces");
          const hasNdjson =
            (yield* pathExists(tracesDir)) &&
            (yield* readNames(tracesDir)).some((f) => f.endsWith(".ndjson"));
          expect(hasNdjson).toBe(false);
        }),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Span behaviour
// ---------------------------------------------------------------------------

describe("tracingLayer – span behaviour", () => {
  it.live("span creation attaches global attributes", () => {
    return withHome((home) =>
      Effect.gen(function* () {
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
      }).pipe(Effect.provide(buildTracingLayer({ home }))),
    );
  });

  it.live("span end exports to NDJSON file when consent=granted", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions());
          yield* endSpan(span, 100);
        }).pipe(Effect.provide(buildTracingLayer({ home })));
        const tracesDir = yield* pathJoin(home, ".supabase", "traces");
        const hasNdjson =
          (yield* pathExists(tracesDir)) &&
          (yield* readNames(tracesDir)).some((f) => f.endsWith(".ndjson"));
        expect(hasNdjson).toBe(true);
      }),
    );
  });

  it.live("drains NDJSON exports before the tracing scope closes", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const writeStarted = yield* Deferred.make<void>();
        const releaseWrite = yield* Deferred.make<void>();
        const writeFinished = yield* Deferred.make<void>();
        let scopeClosed = false;
        let completedBeforeScopeClose = false;
        const fs = gatedFileSystem({
          writeStarted,
          releaseWrite,
          writeFinished,
          isScopeClosed: () => scopeClosed,
          setCompletedBeforeScopeClose: (value) => {
            completedBeforeScopeClose = value;
          },
        });

        yield* Effect.scoped(
          Effect.gen(function* () {
            const tracer = yield* Tracer.Tracer;
            const span = tracer.span(yield* makeSpanOptions({ name: "drained-span" }));
            yield* endSpan(span, 100);
            yield* Deferred.await(writeStarted);
            yield* Deferred.succeed(releaseWrite, undefined);
          }).pipe(Effect.provide(buildTracingLayer({ home, fsLayer: fs }))),
        );

        scopeClosed = true;
        yield* Deferred.await(writeFinished);
        expect(completedBeforeScopeClose).toBe(true);
      }),
    );
  });

  it.live("does not write API keys to trace files", () => {
    const secretKey = `sb_secret_${"a".repeat(40)}`;
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions());
          span.attribute("http.request.header.apikey", secretKey);
          yield* endSpan(span, 100);
        }).pipe(Effect.provide(buildTracingLayer({ home })));
        const tracesDir = yield* pathJoin(home, ".supabase", "traces");
        const traceFile = (yield* readNames(tracesDir)).find((file) => file.endsWith(".ndjson"));
        expect(traceFile).toBeDefined();
        const trace = yield* readText(yield* pathJoin(tracesDir, traceFile ?? ""));
        expect(trace).not.toContain(secretKey);
        expect(trace).not.toContain("http.request.header.apikey");
      }),
    );
  });

  it.live("span end does NOT export to NDJSON when SUPABASE_TELEMETRY_DISABLED=1", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions());
          yield* endSpan(span, 100);
        }).pipe(
          Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
        );
        const tracesDir = yield* pathJoin(home, ".supabase", "traces");
        const hasNdjson =
          (yield* pathExists(tracesDir)) &&
          (yield* readNames(tracesDir)).some((f) => f.endsWith(".ndjson"));
        expect(hasNdjson).toBe(false);
      }),
    );
  });

  it.live("span end exports to debug console when SUPABASE_DEBUG=1", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const stderrChunks: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = vi.fn((chunk: unknown) => {
          stderrChunks.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions({ name: "debug-span" }));
          yield* endSpan(span, 50);
        }).pipe(Effect.provide(buildTracingLayer({ home, env: { SUPABASE_DEBUG: "1" } })));
        process.stderr.write = originalWrite;
        expect(stderrChunks.join("")).toContain("debug-span");
      }),
    );
  });

  it.live("span end exports to debug console when SUPABASE_TELEMETRY_DEBUG=1", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const stderrChunks: string[] = [];
        const originalWrite = process.stderr.write.bind(process.stderr);
        process.stderr.write = vi.fn((chunk: unknown) => {
          stderrChunks.push(String(chunk));
          return true;
        }) as typeof process.stderr.write;
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions({ name: "telemetry-debug-span" }));
          yield* endSpan(span, 50);
        }).pipe(
          Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DEBUG: "1" } })),
        );
        process.stderr.write = originalWrite;
        expect(stderrChunks.join("")).toContain("telemetry-debug-span");
      }),
    );
  });

  it.live("span end skips unsampled spans – no NDJSON export", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const tracer = yield* Tracer.Tracer;
          const span = tracer.span(yield* makeSpanOptions({ sampled: false }));
          yield* endSpan(span, 100);
        }).pipe(Effect.provide(buildTracingLayer({ home })));
        const tracesDir = yield* pathJoin(home, ".supabase", "traces");
        const hasNdjson =
          (yield* pathExists(tracesDir)) &&
          (yield* readNames(tracesDir)).some((f) => f.endsWith(".ndjson"));
        expect(hasNdjson).toBe(false);
      }),
    );
  });

  it.live("CI detection via CI env var sets is_ci=true on span", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        expect(span.attributes.get("is_ci")).toBe(true);
      }).pipe(Effect.provide(buildTracingLayer({ home, env: { CI: "true" } }))),
    );
  });
});

// ---------------------------------------------------------------------------
// ExportableSpan unit tests
// ---------------------------------------------------------------------------

describe("ExportableSpan unit tests", () => {
  it.live("child span inherits traceId from parent span", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const parent = tracer.span(yield* makeSpanOptions({ name: "parent" }));
        const child = tracer.span(
          yield* makeSpanOptions({ name: "child", parent: Option.some(parent) }),
        );
        expect(child.traceId).toBe(parent.traceId);
      }).pipe(Effect.provide(buildTracingLayer({ home }))),
    );
  });

  it.live("event() and addLinks() are no-ops that do not throw", () => {
    return withHome((home) =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        yield* Effect.map(Clock.currentTimeMillis, (now) => {
          span.event("test-event", BigInt(now) * 1_000_000n, { key: "val" });
        });
        span.addLinks([]);
      }).pipe(Effect.provide(buildTracingLayer({ home }))),
    );
  });

  it.live("span without parent generates 32-char hex traceId and 16-char hex spanId", () => {
    const HEX_32 = /^[0-9a-f]{32}$/;
    const HEX_16 = /^[0-9a-f]{16}$/;
    return withHome((home) =>
      Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(yield* makeSpanOptions());
        expect(span.traceId).toMatch(HEX_32);
        expect(span.spanId).toMatch(HEX_16);
      }).pipe(Effect.provide(buildTracingLayer({ home }))),
    );
  });
});
