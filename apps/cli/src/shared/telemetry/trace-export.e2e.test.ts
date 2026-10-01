import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";
import { runSupabaseEffect } from "../../../tests/helpers/cli.ts";

interface TraceLine {
  readonly resourceSpans: ReadonlyArray<{
    readonly scopeSpans: ReadonlyArray<{
      readonly spans: ReadonlyArray<{
        readonly name: string;
        readonly traceId: string;
        readonly parentSpanId?: string;
        readonly attributes?: ReadonlyArray<{
          readonly key: string;
          readonly value: { readonly intValue?: string | number };
        }>;
      }>;
    }>;
  }>;
}

const withoutTraceEnv = {
  SUPABASE_DEBUG: undefined,
  SUPABASE_TELEMETRY_DEBUG: undefined,
  SUPABASE_TRACE_FILE: undefined,
  SUPABASE_OTLP_ENDPOINT: undefined,
  SUPABASE_ACCESS_TOKEN: undefined,
};

const readTraceSpans = Effect.fnUntraced(function* (tracePath: string) {
  const fs = yield* FileSystem.FileSystem;
  return (yield* fs.readFileString(tracePath))
    .split("\n")
    .filter((line) => line.length > 0)
    .flatMap((line): TraceLine["resourceSpans"][number]["scopeSpans"][number]["spans"] => {
      const batch: TraceLine = JSON.parse(line);
      return batch.resourceSpans.flatMap((resource) =>
        resource.scopeSpans.flatMap((scope) => scope.spans),
      );
    });
});

describe("trace export across the process exit", () => {
  it.live("writes the cli.run span under the adopted TRACEPARENT before the process exits", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-trace-e2e-" });
      const tracePath = path.join(root, "trace.jsonl");
      const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
      const parentId = "00f067aa0ba902b7";

      const { exitCode, stderr } = yield* runSupabaseEffect(["--version"], {
        env: { SUPABASE_TRACE_FILE: tracePath, TRACEPARENT: `00-${traceId}-${parentId}-01` },
      });

      expect(exitCode, stderr).toBe(0);
      expect((yield* fs.stat(tracePath)).mode & 0o777).toBe(0o600);
      const spans = yield* readTraceSpans(tracePath);
      expect(spans.find((span) => span.name === "cli.run")).toMatchObject({
        traceId,
        parentSpanId: parentId,
      });
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("records a failed command's exit code on cli.run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-trace-e2e-" });
      const tracePath = path.join(root, "trace.jsonl");

      const { exitCode, stderr } = yield* runSupabaseEffect(["projects", "list"], {
        cwd: root,
        env: { ...withoutTraceEnv, SUPABASE_TRACE_FILE: tracePath },
      });

      expect(exitCode, stderr).toBe(1);
      const run = (yield* readTraceSpans(tracePath)).find((span) => span.name === "cli.run");
      const recorded = run?.attributes?.find((attribute) => attribute.key === "process.exit_code");
      expect(Number(recorded?.value.intValue)).toBe(1);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});

const SPAN_LINE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] +\S+ \(\d+ms\)/mu;

describe("span debug console", () => {
  it.live("prints spans when the project .env sets SUPABASE_DEBUG=1", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-trace-debug-e2e-" });
      yield* fs.makeDirectory(path.join(root, "supabase"));
      yield* fs.writeFileString(
        path.join(root, "supabase", "config.toml"),
        'project_id = "trace-e2e"\n',
      );
      yield* fs.writeFileString(path.join(root, "supabase", ".env"), "SUPABASE_DEBUG=1\n");

      const { exitCode, stderr } = yield* runSupabaseEffect(["projects", "list"], {
        cwd: root,
        env: withoutTraceEnv,
      });

      expect(exitCode, stderr).toBe(1);
      expect(stderr).toMatch(SPAN_LINE);
      expect(stderr).toContain("CommandCredentials.load (");
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prints no spans for --debug", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-trace-debug-e2e-" });

      const { exitCode, stderr } = yield* runSupabaseEffect(["--debug", "projects", "list"], {
        cwd: root,
        env: withoutTraceEnv,
      });

      expect(exitCode, stderr).toBe(1);
      expect(stderr).toContain("Access token not provided");
      expect(stderr).not.toMatch(SPAN_LINE);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it.live("prints no spans when --debug is a flag value", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-trace-debug-e2e-" });

      const { exitCode, stderr } = yield* runSupabaseEffect(
        ["projects", "list", "--workdir", "--debug"],
        { cwd: root, env: withoutTraceEnv },
      );

      expect(exitCode, stderr).toBe(1);
      expect(stderr).not.toMatch(SPAN_LINE);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
