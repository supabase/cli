import {
  SupabaseApiClient,
  v1GetProject,
  v1GetProjectApiKeys,
  v1ListAllProjects,
} from "@supabase/api/effect";
import { Data, Duration, Effect, Exit, Layer } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { CliConfig } from "./cli-config.service.ts";
import {
  ProjectLinkRemote,
  type AccessibleProject,
  type LinkedProjectSnapshot,
  type LinkedProjectVersionService,
} from "./project-link-remote.service.ts";
import type { LinkedServiceVersions } from "./project-link-state.service.ts";

class ServiceVersionNotFoundError extends Data.TaggedError("ServiceVersionNotFoundError")<{
  readonly service: string;
}> {}

class NoProjectApiKeyError extends Data.TaggedError("NoProjectApiKeyError")<{
  readonly projectRef: string;
}> {}

type ProjectApiKey = {
  readonly name: string;
  readonly type?: "legacy" | "publishable" | "secret" | null;
  readonly api_key?: string | null;
  readonly secret_jwt_template?: Record<string, unknown> | null;
};

const sortProjects = (projects: ReadonlyArray<AccessibleProject>) =>
  [...projects].sort(
    (left, right) => left.name.localeCompare(right.name) || left.ref.localeCompare(right.ref),
  );

const tenantBaseUrl = (projectRef: string, projectHost: string) =>
  `https://${projectRef}.${projectHost}`;

function isServiceRoleKey(key: ProjectApiKey): boolean {
  const template = key.secret_jwt_template;
  if (template == null || typeof template !== "object" || Array.isArray(template)) {
    return false;
  }
  return typeof template.role === "string" && template.role.toLowerCase() === "service_role";
}

function selectTenantAccessKey(keys: ReadonlyArray<ProjectApiKey>): string | undefined {
  for (const key of keys) {
    if (key.type === "secret" && typeof key.api_key === "string" && isServiceRoleKey(key)) {
      return key.api_key;
    }
  }

  for (const key of keys) {
    if (key.type === "publishable" && typeof key.api_key === "string") {
      return key.api_key;
    }
  }

  for (const key of keys) {
    if (key.name === "service_role" && typeof key.api_key === "string") {
      return key.api_key;
    }
  }

  for (const key of keys) {
    if (key.name === "anon" && typeof key.api_key === "string") {
      return key.api_key;
    }
  }
}

const authenticatedRequest = (url: string, accessKey: string) =>
  HttpClientRequest.get(url).pipe(
    HttpClientRequest.setHeader("Authorization", `Bearer ${accessKey}`),
    HttpClientRequest.setHeader("apikey", accessKey),
  );

const fetchJson = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  url: string,
  accessKey: string,
) {
  const request = authenticatedRequest(url, accessKey).pipe(HttpClientRequest.acceptJson);
  const response = yield* client.execute(request);
  return yield* response.json;
});

const fetchText = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  url: string,
  accessKey: string,
) {
  const response = yield* client.execute(authenticatedRequest(url, accessKey));
  return yield* response.text;
});

const fetchPostgrestVersion = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  accessKey: string,
) {
  const body = yield* fetchJson(client, `${baseUrl}/rest/v1/`, accessKey);
  const version =
    typeof body === "object" &&
    body !== null &&
    "info" in body &&
    typeof body.info === "object" &&
    body.info !== null &&
    "version" in body.info &&
    typeof body.info.version === "string"
      ? body.info.version
      : undefined;

  const normalized = version?.trim().split(/\s+/)[0];
  if (normalized === undefined || normalized.length === 0) {
    return yield* Effect.fail(new ServiceVersionNotFoundError({ service: "postgrest" }));
  }
  return normalized.startsWith("v") ? normalized : `v${normalized}`;
});

const fetchAuthVersion = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  accessKey: string,
) {
  const body = yield* fetchJson(client, `${baseUrl}/auth/v1/health`, accessKey);
  const version =
    typeof body === "object" &&
    body !== null &&
    "version" in body &&
    typeof body.version === "string"
      ? body.version.trim()
      : undefined;

  if (version === undefined || version.length === 0) {
    return yield* Effect.fail(new ServiceVersionNotFoundError({ service: "auth" }));
  }
  return version;
});

const fetchStorageVersion = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  accessKey: string,
) {
  const version = (yield* fetchText(client, `${baseUrl}/storage/v1/version`, accessKey)).trim();
  if (version.length === 0 || version === "0.0.0") {
    return yield* Effect.fail(new ServiceVersionNotFoundError({ service: "storage" }));
  }
  return version.startsWith("v") ? version : `v${version}`;
});

const fetchOptionalVersion = <Service extends Exclude<LinkedProjectVersionService, "postgres">>(
  service: Service,
  effect: Effect.Effect<string, unknown>,
) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => ({ service, exit }) as const),
  );

const makeProjectLinkRemote = Effect.gen(function* () {
  const cliConfig = yield* CliConfig;
  const apiClient = yield* SupabaseApiClient;
  const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

  const listAccessibleProjects = v1ListAllProjects().pipe(
    Effect.provideService(SupabaseApiClient, apiClient),
    Effect.map((projects) =>
      sortProjects(
        projects.map((project) => ({
          ref: project.ref,
          name: project.name,
          region: project.region,
          status: project.status,
        })),
      ),
    ),
  );

  const fetchLinkedProject = (projectRef: string) =>
    Effect.gen(function* () {
      const [project, apiKeys] = yield* Effect.all(
        [
          v1GetProject({ ref: projectRef }).pipe(
            Effect.provideService(SupabaseApiClient, apiClient),
          ),
          v1GetProjectApiKeys({ ref: projectRef, reveal: true }).pipe(
            Effect.provideService(SupabaseApiClient, apiClient),
          ),
        ],
        { concurrency: "unbounded" },
      );

      const accessKey = selectTenantAccessKey(apiKeys);
      if (accessKey === undefined) {
        return yield* Effect.fail(new NoProjectApiKeyError({ projectRef }));
      }

      const baseUrl = tenantBaseUrl(project.ref, cliConfig.projectHost);
      let versions: LinkedServiceVersions = { postgres: project.database.version };
      const unavailableServices: LinkedProjectVersionService[] = [];

      const results = yield* Effect.all(
        [
          fetchOptionalVersion(
            "postgrest",
            fetchPostgrestVersion(httpClient, baseUrl, accessKey).pipe(
              Effect.timeout(Duration.seconds(10)),
            ),
          ),
          fetchOptionalVersion(
            "auth",
            fetchAuthVersion(httpClient, baseUrl, accessKey).pipe(
              Effect.timeout(Duration.seconds(10)),
            ),
          ),
          fetchOptionalVersion(
            "storage",
            fetchStorageVersion(httpClient, baseUrl, accessKey).pipe(
              Effect.timeout(Duration.seconds(10)),
            ),
          ),
        ],
        { concurrency: "unbounded" },
      );

      for (const result of results) {
        if (Exit.isSuccess(result.exit)) {
          versions = { ...versions, [result.service]: result.exit.value };
          continue;
        }
        unavailableServices.push(result.service);
      }

      return {
        ref: project.ref,
        name: project.name,
        region: project.region,
        status: project.status,
        versions,
        unavailableServices,
      } satisfies LinkedProjectSnapshot;
    });

  return ProjectLinkRemote.of({
    listAccessibleProjects,
    fetchLinkedProject,
  });
});

export const projectLinkRemoteLayer = Layer.effect(ProjectLinkRemote, makeProjectLinkRemote).pipe(
  Layer.provide(FetchHttpClient.layer),
);
