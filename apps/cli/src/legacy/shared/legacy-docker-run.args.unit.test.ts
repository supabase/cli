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
      "PGHOST=db",
      "-e",
      "PGPORT=5432",
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
});
