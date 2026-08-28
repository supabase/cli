// oxlint-disable effecttsgo/async-function, effecttsgo/global-date, effecttsgo/global-fetch, effecttsgo/node-builtin-import -- Docker e2e tests drive the native CLI, Docker, and HTTP boundaries from Vitest's Promise callbacks.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createStack, type StackHandle } from "../src/node.ts";
import { dependencyTimeoutSecondsForServices } from "../src/services/health-budgets.ts";
import { SERVICE_NAMES, type ServiceName } from "../src/versions.ts";
import { setupTestTable } from "./helpers/e2e.ts";

const STACK_DOCKER_E2E_TEST_TIMEOUT_MS = 240_000;
const STACK_DOCKER_E2E_SETUP_OVERHEAD_MS = 180_000;
const STACK_DOCKER_E2E_SETUP_TIMEOUT_MS =
  dependencyTimeoutSecondsForServices(["postgres"]) * 1000 + STACK_DOCKER_E2E_SETUP_OVERHEAD_MS;

const EXPECTED_SLIM_DOCKER_IMAGES: Readonly<Record<ServiceName, string>> = {
  postgres: "ghcr.io/supabase/cli/postgres:17.6.1.165",
  postgrest: "ghcr.io/supabase/cli/postgrest:v16.2",
  auth: "ghcr.io/supabase/cli/auth:v2.196.0",
  "edge-runtime": "ghcr.io/supabase/cli/edge-runtime:v1.74.3",
  realtime: "ghcr.io/supabase/cli/realtime:v2.129.9",
  storage: "ghcr.io/supabase/cli/storage:v1.71.0",
  imgproxy: "ghcr.io/supabase/cli/imgproxy:v3.8.0",
  mailpit: "ghcr.io/supabase/cli/mailpit:v1.30.2",
  pgmeta: "ghcr.io/supabase/cli/pgmeta:v0.98.0",
  studio: "ghcr.io/supabase/cli/studio:2026.08.24-sha-8ec45b2",
  analytics: "ghcr.io/supabase/cli/analytics:v1.50.6",
  vector: "ghcr.io/supabase/vector:0.53.0-alpine",
  pooler: "ghcr.io/supabase/supavisor:2.9.7",
};

const EAGER_SERVICES: ReadonlyArray<ServiceName> = [
  "postgres",
  "realtime",
  "mailpit",
  "pgmeta",
  "studio",
  "analytics",
  "vector",
  "pooler",
];

const LAZY_SERVICES: ReadonlyArray<ServiceName> = [
  "postgrest",
  "auth",
  "edge-runtime",
  "storage",
  "imgproxy",
];

const ownedDockerContainerName = (service: ServiceName, identity: string): string =>
  `supabase-${service}-${identity}`;

const ownedDockerContainers = (
  identity: string,
): ReadonlyArray<{ readonly name: string; readonly image: string }> =>
  SERVICE_NAMES.flatMap((service) => {
    const name = ownedDockerContainerName(service, identity);
    const output = execFileSync(
      "docker",
      ["ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}\t{{.Image}}"],
      { stdio: ["ignore", "pipe", "pipe"] },
    )
      .toString()
      .trim();
    if (output === "") return [];
    return output.split(/\r?\n/).map((line) => {
      const [containerName, image] = line.split("\t");
      return { name: containerName ?? name, image: image ?? "" };
    });
  });

function hasDockerDaemon(): boolean {
  try {
    execSync("docker info", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const dockerDescribe = hasDockerDaemon() ? describe : describe.skip;

dockerDescribe("createStack e2e (docker mode)", () => {
  let stack: StackHandle;
  let dataDir: string;
  let apiPort: string;
  let supabase: SupabaseClient;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-docker-"));

    stack = await createStack({
      mode: "docker",
      jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
      servicePolicies: {
        postgres: "eager",
        postgrest: "lazy",
        auth: "lazy",
        "edge-runtime": "lazy",
        realtime: "eager",
        storage: "lazy",
        imgproxy: "lazy",
        mailpit: "eager",
        pgmeta: "eager",
        studio: "eager",
        analytics: "eager",
        vector: "eager",
        pooler: "eager",
      },
      postgres: { dataDir },
      postgrest: {},
      auth: {},
      edgeRuntime: {},
      realtime: {},
      storage: {},
      imgproxy: {},
      mailpit: {},
      pgmeta: {},
      studio: {},
      analytics: {},
      vector: {},
      pooler: {},
    });

    try {
      await stack.start();
    } catch (startError) {
      await stack.dispose().catch(() => {});
      throw startError;
    }

    const dbPort = parseInt(new URL(stack.dbUrl).port);
    try {
      await setupTestTable(dbPort);
    } catch (error) {
      const status = await stack.getStatus();
      const logs = await stack.logHistory("postgres");
      throw new Error(
        `setupTestTable failed: ${String(error)}\nstatus=${JSON.stringify(status)}\nlogs=${JSON.stringify(logs)}`,
      );
    }

    apiPort = new URL(stack.url).port;
    supabase = createClient(stack.url, stack.publishableKey);
  }, STACK_DOCKER_E2E_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await stack?.dispose();

    // Verify all exact owned Docker containers are cleaned up, including stopped containers.
    if (apiPort !== undefined) {
      const remaining = ownedDockerContainers(apiPort).map((container) => container.name);
      expect(remaining).toEqual([]);
    }

    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {}
  }, 30_000);

  test(
    "qualifies the complete slim Docker graph through one public user journey",
    { timeout: STACK_DOCKER_E2E_TEST_TIMEOUT_MS },
    async () => {
      try {
        const initialStates = await stack.getStatus();
        expect(initialStates.map((state) => state.name).toSorted()).toEqual(
          [...SERVICE_NAMES].toSorted(),
        );

        const [storageRes, pgmetaRes, analyticsRes] = await Promise.all([
          fetch(`${stack.url}/storage/v1/status`),
          fetch(`${stack.url}/pg/health`),
          fetch(`${stack.url}/analytics/v1/health`),
        ]);
        expect(storageRes.status, "storage status").toBe(200);
        expect(pgmetaRes.status, "pgmeta status").toBe(200);
        expect(analyticsRes.status, "analytics status").toBe(200);

        const functionsRes = await fetch(`${stack.url}/functions/v1/test`);
        expect(functionsRes.status).toBe(501);
        expect(await functionsRes.json()).toEqual({
          code: "FUNCTIONS_NOT_CONFIGURED",
          message: "Edge Functions are not configured for this local stack yet.",
        });

        const testEmail = `test-${Date.now()}@example.com`;
        const testPassword = "test-password-123";
        const signUp = await supabase.auth.signUp({
          email: testEmail,
          password: testPassword,
        });
        expect(signUp.error).toBeNull();
        expect(signUp.data.user?.email).toBe(testEmail);
        expect(signUp.data.session).toBeDefined();

        const signIn = await supabase.auth.signInWithPassword({
          email: testEmail,
          password: testPassword,
        });
        expect(signIn.error).toBeNull();
        expect(signIn.data.user?.email).toBe(testEmail);
        expect(signIn.data.session?.access_token).toBeTruthy();

        const currentUser = await supabase.auth.getUser();
        expect(currentUser.error).toBeNull();
        expect(currentUser.data.user?.email).toBe(testEmail);

        const seeded = await supabase.from("todos").select("*").order("id");
        expect(seeded.error).toBeNull();
        expect(seeded.data).toHaveLength(2);

        const todoTitle = `E2E test todo ${Date.now()}`;
        const inserted = await supabase
          .from("todos")
          .insert({ title: todoTitle })
          .select()
          .single();
        expect(inserted.error).toBeNull();
        expect(inserted.data?.title).toBe(todoTitle);

        const updated = await supabase
          .from("todos")
          .update({ completed: true })
          .eq("title", todoTitle)
          .select()
          .single();
        expect(updated.error).toBeNull();
        expect(updated.data?.completed).toBe(true);

        const healthyStates = await stack.getStatus();
        expect(healthyStates).toHaveLength(SERVICE_NAMES.length);
        expect(healthyStates.every((state) => state.status === "Healthy")).toBe(true);

        const ownedContainers = ownedDockerContainers(apiPort);
        expect(ownedContainers.map((container) => container.name).toSorted()).toEqual(
          SERVICE_NAMES.map((service) => ownedDockerContainerName(service, apiPort)).toSorted(),
        );
        for (const service of SERVICE_NAMES) {
          const containerName = ownedDockerContainerName(service, apiPort);
          const container = ownedContainers.find((candidate) => candidate.name === containerName);
          expect(container?.image, `${service} image`).toBe(EXPECTED_SLIM_DOCKER_IMAGES[service]);
        }

        const primaryOwnedNamesBeforeSibling = ownedContainers.map((container) => container.name);
        const primaryDbPort = new URL(stack.dbUrl).port;
        const primaryIsolationTitle = `isolation-primary-${crypto.randomUUID()}`;
        const siblingIsolationTitle = `isolation-sibling-${crypto.randomUUID()}`;
        const primaryIsolationInsert = await supabase
          .from("todos")
          .insert({ title: primaryIsolationTitle })
          .select()
          .single();
        expect(primaryIsolationInsert.error).toBeNull();
        expect(primaryIsolationInsert.data?.title).toBe(primaryIsolationTitle);

        const siblingDataDir = mkdtempSync(join(tmpdir(), "supabase-e2e-docker-sibling-"));
        const siblingStartedServices: ReadonlyArray<ServiceName> = [...EAGER_SERVICES, "postgrest"];
        let sibling: StackHandle | undefined;
        let siblingApiPort: string | undefined;
        let siblingJourneyError: unknown;
        let siblingDisposeError: unknown;
        let siblingContainerCleanupError: unknown;
        let siblingDataDirCleanupError: unknown;
        try {
          sibling = await createStack({
            mode: "docker",
            jwtSecret: "super-secret-jwt-token-with-at-least-32-characters-long",
            servicePolicies: {
              postgres: "eager",
              postgrest: "lazy",
              auth: "lazy",
              "edge-runtime": "lazy",
              realtime: "eager",
              storage: "lazy",
              imgproxy: "lazy",
              mailpit: "eager",
              pgmeta: "eager",
              studio: "eager",
              analytics: "eager",
              vector: "eager",
              pooler: "eager",
            },
            postgres: { dataDir: siblingDataDir },
            postgrest: {},
            auth: {},
            edgeRuntime: {},
            realtime: {},
            storage: {},
            imgproxy: {},
            mailpit: {},
            pgmeta: {},
            studio: {},
            analytics: {},
            vector: {},
            pooler: {},
          });
          const siblingIdentity = new URL(sibling.url).port;
          siblingApiPort = siblingIdentity;
          await sibling.start();

          const siblingDbPort = new URL(sibling.dbUrl).port;
          expect(siblingIdentity).not.toBe(apiPort);
          expect(siblingDbPort).not.toBe(primaryDbPort);
          await setupTestTable(parseInt(siblingDbPort));
          const siblingSupabase = createClient(sibling.url, sibling.publishableKey);
          await sibling.startService("postgrest");

          const [primaryBeforeDispose, siblingStates] = await Promise.all([
            stack.getStatus(),
            sibling.getStatus(),
          ]);
          expect(primaryBeforeDispose.map((state) => state.name).toSorted()).toEqual(
            [...SERVICE_NAMES].toSorted(),
          );
          expect(primaryBeforeDispose.every((state) => state.status === "Healthy")).toBe(true);
          expect(primaryBeforeDispose.map(({ name, status }) => ({ name, status }))).toEqual(
            healthyStates.map(({ name, status }) => ({ name, status })),
          );
          expect(siblingStates.map((state) => state.name).toSorted()).toEqual(
            [...SERVICE_NAMES].toSorted(),
          );
          expect(siblingStates).toEqual(
            expect.arrayContaining(
              siblingStartedServices.map((name) =>
                expect.objectContaining({ name, status: "Healthy" }),
              ),
            ),
          );
          expect(siblingStates).toEqual(
            expect.arrayContaining(
              LAZY_SERVICES.filter((name) => name !== "postgrest").map((name) =>
                expect.objectContaining({ name, status: "Dormant" }),
              ),
            ),
          );

          const siblingIsolationInsert = await siblingSupabase
            .from("todos")
            .insert({ title: siblingIsolationTitle })
            .select()
            .single();
          expect(siblingIsolationInsert.error).toBeNull();
          expect(siblingIsolationInsert.data?.title).toBe(siblingIsolationTitle);

          const [siblingCannotReadPrimary, primaryCannotReadSibling] = await Promise.all([
            siblingSupabase.from("todos").select("title").eq("title", primaryIsolationTitle),
            supabase.from("todos").select("title").eq("title", siblingIsolationTitle),
          ]);
          expect(siblingCannotReadPrimary.error).toBeNull();
          expect(siblingCannotReadPrimary.data).toEqual([]);
          expect(primaryCannotReadSibling.error).toBeNull();
          expect(primaryCannotReadSibling.data).toEqual([]);

          const siblingOwnedBeforeDispose = ownedDockerContainers(siblingIdentity);
          expect(siblingOwnedBeforeDispose.map((container) => container.name).toSorted()).toEqual(
            siblingStartedServices
              .map((service) => ownedDockerContainerName(service, siblingIdentity))
              .toSorted(),
          );
        } catch (error) {
          siblingJourneyError = error;
          let siblingStates: ReadonlyArray<unknown> = [];
          let siblingLogs: ReadonlyArray<unknown> = [];
          if (sibling !== undefined) {
            const activeSibling = sibling;
            [siblingStates, siblingLogs] = await Promise.all([
              activeSibling.getStatus().catch(() => []),
              Promise.all(
                SERVICE_NAMES.map((service) =>
                  activeSibling.logHistory(service, 10).catch(() => []),
                ),
              ),
            ]);
          }
          siblingJourneyError = new Error(
            `Sibling Docker isolation journey failed: ${String(error)}\nstatus=${JSON.stringify(siblingStates)}\nlogs=${JSON.stringify(siblingLogs)}`,
          );
        } finally {
          try {
            if (sibling !== undefined) {
              await sibling.dispose();
            }
          } catch (error) {
            siblingDisposeError = error;
          }

          try {
            if (siblingApiPort !== undefined) {
              const remaining = ownedDockerContainers(siblingApiPort).map(
                (container) => container.name,
              );
              expect(remaining).toEqual([]);
            }
          } catch (error) {
            siblingContainerCleanupError = error;
          }

          try {
            rmSync(siblingDataDir, { recursive: true, force: true });
          } catch (error) {
            siblingDataDirCleanupError = error;
          }
        }

        if (siblingJourneyError !== undefined) {
          throw siblingJourneyError;
        }
        if (siblingDisposeError !== undefined) {
          throw siblingDisposeError;
        }
        if (siblingContainerCleanupError !== undefined) {
          throw siblingContainerCleanupError;
        }
        if (siblingDataDirCleanupError !== undefined) {
          throw siblingDataDirCleanupError;
        }

        expect(
          ownedDockerContainers(apiPort)
            .map((container) => container.name)
            .toSorted(),
        ).toEqual(primaryOwnedNamesBeforeSibling.toSorted());
        const primaryAfterSiblingDispose = await supabase
          .from("todos")
          .select("title")
          .eq("title", primaryIsolationTitle)
          .single();
        expect(primaryAfterSiblingDispose.error).toBeNull();
        expect(primaryAfterSiblingDispose.data?.title).toBe(primaryIsolationTitle);
        const deletedIsolation = await supabase
          .from("todos")
          .delete()
          .eq("title", primaryIsolationTitle);
        expect(deletedIsolation.error).toBeNull();

        const beforeRestart = await stack.getStatus();
        await stack.stop();
        await stack.start();
        const afterRestart = await stack.getStatus();
        expect(afterRestart.map((state) => state.name).toSorted()).toEqual(
          beforeRestart.map((state) => state.name).toSorted(),
        );
        expect(afterRestart).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ name: "pgmeta", status: "Healthy" }),
            expect.objectContaining({ name: "studio", status: "Healthy" }),
          ]),
        );
        expect(afterRestart).toEqual(
          expect.arrayContaining(
            EAGER_SERVICES.map((name) => expect.objectContaining({ name, status: "Healthy" })),
          ),
        );
        expect(afterRestart).toEqual(
          expect.arrayContaining(
            LAZY_SERVICES.map((name) => expect.objectContaining({ name, status: "Stopped" })),
          ),
        );
        await stack.startService("postgrest");

        const persisted = await supabase.from("todos").select("*").eq("title", todoTitle).single();
        expect(persisted.error).toBeNull();
        expect(persisted.data?.completed).toBe(true);

        const deleted = await supabase.from("todos").delete().eq("title", todoTitle);
        expect(deleted.error).toBeNull();
      } catch (error) {
        const [states, logs] = await Promise.all([
          stack.getStatus().catch(() => []),
          Promise.all(
            SERVICE_NAMES.map((service) => stack.logHistory(service, 10).catch(() => [])),
          ),
        ]);
        throw new Error(
          `Complete Docker graph journey failed: ${String(error)}\nstatus=${JSON.stringify(states)}\nlogs=${JSON.stringify(logs)}`,
        );
      }
    },
  );
});
