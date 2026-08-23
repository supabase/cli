// oxlint-disable effecttsgo/async-function, effecttsgo/node-builtin-import -- Tests intentionally exercise native async, HTTP, timer, and subprocess boundaries.
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { prefetch, type StackHandle } from "../src/node.ts";
import { hasDockerDaemon } from "./helpers/warmup.ts";
import { createStackWithEphemeralPorts } from "./helpers/stack-ports.ts";

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

const POSTGRES_CONTAINER_NAME_PREFIX = "supabase-postgres-";
const dockerContainerNameFor = (apiPort: string) => `${POSTGRES_CONTAINER_NAME_PREFIX}${apiPort}`;

const runningContainerIds = (nameFilter: string): ReadonlyArray<string> =>
  execSync(`docker ps -q --filter name=${nameFilter}`)
    .toString()
    .trim()
    .split(/\s+/)
    .filter(Boolean);

async function queryMarkerRows(dbPort: number): Promise<ReadonlyArray<{ note: string }>> {
  const sql = new Bun.SQL(`postgresql://supabase_admin:postgres@127.0.0.1:${dbPort}/postgres`);
  try {
    const result = await sql.unsafe<{ note: string }[]>(
      `SELECT note FROM public.persistence_marker ORDER BY id`,
    );
    // `SQLResultArray` carries extra own properties alongside the rows, which
    // breaks `toEqual` against a plain array literal, so coerce to one here.
    return Array.from(result);
  } finally {
    await sql.close();
  }
}

// This e2e requires both the native Postgres artifact and a Docker daemon.
const canRunPersistenceE2e =
  hasDockerDaemon() &&
  (await prefetch({ mode: "native", services: ["postgres"] })).postgres?.type === "binary";
const persistenceDescribe = canRunPersistenceE2e ? describe : describe.skip;

persistenceDescribe("postgres native/docker data persistence e2e", () => {
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-persist-"));
  });

  afterAll(() => {
    // Best-effort — Bun's rmSync can intermittently throw EFAULT on Linux when
    // removing a directory that was just released as a Docker bind mount.
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  });

  describe("phase 1: native postgres writes a marker row", () => {
    let stack: StackHandle;
    let apiPort: string;
    let containerIdsBeforeCreate: ReadonlySet<string>;

    beforeAll(async () => {
      containerIdsBeforeCreate = new Set(runningContainerIds(POSTGRES_CONTAINER_NAME_PREFIX));

      stack = await createStackWithEphemeralPorts({
        mode: "native",
        ...onlyPostgresConfig,
        postgres: { dataDir },
      });

      apiPort = new URL(stack.url).port;

      try {
        await stack.start();
      } catch (startError) {
        await stack.dispose().catch(() => {});
        throw startError;
      }

      const dbPort = parseInt(new URL(stack.dbUrl).port);
      const sql = new Bun.SQL(`postgresql://supabase_admin:postgres@127.0.0.1:${dbPort}/postgres`);
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.persistence_marker (
          id serial primary key,
          note text
        );

        INSERT INTO public.persistence_marker (note) VALUES ('native-e2e-marker');
      `);
      await sql.close();
    }, NATIVE_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await stack?.dispose();
      expect(existsSync(dataDir)).toBe(true);
    }, TEARDOWN_TIMEOUT_MS);

    test(
      "runs postgres as a native process, not a Docker container",
      { timeout: TEST_TIMEOUT_MS },
      () => {
        expect(
          runningContainerIds(dockerContainerNameFor(apiPort)).filter(
            (id) => !containerIdsBeforeCreate.has(id),
          ),
        ).toEqual([]);
      },
    );
  });

  describe("phase 2: docker postgres reusing the native dataDir", () => {
    let stack: StackHandle;
    let apiPort: string;

    beforeAll(async () => {
      stack = await createStackWithEphemeralPorts({
        mode: "docker",
        ...onlyPostgresConfig,
        postgres: { dataDir },
      });

      apiPort = new URL(stack.url).port;
      const containerName = dockerContainerNameFor(apiPort);

      try {
        await stack.start();
      } catch (startError) {
        // `docker logs` is best-effort: `makePostgresServiceDocker` runs the
        // container with `--rm`, so a crash removes the container before this
        // catch block runs and `docker logs` finds nothing. `logHistory` is
        // the reliable source — it's fed from the child process's live
        // stdout/stderr as it runs, so it survives the container disappearing.
        let bufferedLogs: string;
        try {
          const entries = await stack.logHistory("postgres");
          bufferedLogs = entries.map((entry) => `[${entry.stream}] ${entry.line}`).join("\n");
        } catch (logHistoryError) {
          bufferedLogs = `(failed to capture logHistory: ${String(logHistoryError)})`;
        }

        let dockerLogs: string;
        try {
          dockerLogs = execSync(`docker logs ${containerName}`, { encoding: "utf8" });
        } catch (logError) {
          dockerLogs = `(failed to capture docker logs: ${String(logError)})`;
        }

        let status: string;
        try {
          status = JSON.stringify(await stack.getStatus());
        } catch (statusError) {
          status = `(failed to capture getStatus(): ${String(statusError)})`;
        }

        const startFailureDiagnostics = [
          "stack2.start() failed while reusing the native dataDir in docker mode.",
          `Original error: ${startError instanceof Error ? (startError.stack ?? startError.message) : String(startError)}`,
          `getStatus(): ${status}`,
          `stack.logHistory("postgres"):`,
          bufferedLogs,
          `docker logs ${containerName}:`,
          dockerLogs,
        ].join("\n");

        await stack.dispose().catch(() => {});
        throw new Error(startFailureDiagnostics);
      }
    }, DOCKER_SETUP_TIMEOUT_MS);

    afterAll(async () => {
      await stack?.dispose();
    }, TEARDOWN_TIMEOUT_MS);

    test("runs postgres as a Docker container this time", { timeout: TEST_TIMEOUT_MS }, () => {
      expect(runningContainerIds(dockerContainerNameFor(apiPort))).not.toEqual([]);
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
        const dbPort = parseInt(new URL(stack.dbUrl).port);
        const rows = await queryMarkerRows(dbPort);
        expect(rows).toEqual([{ note: "native-e2e-marker" }]);
      },
    );
  });
});
