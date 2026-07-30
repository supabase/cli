import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { hasDockerDaemon } from "./helpers/warmup.ts";

const DEV_JWT_SECRET = "super-secret-jwt-token-with-at-least-32-characters-long";
const NATIVE_SETUP_TIMEOUT_MS = 45_000;
const DOCKER_SETUP_TIMEOUT_MS = 90_000;
const TEARDOWN_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 10_000;

// Only postgres is under test here, so every other service is disabled to keep
// this e2e run fast (matches the repo's e2e scope policy of minimal coverage).
const onlyPostgresConfig = {
  jwtSecret: DEV_JWT_SECRET,
  postgrest: false,
  auth: false,
  storage: false,
  imgproxy: false,
  mailpit: false,
  pgmeta: false,
  studio: false,
  analytics: false,
  vector: false,
  pooler: false,
  realtime: false,
  edgeRuntime: false,
} as const;

const dockerContainerNameFor = (apiPort: string) => `supabase-postgres-${apiPort}`;

const runningContainerIds = (apiPort: string): string =>
  execSync(`docker ps -q --filter name=${dockerContainerNameFor(apiPort)}`)
    .toString()
    .trim();

async function queryMarkerRows(dbPort: number): Promise<ReadonlyArray<{ note: string }>> {
  const sql = new Bun.SQL(`postgresql://supabase_admin:postgres@127.0.0.1:${dbPort}/postgres`);
  try {
    const result = await sql.unsafe(`SELECT note FROM public.persistence_marker ORDER BY id`);
    // Bun's SQL result is a decorated Array subclass carrying extra own properties
    // (count, command, lastInsertRowid, affectedRows) alongside the real rows, which
    // makes it fail toEqual against a plain array literal even when the rows match.
    // Copy into a plain array of plain objects so the assertion below is meaningful.
    return Array.from(result, (row) => ({ note: (row as { note: string }).note }));
  } finally {
    sql.close();
  }
}

const dockerDescribe = hasDockerDaemon() ? describe : describe.skip;

dockerDescribe("postgres native/docker data persistence e2e", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-persist-"));
  });

  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  describe("phase 1: native postgres writes a marker row", () => {
    let stack: StackHandle;
    let apiPort: string;

    beforeAll(async () => {
      stack = await createStack({
        mode: "native",
        ...onlyPostgresConfig,
        postgres: { dataDir },
      });

      try {
        await stack.start();
      } catch (startError) {
        await stack.dispose().catch(() => {});
        throw startError;
      }

      apiPort = new URL(stack.url).port;

      const dbPort = parseInt(new URL(stack.dbUrl).port);
      const sql = new Bun.SQL(`postgresql://supabase_admin:postgres@127.0.0.1:${dbPort}/postgres`);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.persistence_marker (
          id serial primary key,
          note text
        );

        INSERT INTO public.persistence_marker (note) VALUES ('native-e2e-marker');
      `);
      sql.close();
    }, NATIVE_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await stack?.dispose();
      expect(existsSync(dataDir)).toBe(true);
    }, TEARDOWN_TIMEOUT_MS);

    test(
      "runs postgres as a native process, not a Docker container",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        expect(runningContainerIds(apiPort)).toBe("");
      },
    );
  });

  describe("phase 2: docker postgres reusing the native dataDir", () => {
    let stack: StackHandle;
    let apiPort: string;
    let startFailureDiagnostics: string | undefined;

    beforeAll(async () => {
      stack = await createStack({
        mode: "docker",
        ...onlyPostgresConfig,
        postgres: { dataDir },
      });

      apiPort = new URL(stack.url).port;
      const containerName = dockerContainerNameFor(apiPort);

      try {
        await stack.start();
      } catch (startError) {
        let logs: string;
        try {
          logs = execSync(`docker logs ${containerName}`, { encoding: "utf8" });
        } catch (logError) {
          logs = `(failed to capture docker logs: ${String(logError)})`;
        }

        let status: string;
        try {
          status = JSON.stringify(await stack.getStatus());
        } catch (statusError) {
          status = `(failed to capture getStatus(): ${String(statusError)})`;
        }

        startFailureDiagnostics = [
          "stack2.start() failed while reusing the native dataDir in docker mode.",
          `Original error: ${startError instanceof Error ? (startError.stack ?? startError.message) : String(startError)}`,
          `getStatus(): ${status}`,
          `docker logs ${containerName}:`,
          logs,
        ].join("\n");

        await stack.dispose().catch(() => {});
      }
    }, DOCKER_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await stack?.dispose();
    }, TEARDOWN_TIMEOUT_MS);

    test(
      "starts postgres successfully by reusing the native dataDir",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        if (startFailureDiagnostics !== undefined) {
          throw new Error(startFailureDiagnostics);
        }
      },
    );

    test("runs postgres as a Docker container this time", { timeout: TEST_TIMEOUT_MS }, () => {
      if (startFailureDiagnostics !== undefined) {
        throw new Error(
          "Skipped: stack2 never started successfully. See the preceding test failure for diagnostics.",
        );
      }
      expect(runningContainerIds(apiPort)).not.toBe("");
    });

    // This is the assertion this whole file exists to make: the row written while
    // running natively must still be readable once the same dataDir is mounted into
    // the Docker-mode postgres container. See the module-level comment in
    // ../src/services/postgres.ts for why this is *not* guaranteed to work — the
    // Docker entrypoint execs `postgres -D /etc/postgresql`, a different path than
    // the `/var/lib/postgresql/data` volume mount.
    test(
      "the native-mode marker row survives the transition to Docker",
      { timeout: TEST_TIMEOUT_MS },
      async () => {
        if (startFailureDiagnostics !== undefined) {
          throw new Error(
            "Skipped: stack2 never started successfully. See the preceding test failure for diagnostics.",
          );
        }
        const dbPort = parseInt(new URL(stack.dbUrl).port);
        const rows = await queryMarkerRows(dbPort);
        expect(rows).toEqual([{ note: "native-e2e-marker" }]);
      },
    );
  });
});
