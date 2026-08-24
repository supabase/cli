import type { ProvidedContext } from "vitest";
import { Effect, Schema } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import { startPgMock } from "../src/server/pg-mock.ts";
import { startReplayServer } from "../src/server/replay-server.ts";
import {
  ACCESS_TOKEN,
  isRecording,
  ORG_ID,
  PROJECT_REF,
  readEnv,
  TARGET_API_URL,
} from "../src/tests/env.ts";
import {
  cleanupProjectsByName,
  createTestProject,
  deleteTestProject,
  generateDbPassword,
  resolveOrgId,
  waitForProjectReady,
} from "./staging-project.ts";
import "./provided-context.ts"; // centralized `inject()` key augmentation

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

const serviceRoleKeysSchema = Schema.Array(
  Schema.Struct({ name: Schema.String, api_key: Schema.String }),
);

function resolveDockerSocket(dockerHost = readEnv("DOCKER_HOST")): string {
  if (dockerHost?.startsWith("unix://")) return dockerHost.slice("unix://".length);
  return "/var/run/docker.sock";
}

export function setup({
  provide,
}: {
  provide: <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;
}) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const pgMock = startPgMock();
      provide("pgMockPort", pgMock.port);

      const server = yield* Effect.promise(() =>
        startReplayServer({
          fixturesDir: FIXTURES_DIR,
          pgMock,
          mode: isRecording ? "record" : "replay",
          stagingUrl: TARGET_API_URL,
        }),
      );
      provide("replayServerUrl", server.url);

      // Docker host URL: relay server in TCP form so DOCKER_HOST env can point at it.
      // In record mode the relay proxies to the real Docker socket; in replay mode it
      // serves recorded Docker API fixtures unchanged.
      const dockerHostUrl = server.url.replace(/^http:\/\//, "tcp://");
      provide("dockerHostUrl", dockerHostUrl);

      if (!isRecording) {
        // Replay mode — no real API calls; any valid 20-char string works as the
        // project ref because fixture paths normalize it to __PROJECT_REF__.
        provide("projectRef", PROJECT_REF);
        provide("orgId", ORG_ID);
        provide("storageBucket", "cli-e2e-bucket");
        const context = yield* Effect.context();
        return () =>
          Effect.runPromiseWith(context)(
            Effect.promise(() => server.stop()).pipe(
              Effect.tap(() => Effect.sync(() => pgMock.stop())),
            ),
          );
      }

      // Record mode — wire up Docker proxy so Docker SDK calls (via DOCKER_HOST) are
      // intercepted by the relay server and forwarded to the real Docker socket.
      server.setDockerProxyUrl(resolveDockerSocket());

      // Record mode — resolve org, then wipe any projects left over from previous
      // failed recording runs before creating a fresh dedicated test project.
      const orgId = yield* Effect.promise(() => resolveOrgId(server.url));

      // Delete any orphaned projects whose names would conflict with what the tests
      // are about to create. Runs before any scenario is loaded so these API calls go
      // straight to staging and are not captured in any scenario fixture.
      yield* Effect.promise(() =>
        cleanupProjectsByName(server.url, ["cli-e2e-test", "my-project", "to-delete"]),
      );

      // Create a fresh project for this recording run. Its ref is used by branches,
      // functions, secrets, and api-keys tests.
      const projectRef = yield* Effect.promise(() =>
        createTestProject(server.url, orgId, "cli-e2e-test", generateDbPassword()),
      );
      provide("projectRef", projectRef);
      provide("orgId", orgId);

      // Wire storage proxy so /storage/v1/ calls from --local mode reach staging.
      const stagingApiUrl = TARGET_API_URL;
      // Wait for the project to be fully initialised before fetching api-keys — the
      // api-keys endpoint is unavailable while the project is in COMING_SOON/BUILDING state.
      yield* Effect.promise(() => waitForProjectReady(stagingApiUrl, projectRef));

      // Retry api-keys fetch: even after ACTIVE_HEALTHY, the endpoint may briefly return 4xx.
      let serviceRoleKey = "";
      for (let attempt = 1; attempt <= 12; attempt++) {
        const keysRequest = HttpClientRequest.get(
          `${stagingApiUrl}/v1/projects/${projectRef}/api-keys`,
        ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${ACCESS_TOKEN}`));
        const keysResponse = yield* HttpClient.execute(keysRequest);
        if (keysResponse.status >= 200 && keysResponse.status < 300) {
          const keys =
            yield* HttpClientResponse.schemaBodyJson(serviceRoleKeysSchema)(keysResponse);
          serviceRoleKey = keys.find((key) => key.name === "service_role")?.api_key ?? "";
          break;
        }
        if (attempt === 12) {
          throw new Error(
            `Failed to fetch api-keys after 12 attempts: ${yield* keysResponse.text}`,
          );
        }
        yield* Effect.sleep("10 seconds");
      }

      const storageBaseUrl = `https://${projectRef}.supabase.red`;
      server.setStorageProxyUrl(storageBaseUrl);
      server.setStorageProxyAuth(serviceRoleKey);

      // Create test bucket and seed a file — direct calls to staging, not via relay.
      const bucketRequest = yield* HttpClientRequest.post(
        `${storageBaseUrl}/storage/v1/bucket`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${serviceRoleKey}`),
        HttpClientRequest.bodyJson({
          id: "cli-e2e-bucket",
          name: "cli-e2e-bucket",
          public: false,
        }),
      );
      yield* HttpClient.execute(bucketRequest);

      const objectRequest = HttpClientRequest.post(
        `${storageBaseUrl}/storage/v1/object/cli-e2e-bucket/hello.txt`,
      ).pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${serviceRoleKey}`),
        HttpClientRequest.bodyText("hello world", "text/plain"),
      );
      yield* HttpClient.execute(objectRequest);
      provide("storageBucket", "cli-e2e-bucket");

      const context = yield* Effect.context();
      return () =>
        Effect.runPromiseWith(context)(
          Effect.gen(function* () {
            // The projects:delete test is self-contained (it creates and deletes its own
            // "to-delete" project). The projects:create test creates "my-project" but
            // does not delete it, so we clean it up here.
            yield* Effect.promise(() => cleanupProjectsByName(server.url, ["my-project"]));
            yield* Effect.promise(() => deleteTestProject(server.url, projectRef));
            pgMock.stop();
            yield* Effect.promise(() => server.stop());
          }),
        );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
  );
}
