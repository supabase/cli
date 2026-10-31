import {
  Config,
  ConfigProvider,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Schedule,
  Schema,
  Scope,
} from "effect";
import {
  FetchHttpClient,
  HttpBody,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import type { ProvidedContext } from "vitest";
import { startPgMock } from "../src/server/pg-mock.ts";
import { startReplayServer } from "../src/server/replay-server.ts";
import { ACCESS_TOKEN, isRecording, ORG_ID, PROJECT_REF, STAGING_URL } from "../src/tests/env.ts";
import {
  cleanupProjectsByName,
  createTestProject,
  deleteTestProject,
  generateDbPassword,
  resolveOrgId,
  StagingProjectError,
  waitForProjectReady,
} from "./staging-project.ts";
import "./provided-context.ts"; // centralized `inject()` key augmentation

const FIXTURES_DIR = new URL("../fixtures", import.meta.url).pathname;

const resolveDockerSocket = Effect.gen(function* () {
  const dockerHost = Option.getOrUndefined(yield* Config.option(Config.String("DOCKER_HOST")));
  if (dockerHost?.startsWith("unix://")) return dockerHost.slice("unix://".length);
  return "/var/run/docker.sock";
});

/** The api-keys endpoint answered with a non-2xx status. */
class ApiKeysNotReady extends Data.TaggedError("ApiKeysNotReady")<{
  readonly response: HttpClientResponse.HttpClientResponse;
}> {}

const ApiKeys = Schema.Array(
  Schema.Struct({ name: Schema.String, api_key: Schema.optionalKey(Schema.NullOr(Schema.String)) }),
);

const setupLayer = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(HttpClient.TracerPropagationEnabled, false),
  ConfigProvider.layer(Effect.sync(() => ConfigProvider.fromEnv({ preserveEmptyStrings: true }))),
);

type Provide = <K extends keyof ProvidedContext>(key: K, value: ProvidedContext[K]) => void;

const globalSetup = Effect.fn("E2eSetup.globalSetup")(function* (provide: Provide) {
  const pgMock = startPgMock();
  provide("pgMockPort", pgMock.port);

  const server = yield* startReplayServer({
    fixturesDir: FIXTURES_DIR,
    pgMock,
    record: isRecording,
    stagingUrl: STAGING_URL,
  });
  provide("replayServerUrl", server.url);

  // Docker host URL: relay server in TCP form so DOCKER_HOST env can point at it.
  // In record mode the relay proxies to the real Docker socket; in replay mode it
  // serves recorded Docker API fixtures unchanged.
  const dockerHostUrl = server.url.replace(/^http:\/\//, "tcp://");
  provide("dockerHostUrl", dockerHostUrl);

  /* The replay server stops after this, when its own finalizers run. */
  const stopPgMock = Effect.sync(() => pgMock.stop());

  if (!isRecording) {
    // Replay mode — no real API calls; PROJECT_REF and ORG_ID default to the ref
    // recorded fixtures use.
    provide("projectRef", PROJECT_REF);
    provide("orgId", ORG_ID);
    provide("storageBucket", "cli-e2e-bucket");
    yield* Effect.addFinalizer(() => stopPgMock);
    return;
  }

  // Record mode — wire up Docker proxy so Docker SDK calls (via DOCKER_HOST) are
  // intercepted by the relay server and forwarded to the real Docker socket.
  server.setDockerProxyUrl(yield* resolveDockerSocket);

  // Record mode — resolve org, then wipe any projects left over from previous
  // failed recording runs before creating a fresh dedicated test project.
  const orgId = yield* resolveOrgId(server.url);

  // Delete any orphaned projects whose names would conflict with what the tests
  // are about to create.  Runs before any scenario is loaded so these API calls
  // go straight to staging and are not captured in any scenario fixture.
  yield* cleanupProjectsByName(server.url, ["cli-e2e-test", "my-project", "to-delete"]);

  // Create a fresh project for this recording run.  Its ref is used by branches,
  // functions, secrets, and api-keys tests.
  const projectRef = yield* createTestProject(
    server.url,
    orgId,
    "cli-e2e-test",
    yield* generateDbPassword,
  );
  provide("projectRef", projectRef);
  provide("orgId", orgId);

  // Wire storage proxy so /storage/v1/ calls from --local mode reach staging.
  const stagingApiUrl = STAGING_URL!;
  // Wait for the project to be fully initialised before fetching api-keys — the
  // api-keys endpoint is unavailable while the project is in COMING_SOON/BUILDING state.
  yield* waitForProjectReady(stagingApiUrl, projectRef);
  // Retry api-keys fetch: even after ACTIVE_HEALTHY, the endpoint may briefly return 4xx.
  const fetchServiceRoleKey = Effect.gen(function* () {
    const keysRes = yield* HttpClient.get(`${stagingApiUrl}/v1/projects/${projectRef}/api-keys`, {
      headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
    });
    if (keysRes.status < 200 || keysRes.status >= 300) {
      return yield* new ApiKeysNotReady({ response: keysRes });
    }
    const keys = yield* HttpClientResponse.schemaBodyJson(ApiKeys)(keysRes);
    return keys.find((k) => k.name === "service_role")?.api_key ?? "";
  });
  const serviceRoleKey = yield* fetchServiceRoleKey.pipe(
    Effect.retry({
      schedule: Schedule.spaced("10 seconds"),
      times: 11,
      while: (error) => Predicate.isTagged(error, "ApiKeysNotReady"),
    }),
    Effect.catchTag("ApiKeysNotReady", ({ response }) =>
      Effect.gen(function* () {
        return yield* new StagingProjectError({
          message: `Failed to fetch api-keys after 12 attempts: ${yield* response.text}`,
        });
      }),
    ),
  );

  const storageBaseUrl = `https://${projectRef}.supabase.red`;
  server.setStorageProxyUrl(storageBaseUrl);
  server.setStorageProxyAuth(serviceRoleKey);

  // Create test bucket and seed a file — direct calls to staging, not via relay.
  yield* HttpClientRequest.post(`${storageBaseUrl}/storage/v1/bucket`, {
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
  }).pipe(
    HttpClientRequest.bodyJson({ id: "cli-e2e-bucket", name: "cli-e2e-bucket", public: false }),
    Effect.flatMap(HttpClient.execute),
  );
  yield* HttpClient.post(`${storageBaseUrl}/storage/v1/object/cli-e2e-bucket/hello.txt`, {
    headers: { Authorization: `Bearer ${serviceRoleKey}` },
    body: HttpBody.text("hello world", "text/plain"),
  });
  provide("storageBucket", "cli-e2e-bucket");

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      // The projects:delete test is self-contained (it creates and deletes its own
      // "to-delete" project).  The projects:create test creates "my-project" but
      // does not delete it, so we clean it up here.
      yield* cleanupProjectsByName(server.url, ["my-project"]);
      yield* deleteTestProject(server.url, projectRef);
      yield* stopPgMock;
    }).pipe(Effect.orDie),
  );
});

export function setup({ provide }: { provide: Provide }) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* globalSetup(provide).pipe(Scope.provide(scope));
      return scope;
    }).pipe(
      Effect.map((scope) => () => Effect.runPromise(Scope.close(scope, Exit.void))),
      Effect.provide(setupLayer),
    ),
  );
}
