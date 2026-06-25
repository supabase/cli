import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Cause, Effect, Exit, Layer } from "effect";

import {
  type LegacyEdgeRuntimeRunOpts,
  type LegacyEdgeRuntimeRunResult,
  LegacyEdgeRuntimeScript,
} from "../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyEdgeRuntimeScriptError } from "../../../shared/legacy-edge-runtime-script.errors.ts";
import { LegacyPgDeltaSslProbe } from "../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import {
  LEGACY_DEFAULT_PG_DELTA_NPM_VERSION,
  LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER,
} from "./legacy-pgdelta.deno-templates.ts";
import {
  legacyApplyDeclarativePgDelta,
  legacyDeclarativeExportPgDelta,
  legacyDiffPgDelta,
  legacyExportCatalogPgDelta,
  type LegacyPgDeltaContext,
} from "./legacy-pgdelta.ts";

const CTX: LegacyPgDeltaContext = {
  projectId: "ref",
  cwd: "/proj",
  npmVersion: undefined,
  denoVersion: 2,
};

function fakeEdgeRuntime(outcome: { stdout?: string; stderr?: string; fail?: string } = {}) {
  const calls: LegacyEdgeRuntimeRunOpts[] = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (opts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(opts);
      if (outcome.fail !== undefined) {
        return Effect.fail(
          new LegacyEdgeRuntimeScriptError({
            message: outcome.fail,
            stdout: outcome.stdout,
            stderr: outcome.stderr,
          }),
        );
      }
      return Effect.succeed({
        stdout: outcome.stdout ?? "",
        stderr: outcome.stderr ?? "",
      } satisfies LegacyEdgeRuntimeRunResult);
    },
  });
  return { layer, calls };
}

// These refs are local (127.0.0.1) endpoints that refuse TLS, so the probe reports
// "not required" — matching the no-SSL-env passthrough these tests assert.
const probe = Layer.succeed(LegacyPgDeltaSslProbe, {
  requireSsl: () => Effect.succeed(false),
});

describe("legacyApplyDeclarativePgDelta", () => {
  it.effect("parses apply output and mounts the declarative directory read-only", () => {
    const edge = fakeEdgeRuntime({
      stdout: JSON.stringify({
        status: "success",
        totalStatements: 3,
        totalRounds: 2,
        totalApplied: 3,
        totalSkipped: 0,
        errors: [],
        stuckStatements: [],
        validationErrors: [],
        diagnostics: [],
      }),
    });
    return legacyApplyDeclarativePgDelta(CTX, {
      declarativeDir: "/proj/supabase/database",
      targetRef: "postgresql://t",
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.status).toBe("success");
          expect(result.totalApplied).toBe(3);
          const opts = edge.calls[0]!;
          expect(opts.errPrefix).toBe("error running pg-delta script");
          expect(opts.env["SCHEMA_PATH"]).toBe("/declarative");
          expect(opts.env["TARGET"]).toBe("postgresql://t");
          expect(opts.binds).toEqual([
            "supabase_edge_runtime_ref:/root/.cache/deno:rw",
            "/proj/supabase/database:/declarative:ro",
          ]);
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("fails with parse error on invalid apply JSON", () => {
    const edge = fakeEdgeRuntime({ stdout: "not json" });
    return legacyApplyDeclarativePgDelta(CTX, {
      declarativeDir: "/proj/supabase/database",
      targetRef: "postgresql://t",
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeParseOutputError");
          expect((failError(exit) as { message: string }).message).toContain(
            "failed to parse pg-delta apply output:",
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("parses structured apply output when edge-runtime exits non-zero", () => {
    const edge = fakeEdgeRuntime({
      fail: "error running pg-delta script: error running container: exit 1",
      stderr: "pg-delta apply failed with status: error",
      stdout: JSON.stringify({
        status: "error",
        totalStatements: 2,
        totalRounds: 1,
        totalApplied: 1,
        totalSkipped: 0,
        errors: ["permission denied"],
        stuckStatements: [{ sql: "alter table public.todos add column title text" }],
        validationErrors: [{ message: "function body failed validation" }],
        diagnostics: [],
      }),
    });
    return legacyApplyDeclarativePgDelta(CTX, {
      declarativeDir: "/proj/supabase/database",
      targetRef: "postgresql://t",
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.status).toBe("error");
          expect(result.totalApplied).toBe(1);
          expect(result.errors).toEqual(["permission denied"]);
          expect(result.stuckStatements).toEqual([
            { sql: "alter table public.todos add column title text" },
          ]);
          expect(result.validationErrors).toEqual([{ message: "function body failed validation" }]);
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });
});

const failError = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isFailure(exit) ? exit.cause.reasons.find(Cause.isFailReason)?.error : undefined;

describe("legacyDiffPgDelta", () => {
  it.effect(
    "returns the SQL + stderr and passes the interpolated diff script + env + binds",
    () => {
      const edge = fakeEdgeRuntime({ stdout: "ALTER TABLE x;\n", stderr: "warn" });
      return legacyDiffPgDelta(CTX, {
        targetRef: "postgresql://u:p@127.0.0.1:54320/postgres?connect_timeout=10",
        sourceRef: "supabase/.temp/catalog.json",
        schema: ["public", "auth"],
        formatOptions: '{"indent":2}',
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.sql).toBe("ALTER TABLE x;\n");
            expect(result.stderr).toBe("warn");
            const opts = edge.calls[0]!;
            expect(opts.errPrefix).toBe("error diffing schema");
            // The (remote-merged) deno_version is forwarded so the edge-runtime
            // layer picks the configured Deno image, matching Go.
            expect(opts.denoVersion).toBe(2);
            // Default npm version interpolated into the template.
            expect(opts.script).toContain(
              `npm:@supabase/pg-delta@${LEGACY_DEFAULT_PG_DELTA_NPM_VERSION}`,
            );
            expect(opts.script).not.toContain(
              `npm:@supabase/pg-delta@${LEGACY_PG_DELTA_NPM_VERSION_PLACEHOLDER}`,
            );
            // TARGET is a URL (passthrough); SOURCE catalog file mapped to /workspace.
            expect(opts.env["TARGET"]).toBe(
              "postgresql://u:p@127.0.0.1:54320/postgres?connect_timeout=10",
            );
            expect(opts.env["SOURCE"]).toBe("/workspace/supabase/.temp/catalog.json");
            expect(opts.env["INCLUDED_SCHEMAS"]).toBe("public,auth");
            expect(opts.env["FORMAT_OPTIONS"]).toBe('{"indent":2}');
            expect(opts.binds).toEqual([
              "supabase_edge_runtime_ref:/root/.cache/deno:rw",
              "/proj:/workspace",
            ]);
          }),
        ),
        Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
      );
    },
  );

  it.effect("omits SOURCE / schema / format when not provided", () => {
    const edge = fakeEdgeRuntime({ stdout: "" });
    return legacyDiffPgDelta(CTX, {
      targetRef: "postgresql://t",
      sourceRef: "",
      schema: [],
      formatOptions: "  ",
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const env = edge.calls[0]!.env;
          expect(env["SOURCE"]).toBeUndefined();
          expect(env["INCLUDED_SCHEMAS"]).toBeUndefined();
          expect(env["FORMAT_OPTIONS"]).toBeUndefined();
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("maps an edge-runtime failure to LegacyDeclarativeEdgeRuntimeError", () => {
    const edge = fakeEdgeRuntime({ fail: "error diffing schema: boom" });
    return legacyDiffPgDelta(CTX, {
      targetRef: "postgresql://t",
      sourceRef: "",
      schema: [],
      formatOptions: "",
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeEdgeRuntimeError");
          expect((failError(exit) as { message: string }).message).toBe(
            "error diffing schema: boom",
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });
});

describe("legacyDeclarativeExportPgDelta", () => {
  it.effect("parses the declarative output envelope", () => {
    const payload = {
      version: 1,
      mode: "declarative",
      files: [{ path: "public.sql", order: 0, statements: 2, sql: "..." }],
    };
    const edge = fakeEdgeRuntime({ stdout: JSON.stringify(payload) });
    return legacyDeclarativeExportPgDelta(CTX, {
      targetRef: "postgresql://t",
      sourceRef: "",
      schema: [],
      formatOptions: "",
    }).pipe(
      Effect.tap((out) =>
        Effect.sync(() => {
          expect(out.version).toBe(1);
          expect(out.files[0]?.path).toBe("public.sql");
          expect(edge.calls[0]!.errPrefix).toBe("error exporting declarative schema");
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("fails with empty-output error when the script prints nothing", () => {
    const edge = fakeEdgeRuntime({ stdout: "", stderr: "stack" });
    return legacyDeclarativeExportPgDelta(CTX, {
      targetRef: "postgresql://t",
      sourceRef: "",
      schema: [],
      formatOptions: "",
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeEmptyOutputError");
          expect((failError(exit) as { message: string }).message).toBe(
            "error exporting declarative schema: edge-runtime script produced no output:\nstack",
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("fails with parse error on invalid JSON", () => {
    const edge = fakeEdgeRuntime({ stdout: "not json" });
    return legacyDeclarativeExportPgDelta(CTX, {
      targetRef: "postgresql://t",
      sourceRef: "",
      schema: [],
      formatOptions: "",
    }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeParseOutputError");
          expect((failError(exit) as { message: string }).message).toContain(
            "failed to parse declarative export output:",
          );
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });
});

describe("legacyExportCatalogPgDelta", () => {
  it.effect("returns the trimmed snapshot and sets ROLE / TARGET", () => {
    const edge = fakeEdgeRuntime({ stdout: '  {"catalog":true}\n  ' });
    return legacyExportCatalogPgDelta(CTX, {
      targetRef: "postgresql://t",
      role: "postgres",
    }).pipe(
      Effect.tap((snapshot) =>
        Effect.sync(() => {
          expect(snapshot).toBe('{"catalog":true}');
          const opts = edge.calls[0]!;
          expect(opts.errPrefix).toBe("error exporting pg-delta catalog");
          expect(opts.env["TARGET"]).toBe("postgresql://t");
          expect(opts.env["ROLE"]).toBe("postgres");
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });

  it.effect("omits ROLE when empty and errors on empty output", () => {
    const edge = fakeEdgeRuntime({ stdout: "   ", stderr: "oops" });
    return legacyExportCatalogPgDelta(CTX, { targetRef: "postgresql://t", role: "" }).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(failError(exit)?.constructor.name).toBe("LegacyDeclarativeEmptyOutputError");
        }),
      ),
      Effect.provide(Layer.mergeAll(edge.layer, probe, BunServices.layer)),
    );
  });
});
