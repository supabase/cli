import { describe, expect, test } from "vitest";
import { Option } from "effect";

import { buildLegacyDockerArgs } from "./legacy-docker-run.args.ts";
import type { LegacyDockerRunOpts } from "./legacy-docker-run.service.ts";

const base: LegacyDockerRunOpts = {
  image: "supabase/pg_prove:3.36",
  cmd: ["pg_prove", "-r", "/t"],
  env: { PGHOST: "db", PGPORT: "5432" },
  binds: ["/host/a:/host/a:ro"],
  workingDir: Option.some("/host/a"),
  securityOpt: ["label:disable"],
  extraHosts: [],
  network: { _tag: "named", name: "supabase_network_proj" },
};

describe("buildLegacyDockerArgs", () => {
  test("assembles run args in Go-parity order for a named network", () => {
    expect(buildLegacyDockerArgs(base)).toEqual([
      "run",
      "--rm",
      "--network",
      "supabase_network_proj",
      "-v",
      "/host/a:/host/a:ro",
      "-e",
      "PGHOST",
      "-e",
      "PGPORT",
      "--security-opt",
      "label:disable",
      "-w",
      "/host/a",
      "supabase/pg_prove:3.36",
      "pg_prove",
      "-r",
      "/t",
    ]);
  });

  test("emits --add-host for each extraHosts entry, right after the network args", () => {
    const args = buildLegacyDockerArgs({
      ...base,
      extraHosts: ["host.docker.internal:host-gateway"],
    });
    expect(args.slice(0, 6)).toEqual([
      "run",
      "--rm",
      "--network",
      "supabase_network_proj",
      "--add-host",
      "host.docker.internal:host-gateway",
    ]);
  });

  test("uses --network host for the host network", () => {
    const args = buildLegacyDockerArgs({ ...base, network: { _tag: "host" } });
    expect(args.slice(0, 4)).toEqual(["run", "--rm", "--network", "host"]);
  });

  test("omits the network and -w args for the none network and absent workingDir", () => {
    const args = buildLegacyDockerArgs({
      ...base,
      network: { _tag: "none" },
      workingDir: Option.none(),
    });
    expect(args).not.toContain("--network");
    expect(args).not.toContain("-w");
  });

  test("never serializes env values into argv (CWE-214: PGPASSWORD must not leak to ps)", () => {
    const args = buildLegacyDockerArgs({
      ...base,
      env: { PGPASSWORD: "super-secret", PGHOST: "db" },
    });
    // Key-only `-e KEY` form: docker reads the value from the spawned process's
    // environment, so no value ever appears in the host process argv.
    expect(args).toContain("PGPASSWORD");
    expect(args.some((a) => a.includes("super-secret"))).toBe(false);
    expect(args.some((a) => a.includes("="))).toBe(false);
  });
});
