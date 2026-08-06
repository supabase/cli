import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Layer } from "effect";

import {
  type LegacyEdgeRuntimeRunOpts,
  LegacyEdgeRuntimeScript,
} from "../../../../shared/legacy-edge-runtime-script.service.ts";
import { LegacyPgDeltaSslProbe } from "../../../../shared/legacy-pgdelta-ssl-probe.service.ts";
import { legacyPgDeltaLegacyEngineLayer } from "../../shared/legacy-pgdelta-engine.legacy.layer.ts";
import {
  LegacyPgDeltaEngine,
  type LegacyPgDeltaDeclarativePlanInput,
} from "../../shared/legacy-pgdelta-engine.service.ts";
import {
  type LegacyCatalogMode,
  LegacyDeclarativeSeam,
} from "../../shared/legacy-pgdelta.seam.service.ts";
import {
  type LegacyDeclarativeRunContext,
  legacyDiffDeclarativeToMigrations,
  legacyGenerateDeclarativeOutput,
} from "./declarative.orchestrate.ts";

function mockSeam(paths: Record<LegacyCatalogMode, string>) {
  const calls: Array<{ mode: LegacyCatalogMode; noCache: boolean }> = [];
  const layer = Layer.succeed(LegacyDeclarativeSeam, {
    exportCatalog: ({ mode, noCache }) => {
      calls.push({ mode, noCache });
      return Effect.succeed(paths[mode]);
    },
    execInherit: () => Effect.succeed(0),
    ensureLocalDatabaseStarted: () => Effect.void,
    ensureLocalPostgresImageCurrent: () => Effect.void,
    provisionShadow: () => Effect.die("provisionShadow not used in declarative tests"),
    removeShadowContainer: () => Effect.void,
  });
  return { layer, calls };
}

function mockEdge(stdout: string) {
  const calls: LegacyEdgeRuntimeRunOpts[] = [];
  const layer = Layer.succeed(LegacyEdgeRuntimeScript, {
    run: (opts: LegacyEdgeRuntimeRunOpts) => {
      calls.push(opts);
      // The pg-delta diff script (uniquely identified by `renderPlanFiles`) prints a
      // JSON envelope with one file per plan unit; wrap the test's raw SQL into a
      // single-unit envelope so `legacyDiffPgDelta` parses it. Other scripts
      // (declarative export) return their stdout unchanged.
      const wrapped =
        opts.script.includes("renderPlanFiles") && stdout.length > 0
          ? JSON.stringify({
              version: 1,
              files: [
                { order: 1, name: "schema_changes", transactionMode: "transactional", sql: stdout },
              ],
            })
          : stdout;
      return Effect.succeed({ stdout: wrapped, stderr: "" });
    },
  });
  return { layer, calls };
}

// Remote refs in these tests are non-Supabase hosts that refuse TLS → probe
// reports "not required", so no CA bundle/SSL env is injected.
const probe = Layer.succeed(LegacyPgDeltaSslProbe, {
  requireSsl: () => Effect.succeed(false),
  requireSslForHost: () => Effect.succeed(false),
});

const ctx = (declarativeDir: string): LegacyDeclarativeRunContext => ({
  pgDelta: { projectId: "cferry", cwd: "/proj", npmVersion: undefined, denoVersion: 2 },
  formatOptions: "",
  declarativeDir,
  schema: [],
  noCache: false,
  debug: false,
  dnsResolver: "native",
});

const engineLayer = (
  seam: Layer.Layer<LegacyDeclarativeSeam>,
  edge: Layer.Layer<LegacyEdgeRuntimeScript>,
) =>
  legacyPgDeltaLegacyEngineLayer.pipe(
    Layer.provide(Layer.mergeAll(seam, edge, probe, BunServices.layer)),
  );

describe("legacyDiffDeclarativeToMigrations", () => {
  it.effect("loads nested SQL and its manifest in stable order for the engine", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(join(declDir, "nested"), { recursive: true });
    writeFileSync(join(declDir, "z.sql"), "select 'z';");
    writeFileSync(join(declDir, "nested", "a.sql"), "select 'a';");
    writeFileSync(join(declDir, "ignored.txt"), "ignored");
    writeFileSync(
      join(declDir, ".pgdelta-export.json"),
      JSON.stringify({ formatVersion: 1, redactSecrets: true, scope: "database" }),
    );
    const calls: LegacyPgDeltaDeclarativePlanInput[] = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "next",
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: () => Effect.die("exportDeclarativeSchema not used"),
        planDeclarativeSchema: (input) => {
          calls.push(input);
          return Effect.succeed({
            changes: false,
            sql: "",
            files: [],
            sourceRef: "migrations",
            targetRef: "declarative",
          });
        },
      }),
    );
    return legacyDiffDeclarativeToMigrations({ ...ctx(declDir), debug: true, noCache: true }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls[0]?.files).toEqual([
            { name: "nested/a.sql", sql: "select 'a';" },
            { name: "z.sql", sql: "select 'z';" },
          ]);
          expect(calls[0]?.manifest).toEqual({ redactSecrets: true, scope: "database" });
          expect(calls[0]?.debug).toBe(true);
          expect(calls[0]?.noCache).toBe(true);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(Layer.mergeAll(engine, BunServices.layer)),
    );
  });

  it.effect("provisions migrations + declarative catalogs via the seam and diffs them", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const declDir = join(dir, "supabase", "database");
    mkdirSync(declDir, { recursive: true });
    const seam = mockSeam({
      migrations: "supabase/.temp/pgdelta/mig.json",
      declarative: "supabase/.temp/pgdelta/decl.json",
      baseline: "supabase/.temp/pgdelta/base.json",
    });
    const edge = mockEdge("ALTER TABLE x ADD COLUMN y int;\nDROP TABLE z;\n");
    return legacyDiffDeclarativeToMigrations(ctx(declDir)).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(seam.calls.map((c) => c.mode)).toEqual(["migrations", "declarative"]);
          expect(result.sourceRef).toBe("supabase/.temp/pgdelta/mig.json");
          expect(result.targetRef).toBe("supabase/.temp/pgdelta/decl.json");
          expect(result.diffSQL).toContain("ALTER TABLE x");
          expect(result.dropWarnings).toEqual(["DROP TABLE z"]);
          // The edge-runtime diff received the seam refs as SOURCE/TARGET.
          expect(edge.calls[0]!.env["SOURCE"]).toBe("/workspace/supabase/.temp/pgdelta/mig.json");
          expect(edge.calls[0]!.env["TARGET"]).toBe("/workspace/supabase/.temp/pgdelta/decl.json");
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          seam.layer,
          edge.layer,
          probe,
          engineLayer(seam.layer, edge.layer),
          BunServices.layer,
        ),
      ),
    );
  });

  it.effect("fails when the declarative dir is absent", () => {
    const dir = mkdtempSync(join(tmpdir(), "legacy-decl-orch-"));
    const seam = mockSeam({ migrations: "m", declarative: "d", baseline: "b" });
    const edge = mockEdge("");
    return legacyDiffDeclarativeToMigrations(ctx(join(dir, "missing"))).pipe(
      Effect.exit,
      Effect.tap((exit) =>
        Effect.sync(() => {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit)) {
            const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
            expect((error as { message: string }).message).toContain(
              "No declarative schema directory found",
            );
          }
          expect(seam.calls).toEqual([]);
          rmSync(dir, { recursive: true, force: true });
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          seam.layer,
          edge.layer,
          probe,
          engineLayer(seam.layer, edge.layer),
          BunServices.layer,
        ),
      ),
    );
  });
});

describe("legacyGenerateDeclarativeOutput", () => {
  it.effect("propagates debug and no-cache to the selected engine", () => {
    const calls: Array<{ readonly debug: boolean; readonly noCache: boolean }> = [];
    const engine = Layer.succeed(
      LegacyPgDeltaEngine,
      LegacyPgDeltaEngine.of({
        implementation: "next",
        diffExplicit: () => Effect.die("diffExplicit not used"),
        diffDatabase: () => Effect.die("diffDatabase not used"),
        exportDeclarativeSchema: (input) => {
          calls.push({ debug: input.debug, noCache: input.noCache });
          return Effect.succeed({ files: [] });
        },
        planDeclarativeSchema: () => Effect.die("planDeclarativeSchema not used"),
      }),
    );
    return legacyGenerateDeclarativeOutput(
      { ...ctx("/proj/supabase/database"), debug: true, noCache: true },
      {
        kind: "database",
        ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
        connectOptions: { isLocal: true, dnsResolver: "native" },
      },
    ).pipe(
      Effect.tap(() => Effect.sync(() => expect(calls).toEqual([{ debug: true, noCache: true }]))),
      Effect.provide(engine),
    );
  });

  it.effect("diffs the baseline catalog against the live DB and returns files", () => {
    const seam = mockSeam({
      migrations: "m",
      declarative: "d",
      baseline: "supabase/.temp/pgdelta/base.json",
    });
    const payload = {
      version: 1,
      mode: "declarative",
      files: [{ path: "public.sql", order: 0, statements: 1, sql: "create table a();" }],
    };
    const edge = mockEdge(JSON.stringify(payload));
    return legacyGenerateDeclarativeOutput(ctx("/proj/supabase/database"), {
      kind: "database",
      ref: "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
      connectOptions: { isLocal: true, dnsResolver: "native" },
    }).pipe(
      Effect.tap((output) =>
        Effect.sync(() => {
          expect(seam.calls).toEqual([{ mode: "baseline", noCache: false }]);
          expect(output.files[0]?.name).toBe("public.sql");
          // SOURCE = baseline catalog (mapped to /workspace); TARGET = live URL (passthrough).
          expect(edge.calls[0]!.env["SOURCE"]).toBe("/workspace/supabase/.temp/pgdelta/base.json");
          expect(edge.calls[0]!.env["TARGET"]).toBe(
            "postgresql://postgres:postgres@127.0.0.1:54322/postgres?connect_timeout=10",
          );
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          seam.layer,
          edge.layer,
          probe,
          engineLayer(seam.layer, edge.layer),
          BunServices.layer,
        ),
      ),
    );
  });
});
