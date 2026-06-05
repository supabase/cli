import { styleText } from "node:util";
import { makeApiClient, type ApiClient } from "@supabase/api/effect";
import { Data, Duration, Effect, Exit, Redacted } from "effect";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import { renderGlamourTable } from "../../legacy/output/legacy-glamour-table.ts";

export type RemoteServiceName = "postgres" | "auth" | "postgrest" | "storage";
export type OptionalRemoteServiceName = Exclude<RemoteServiceName, "postgres">;

// Mirrors Go's `utils.ProjectRefPattern` (`apps/cli-go/internal/utils/misc.go`).
// Validating the ref before it reaches the management API path param or the
// tenant gateway hostname keeps a tampered/malformed value from redirecting the
// service-role key to an attacker-controlled host.
const PROJECT_REF_PATTERN = /^[a-z]{20}$/;

interface ServiceImageSpec {
  readonly image: string;
  readonly remoteService: RemoteServiceName | undefined;
}

// Mirrors the legacy `services` image matrix:
// - source versions: `apps/cli-go/pkg/config/templates/Dockerfile`
// - source order: `apps/cli-go/pkg/config/config.go` `GetServiceImages()`
//
// We keep this compiled into the TS CLI because the published package does not
// ship the Go source tree at runtime, but the user-visible `services` output
// still needs to match the bundled image manifest.
const LOCAL_SERVICE_IMAGES = [
  { image: "supabase/postgres:17.6.1.132", remoteService: "postgres" },
  { image: "supabase/gotrue:v2.189.0", remoteService: "auth" },
  { image: "postgrest/postgrest:v14.12", remoteService: "postgrest" },
  { image: "supabase/realtime:v2.103.2", remoteService: undefined },
  { image: "supabase/storage-api:v1.60.4", remoteService: "storage" },
  { image: "supabase/edge-runtime:v1.74.0", remoteService: undefined },
  {
    image: "supabase/studio:2026.06.03-sha-0bca601",
    remoteService: undefined,
  },
  { image: "supabase/postgres-meta:v0.96.6", remoteService: undefined },
  { image: "supabase/logflare:1.43.3", remoteService: undefined },
  { image: "supabase/supavisor:2.9.7", remoteService: undefined },
] as const satisfies ReadonlyArray<ServiceImageSpec>;

const TABLE_HEADERS = ["SERVICE IMAGE", "LOCAL", "LINKED"] as const;

type ProjectApiKey = {
  readonly name: string;
  readonly type?: "legacy" | "publishable" | "secret" | null;
  readonly api_key?: string | null;
  readonly secret_jwt_template?: Record<string, unknown> | null;
};

export interface ServiceVersionRow {
  readonly name: string;
  readonly local: string;
  readonly remote: string;
}

function toServiceVersionRow(
  service: ServiceImageSpec,
  remote: Partial<Record<RemoteServiceName, string>> = {},
): ServiceVersionRow {
  const parts = service.image.split(":");
  const name = parts[0];
  const local = parts[1];

  if (name === undefined || local === undefined) {
    throw new Error(`Invalid service image entry: ${service.image}`);
  }

  return {
    name,
    local,
    remote: service.remoteService === undefined ? "" : (remote[service.remoteService] ?? ""),
  };
}

export interface ServiceFetchConfig {
  readonly apiUrl: string;
  readonly projectHost: string;
  readonly projectRef: string;
  readonly accessToken?: Redacted.Redacted<string>;
  readonly userAgent: string;
  readonly headers?: Readonly<Record<string, string | undefined>>;
  readonly api?: ApiClient;
  readonly tenantBaseUrlOverride?: string;
}

class ServiceVersionNotFoundError extends Data.TaggedError("ServiceVersionNotFoundError")<{
  readonly service: string;
}> {}

function fieldValue(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return Reflect.get(value, key);
}

function stringField(value: unknown, key: string): string | undefined {
  const field = fieldValue(value, key);
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function selectTenantAccessKey<T extends ProjectApiKey>(
  keys: ReadonlyArray<T>,
): Redacted.Redacted<string> | undefined {
  for (const key of keys) {
    const template = key.secret_jwt_template;
    if (
      key.type === "secret" &&
      typeof key.api_key === "string" &&
      template != null &&
      typeof template === "object" &&
      !Array.isArray(template) &&
      typeof template.role === "string" &&
      template.role.toLowerCase() === "service_role"
    ) {
      return Redacted.make(key.api_key);
    }
  }

  for (const key of keys) {
    if (key.name === "service_role" && typeof key.api_key === "string") {
      return Redacted.make(key.api_key);
    }
  }
}

function hasProjectAccessKey<T extends ProjectApiKey>(keys: ReadonlyArray<T>): boolean {
  return keys.some((key) => {
    if (typeof key.api_key !== "string") {
      return false;
    }

    if (key.type === "publishable") {
      return true;
    }

    if (key.name === "anon") {
      return true;
    }

    if (key.name === "service_role") {
      return true;
    }

    return (
      key.type === "secret" &&
      key.secret_jwt_template != null &&
      typeof key.secret_jwt_template === "object" &&
      !Array.isArray(key.secret_jwt_template) &&
      typeof key.secret_jwt_template.role === "string" &&
      key.secret_jwt_template.role.toLowerCase() === "service_role"
    );
  });
}

const authenticatedRequest = (url: string, accessKey: Redacted.Redacted<string>) => {
  const key = Redacted.value(accessKey);
  const request = HttpClientRequest.get(url).pipe(HttpClientRequest.setHeader("apikey", key));
  // New-style `sb_…` keys authenticate via the `apikey` header alone; older JWT
  // keys additionally require a bearer token. Mirrors the conditional auth in
  // `apps/cli-go/pkg/fetcher/gateway.go` and `legacy/shared/legacy-tenant-versions.ts`.
  return key.startsWith("sb_")
    ? request
    : request.pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${key}`));
};

const fetchJson = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  url: string,
  accessKey: Redacted.Redacted<string>,
) {
  const request = authenticatedRequest(url, accessKey).pipe(HttpClientRequest.acceptJson);
  const response = yield* client.execute(request);
  return yield* response.json;
});

const fetchText = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  url: string,
  accessKey: Redacted.Redacted<string>,
) {
  const response = yield* client.execute(authenticatedRequest(url, accessKey));
  return yield* response.text;
});

const fetchPostgrestVersion = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  accessKey: Redacted.Redacted<string>,
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
  accessKey: Redacted.Redacted<string>,
) {
  const body = yield* fetchJson(client, `${baseUrl}/auth/v1/health`, accessKey);
  const version = stringField(body, "version")?.trim();

  if (version === undefined || version.length === 0) {
    return yield* Effect.fail(new ServiceVersionNotFoundError({ service: "auth" }));
  }

  return version;
});

const fetchStorageVersion = Effect.fnUntraced(function* (
  client: HttpClient.HttpClient,
  baseUrl: string,
  accessKey: Redacted.Redacted<string>,
) {
  const version = (yield* fetchText(client, `${baseUrl}/storage/v1/version`, accessKey)).trim();
  if (version.length === 0 || version === "0.0.0") {
    return yield* Effect.fail(new ServiceVersionNotFoundError({ service: "storage" }));
  }

  return version.startsWith("v") ? version : `v${version}`;
});

const fetchOptionalVersion = (
  service: OptionalRemoteServiceName,
  effect: Effect.Effect<string, unknown>,
) =>
  effect.pipe(
    Effect.exit,
    Effect.map((exit) => ({ service, exit }) as const),
  );

const makeConfiguredApiClient = Effect.fnUntraced(function* (input: ServiceFetchConfig) {
  return (
    input.api ??
    (yield* makeApiClient({
      baseUrl: input.apiUrl,
      accessToken: input.accessToken,
      userAgent: input.userAgent,
      headers: input.headers,
    }))
  );
});

export function listLocalServiceVersions(): ReadonlyArray<ServiceVersionRow> {
  return LOCAL_SERVICE_IMAGES.map((service) => toServiceVersionRow(service));
}

export function mergeRemoteServiceVersions(
  remote: Partial<Record<RemoteServiceName, string>>,
): ReadonlyArray<ServiceVersionRow> {
  return LOCAL_SERVICE_IMAGES.map((service) => toServiceVersionRow(service, remote));
}

export function renderServicesTable(rows: ReadonlyArray<ServiceVersionRow>): string {
  return renderGlamourTable(
    TABLE_HEADERS,
    rows.map((row) => [row.name, row.local, row.remote.length === 0 ? "-" : row.remote]),
  );
}

export function renderServicesWarning(rows: ReadonlyArray<ServiceVersionRow>): string | undefined {
  const mismatches = rows.filter((row) => row.remote.length > 0 && row.remote !== row.local);
  if (mismatches.length === 0) {
    return undefined;
  }

  return [
    "You are running different service versions locally than your linked project:",
    ...mismatches.map((row) => `${row.name}:${row.local} => ${row.remote}`),
    "Run supabase link to update them.",
  ].join("\n");
}

/**
 * Renders the linked-version mismatch warning for stderr. In text mode the
 * `WARNING:` prefix is colorized (matching Go's `utils.Yellow`); machine modes
 * keep it plain so the stderr line stays parseable.
 */
export function formatServicesWarning(message: string, textMode: boolean): string {
  const lines = message.split("\n");
  const prefix = textMode ? styleText("yellow", "WARNING:") : "WARNING:";
  const [first, ...rest] = lines;
  return `${prefix} ${first}\n${rest.join("\n")}\n`;
}

export function encodeLegacyTomlRows(rows: ReadonlyArray<ServiceVersionRow>) {
  return { services: rows } as const;
}

export function fetchLinkedServiceVersions(input: ServiceFetchConfig) {
  return Effect.gen(function* () {
    const exit = yield* Effect.gen(function* () {
      // Reject malformed refs before they reach the management API path param or
      // the tenant gateway hostname (`https://<ref>.<host>`). The override is
      // test-only, so it bypasses the check.
      if (
        input.tenantBaseUrlOverride === undefined &&
        !PROJECT_REF_PATTERN.test(input.projectRef)
      ) {
        return {} as Partial<Record<RemoteServiceName, string>>;
      }

      const client = yield* makeConfiguredApiClient(input);
      const httpClient = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);

      const apiKeysExit = yield* client.v1
        .getProjectApiKeys({ ref: input.projectRef, reveal: true })
        .pipe(Effect.exit);
      if (!Exit.isSuccess(apiKeysExit) || !hasProjectAccessKey(apiKeysExit.value)) {
        return {} as Partial<Record<RemoteServiceName, string>>;
      }

      let versions: Partial<Record<RemoteServiceName, string>> = {};
      const postgresExit = yield* client.v1.getProject({ ref: input.projectRef }).pipe(
        Effect.map((project) => project.database.version),
        Effect.exit,
      );
      if (Exit.isSuccess(postgresExit)) {
        versions = { ...versions, postgres: postgresExit.value };
      }

      const accessKey = selectTenantAccessKey(apiKeysExit.value);
      if (accessKey === undefined) {
        return versions;
      }

      const baseUrl =
        input.tenantBaseUrlOverride ?? `https://${input.projectRef}.${input.projectHost}`;
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
        }
      }

      return versions;
    }).pipe(Effect.exit);
    return Exit.isSuccess(exit) ? exit.value : ({} as Partial<Record<RemoteServiceName, string>>);
  });
}
