import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { expectFunctionOk } from "./invoke.ts";
import { seedFunctions, testLiveRequires } from "./live-context.ts";

// Capability probes: one minimal test per runtime-capability combination the cli
// needs from its target. Each is a smoke check that FORCES its capability, so a
// failure (or a target-driven skip) is a precise signal of what an environment
// can or cannot do. Distilled from the richer feature tests so each isolates a
// single capability.
//
// Staging is the oracle: with CLI_E2E_TARGET_ENV=staging (provides all
// capabilities) every probe runs and must pass — proving the probe is sound, so
// any supabox skip/red is a genuine gap. On supabox each probe only runs once
// its capability is declared via CLI_E2E_CAPABILITIES, then must match staging.
// See `testLiveRequires` + PROVIDED_CAPABILITIES in ../env.ts.
describe("capability probes (live)", () => {
  // C1 — mgmt-api only (no docker, no internet, no external tool). The
  // provisioned project shows up in `projects list`: a pure control-plane read.
  testLiveRequires([])(
    "[C1] mgmt-api only: projects list includes the project",
    async ({ run, projectRef }) => {
      const res = await run(["projects", "list", "--output", "json"]);
      expect(res.exitCode, res.stderr).toBe(0);
      const refs = (JSON.parse(res.stdout) as Array<{ id?: string; ref?: string }>).map(
        (project) => project.ref ?? project.id,
      );
      expect(refs).toContain(projectRef);
    },
  );

  // C3 — external tool, no docker/internet. `db dump` of the remote schema over
  // the IPv4 pooler using the native pg_dump/psql on PATH
  // (SUPABASE_DB_USE_LOCAL_TOOLS), i.e. without spawning a supabase/postgres
  // container. Fails if the external tool is absent.
  testLiveRequires(["external-tool"])(
    "[C3] external tool: db dump exports the remote schema",
    async ({ run, dbUrl, workspace }) => {
      const file = join(workspace.path, "dump.sql");
      const res = await run(["db", "dump", "--db-url", dbUrl, "-f", file]);
      expect(res.exitCode, res.stderr).toBe(0);
      expect(existsSync(file)).toBe(true);
      expect(readFileSync(file, "utf8")).toMatch(/CREATE|PostgreSQL database dump|SCHEMA/i);
    },
  );

  // C2 — docker control, no runtime internet. `db pull`'s schema diff starts a
  // shadow postgres *server* (DockerStart) and runs the diff engine in a
  // container; both use pre-built images (no 3rd-party network). Push first so
  // local history matches the shared per-run project, then pull. A missing
  // Docker socket makes DockerStart fail — a genuine docker gate.
  testLiveRequires(["docker"])(
    "[C2] docker (offline): db push then db pull round-trips",
    async ({ run, dbUrl, workspace }) => {
      const migrations = join(workspace.path, "supabase", "migrations");
      mkdirSync(migrations, { recursive: true });
      writeFileSync(
        join(migrations, "20240101000000_probe_push.sql"),
        "create table if not exists capability_probe (id int);\n",
      );

      const pushed = await run(["db", "push", "--db-url", dbUrl, "--yes"]);
      expect(pushed.exitCode, pushed.stderr).toBe(0);

      const pulled = await run(["db", "pull", "--db-url", dbUrl, "--yes"]);
      const output = `${pulled.stdout}${pulled.stderr}`;
      // Distinguish a real docker/connection failure from a benign "no changes".
      expect(output, "db pull hit a docker/connection error").not.toMatch(
        /cannot connect to the docker daemon|is the docker daemon running|dial|connection refused|could not connect/i,
      );
      expect(pulled.exitCode === 0 || /No schema changes found/i.test(output), pulled.stderr).toBe(
        true,
      );
    },
  );

  // C4 — runtime 3rd-party internet, no docker. Deploy a function that imports
  // from jsr.io with the default (server-side) bundler and invoke it; the bundle
  // path must fetch the import over the network. Fails offline.
  testLiveRequires(["internet"])(
    "[C4] internet: deploy a jsr-importing function and invoke",
    async ({ run, invoke, workspace, projectRef }) => {
      seedFunctions(workspace.path);
      const slug = "deploy-e2e-jsr";
      const deployed = await run(["functions", "deploy", slug, "--project-ref", projectRef]);
      expect(deployed.exitCode, deployed.stderr).toBe(0);
      expect(deployed.stdout).toContain("Deployed Functions");
      expectFunctionOk(await invoke(slug), slug);
    },
  );

  // C5 — docker AND runtime internet. Same jsr-importing function, but bundled
  // locally in a Docker container (`--use-docker`): needs a Docker socket AND the
  // in-container bundler needs internet to fetch the jsr import. Fails if either
  // is missing.
  testLiveRequires(["docker", "internet"])(
    "[C5] docker + internet: --use-docker deploy of a jsr function",
    async ({ run, invoke, workspace, projectRef }) => {
      seedFunctions(workspace.path);
      const slug = "deploy-e2e-jsr";
      const deployed = await run([
        "functions",
        "deploy",
        slug,
        "--project-ref",
        projectRef,
        "--use-docker",
      ]);
      expect(deployed.exitCode, deployed.stderr).toBe(0);
      expect(deployed.stdout).toContain("Deployed Functions");
      expectFunctionOk(await invoke(slug), slug);
    },
  );
});
