import { describe, expect, it } from "@effect/vitest";

import {
  nativePostgresClientEnv,
  postgresClientContainerArgs,
  POSTGRES_DUMP_BINS,
  POSTGRES_PROVE_BINS,
  requiredPostgresClientBins,
} from "./postgres-client-args.ts";

describe("postgres client argv", () => {
  it("prepends the artifact bin directory to PATH", () => {
    expect(
      nativePostgresClientEnv("/opt/postgres/bin", { PGHOST: "127.0.0.1" }, "/usr/bin", ":"),
    ).toEqual({
      PGHOST: "127.0.0.1",
      PATH: "/opt/postgres/bin:/usr/bin",
    });
  });

  it("emits docker run --rm with key-only -e flags", () => {
    expect(
      postgresClientContainerArgs({
        image: "ghcr.io/supabase/cli/postgres:17.6.1.168",
        argv: ["bash", "-c", "pg_dump --version", "--"],
        env: { PGPASSWORD: "secret", PGHOST: "host.docker.internal" },
        network: "host",
        extraHosts: ["host.docker.internal:host-gateway"],
        mounts: [{ source: "/tests", target: "/tests", readOnly: true }],
        cwd: "/tests",
      }),
    ).toEqual([
      "run",
      "--rm",
      "--network",
      "host",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-v",
      "/tests:/tests:ro",
      "-e",
      "PGPASSWORD",
      "-e",
      "PGHOST",
      "-w",
      "/tests",
      "ghcr.io/supabase/cli/postgres:17.6.1.168",
      "bash",
      "-c",
      "pg_dump --version",
      "--",
    ]);
  });

  it("requires dump clients for bash pipelines and pg_prove only for prove argv", () => {
    expect([...requiredPostgresClientBins(["bash", "-c", "pg_dump --version"])]).toEqual([
      ...POSTGRES_DUMP_BINS,
    ]);
    expect([...requiredPostgresClientBins(["pg_prove", "--ext", ".sql"])]).toEqual([
      ...POSTGRES_PROVE_BINS,
    ]);
  });
});
