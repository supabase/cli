import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";

import { restoreStackLogicalBaselineScript } from "./reset-local-database.ts";

describe("restoreStackLogicalBaselineScript", () => {
  it("streams the baseline dump into psql with the target credentials", () => {
    const directory = mkdtempSync(join(tmpdir(), "stack-reset-script-"));
    const capture = join(directory, "captured.sql");
    try {
      const dump = join(directory, "pg_dump");
      const psql = join(directory, "psql");
      writeFileSync(
        dump,
        '#!/usr/bin/env bash\nprintf "CREATE TABLE baseline_marker(id int);\\n"\n',
      );
      writeFileSync(
        psql,
        '#!/usr/bin/env bash\n[[ "$PGUSER" == "supabase_admin" ]] || exit 4\ncat > "$CAPTURE"\n',
      );
      chmodSync(dump, 0o755);
      chmodSync(psql, 0o755);

      execFileSync("bash", ["-c", restoreStackLogicalBaselineScript(), "--"], {
        env: {
          PATH: `${directory}:${process.env.PATH ?? ""}`,
          CAPTURE: capture,
          PGHOST: "source-host",
          PGPORT: "5432",
          PGUSER: "postgres",
          PGPASSWORD: "source-password",
          PGDATABASE: "postgres",
          TARGET_HOST: "target-host",
          TARGET_PORT: "5433",
          TARGET_USER: "supabase_admin",
          TARGET_PASSWORD: "target-password",
          TARGET_DATABASE: "postgres",
        },
      });

      expect(readFileSync(capture, "utf8")).toBe("CREATE TABLE baseline_marker(id int);\n");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
