import { describe, expect, it, vi } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { Effect, Exit, Layer, Option, ServiceMap, Tracer } from "effect";
import { cliConfigLayer } from "../../next/config/cli-config.layer.ts";
import type { TelemetryConfig } from "./types.ts";
import {
  mockProjectContext,
  mockRuntimeInfo,
  mockTty,
  processEnvLayer,
} from "../../../tests/helpers/mocks.ts";
import { tracingLayer } from "./tracing.layer.ts";

// ---------------------------------------------------------------------------
// Filesystem helpers
// ---------------------------------------------------------------------------

const fsLayer = BunServices.layer;

function makeTempDir(): string {
  return mkdtempSync(path.join(tmpdir(), "supabase-tracing-test-"));
}

function writeConfig(dir: string, config: TelemetryConfig): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "telemetry.json"), JSON.stringify(config));
}

// ---------------------------------------------------------------------------
// Layer builder helpers
// ---------------------------------------------------------------------------

function buildLayer(opts: { home: string; env?: Record<string, string>; stdoutIsTty?: boolean }) {
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
  const projectContextLayer = mockProjectContext();
  return Layer.mergeAll(
    fsLayer,
    runtimeInfoLayer,
    projectContextLayer,
    processEnvLayer(env),
    cliConfigLayer.pipe(Layer.provide(runtimeInfoLayer), Layer.provide(projectContextLayer)),
    mockTty({
      stdoutIsTty: opts.stdoutIsTty ?? false,
      stdinIsTty: false,
    }),
  );
}

function buildTracingLayer(opts: {
  home: string;
  env?: Record<string, string>;
  stdoutIsTty?: boolean;
}) {
  return tracingLayer.pipe(Layer.provide(buildLayer(opts)));
}

// ---------------------------------------------------------------------------
// Span factory helper (mirrors ExportableSpan constructor options)
// ---------------------------------------------------------------------------

function makeSpanOptions(
  overrides: Partial<{
    name: string;
    sampled: boolean;
    parent: Option.Option<Tracer.AnySpan>;
  }> = {},
) {
  return {
    name: overrides.name ?? "test-span",
    parent: overrides.parent ?? Option.none(),
    annotations: ServiceMap.empty(),
    links: [] as Tracer.SpanLink[],
    startTime: BigInt(Date.now()) * 1_000_000n,
    kind: "internal" as Tracer.SpanKind,
    root: false,
    sampled: overrides.sampled ?? true,
  };
}

// ---------------------------------------------------------------------------
// Layer construction & first-run
// ---------------------------------------------------------------------------

describe("tracingLayer – layer construction & first-run", () => {
  it.live("first-run TTY: creates telemetry.json with consent=granted", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    return Effect.gen(function* () {
      yield* Effect.void;
    }).pipe(
      Effect.provide(buildTracingLayer({ home, stdoutIsTty: true })),
      Effect.ensuring(
        Effect.sync(() => {
          const configPath = path.join(configDir, "telemetry.json");
          expect(existsSync(configPath)).toBe(true);
          const config: TelemetryConfig = JSON.parse(readFileSync(configPath, "utf8"));
          expect(config.consent).toBe("granted");
          expect(typeof config.device_id).toBe("string");
          expect(config.device_id.length).toBeGreaterThan(0);
          expect(typeof config.session_id).toBe("string");
          expect(config.session_id.length).toBeGreaterThan(0);
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("first-run non-TTY: creates telemetry.json with consent=granted", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    return Effect.gen(function* () {
      yield* Effect.void;
    }).pipe(
      Effect.provide(buildTracingLayer({ home, stdoutIsTty: false })),
      Effect.ensuring(
        Effect.sync(() => {
          const configPath = path.join(configDir, "telemetry.json");
          expect(existsSync(configPath)).toBe(true);
          const config: TelemetryConfig = JSON.parse(readFileSync(configPath, "utf8"));
          expect(config.consent).toBe("granted");
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("existing config with consent=granted: layer builds and tracer is usable", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    writeConfig(configDir, {
      consent: "granted",
      device_id: "existing-device",
      session_id: "existing-session",
      session_last_active: Date.now(),
    });
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      expect(span).toBeDefined();
      expect(span.name).toBe("test-span");
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });

  it.live(
    "SUPABASE_TELEMETRY_DISABLED=1 overrides consent=granted: no NDJSON export on span end",
    () => {
      const home = makeTempDir();
      const configDir = path.join(home, ".supabase");
      const tracesDir = path.join(configDir, "traces");
      writeConfig(configDir, {
        consent: "granted",
        device_id: "existing-device",
        session_id: "existing-session",
        session_last_active: Date.now(),
      });
      return Effect.gen(function* () {
        const tracer = yield* Tracer.Tracer;
        const span = tracer.span(makeSpanOptions());
        span.end(BigInt(Date.now() + 100) * 1_000_000n, Exit.void);
      }).pipe(
        Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
        Effect.ensuring(
          Effect.sync(() => {
            const hasNdjson =
              existsSync(tracesDir) && readdirSync(tracesDir).some((f) => f.endsWith(".ndjson"));
            expect(hasNdjson).toBe(false);
            rmSync(home, { recursive: true, force: true });
          }),
        ),
      );
    },
  );
});

// ---------------------------------------------------------------------------
// Span behaviour
// ---------------------------------------------------------------------------

describe("tracingLayer – span behaviour", () => {
  it.live("span creation attaches global attributes", () => {
    const home = makeTempDir();
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      expect(span.attributes.get("schema_version")).toBe(1);
      expect(typeof span.attributes.get("device_id")).toBe("string");
      expect(typeof span.attributes.get("session_id")).toBe("string");
      expect(typeof span.attributes.get("is_first_run")).toBe("boolean");
      expect(span.attributes.get("is_tty")).toBe(false);
      expect(typeof span.attributes.get("is_ci")).toBe("boolean");
      expect(span.attributes.get("os")).toBe("linux");
      expect(span.attributes.get("arch")).toBe("x64");
      expect(span.attributes.get("cli_version")).toBe("0.0.0-dev");
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });

  it.live("span end exports to NDJSON file when consent=granted", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    const tracesDir = path.join(configDir, "traces");
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      span.end(BigInt(Date.now() + 100) * 1_000_000n, Exit.void);
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(
        Effect.sync(() => {
          const hasNdjson =
            existsSync(tracesDir) && readdirSync(tracesDir).some((f) => f.endsWith(".ndjson"));
          expect(hasNdjson).toBe(true);
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("span end does NOT export to NDJSON when SUPABASE_TELEMETRY_DISABLED=1", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    const tracesDir = path.join(configDir, "traces");
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      span.end(BigInt(Date.now() + 100) * 1_000_000n, Exit.void);
    }).pipe(
      Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DISABLED: "1" } })),
      Effect.ensuring(
        Effect.sync(() => {
          const hasNdjson =
            existsSync(tracesDir) && readdirSync(tracesDir).some((f) => f.endsWith(".ndjson"));
          expect(hasNdjson).toBe(false);
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("span end exports to debug console when SUPABASE_DEBUG=1", () => {
    const home = makeTempDir();
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = vi.fn((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions({ name: "debug-span" }));
      span.end(BigInt(Date.now() + 50) * 1_000_000n, Exit.void);
    }).pipe(
      Effect.provide(buildTracingLayer({ home, env: { SUPABASE_DEBUG: "1" } })),
      Effect.ensuring(
        Effect.sync(() => {
          process.stderr.write = originalWrite;
          const output = stderrChunks.join("");
          expect(output).toContain("debug-span");
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("span end exports to debug console when SUPABASE_TELEMETRY_DEBUG=1", () => {
    const home = makeTempDir();
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = vi.fn((chunk: unknown) => {
      stderrChunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;

    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions({ name: "telemetry-debug-span" }));
      span.end(BigInt(Date.now() + 50) * 1_000_000n, Exit.void);
    }).pipe(
      Effect.provide(buildTracingLayer({ home, env: { SUPABASE_TELEMETRY_DEBUG: "1" } })),
      Effect.ensuring(
        Effect.sync(() => {
          process.stderr.write = originalWrite;
          const output = stderrChunks.join("");
          expect(output).toContain("telemetry-debug-span");
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("span end skips unsampled spans – no NDJSON export", () => {
    const home = makeTempDir();
    const configDir = path.join(home, ".supabase");
    const tracesDir = path.join(configDir, "traces");
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions({ sampled: false }));
      span.end(BigInt(Date.now() + 100) * 1_000_000n, Exit.void);
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(
        Effect.sync(() => {
          const hasNdjson =
            existsSync(tracesDir) && readdirSync(tracesDir).some((f) => f.endsWith(".ndjson"));
          expect(hasNdjson).toBe(false);
          rmSync(home, { recursive: true, force: true });
        }),
      ),
    );
  });

  it.live("CI detection via CI env var sets is_ci=true on span", () => {
    const home = makeTempDir();
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      expect(span.attributes.get("is_ci")).toBe(true);
    }).pipe(
      Effect.provide(buildTracingLayer({ home, env: { CI: "true" } })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });
});

// ---------------------------------------------------------------------------
// ExportableSpan unit tests
// ---------------------------------------------------------------------------

describe("ExportableSpan unit tests", () => {
  it.live("child span inherits traceId from parent span", () => {
    const home = makeTempDir();
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const parent = tracer.span(makeSpanOptions({ name: "parent" }));
      const child = tracer.span(makeSpanOptions({ name: "child", parent: Option.some(parent) }));
      expect(child.traceId).toBe(parent.traceId);
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });

  it.live("event() and addLinks() are no-ops that do not throw", () => {
    const home = makeTempDir();
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      span.event("test-event", BigInt(Date.now()) * 1_000_000n, { key: "val" });
      span.addLinks([]);
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });

  it.live("span without parent generates 32-char hex traceId and 16-char hex spanId", () => {
    const home = makeTempDir();
    const HEX_32 = /^[0-9a-f]{32}$/;
    const HEX_16 = /^[0-9a-f]{16}$/;
    return Effect.gen(function* () {
      const tracer = yield* Tracer.Tracer;
      const span = tracer.span(makeSpanOptions());
      expect(span.traceId).toMatch(HEX_32);
      expect(span.spanId).toMatch(HEX_16);
    }).pipe(
      Effect.provide(buildTracingLayer({ home })),
      Effect.ensuring(Effect.sync(() => rmSync(home, { recursive: true, force: true }))),
    );
  });
});
