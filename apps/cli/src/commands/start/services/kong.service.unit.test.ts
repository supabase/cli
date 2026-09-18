import { BunPath } from "@effect/platform-bun";
import { Effect, Path } from "effect";
import { it } from "@effect/vitest";
import { describe, expect, test } from "vitest";

import {
  buildKongBearerToken,
  buildKongContainerSpec,
  buildKongEmailTemplateBind,
  buildKongEntrypointScript,
  buildKongQueryToken,
  resolveKongNginxWorkerProcesses,
  type KongApiKeys,
  type KongContainerSpecInput,
} from "./kong.service.ts";

const apiKeys: KongApiKeys = {
  secretKey: "sb_secret_abc",
  serviceRoleKey: "service-role-jwt",
  publishableKey: "sb_publishable_abc",
  anonKey: "anon-jwt",
};

describe("buildKongBearerToken", () => {
  test("builds the exact lua request-transformer expression (start.go:501-514)", () => {
    expect(buildKongBearerToken(apiKeys)).toBe(
      "$((headers.authorization ~= nil and headers.authorization:sub(1, 10) ~= 'Bearer sb_' and headers.authorization) " +
        "or (headers.apikey == 'sb_secret_abc' and 'Bearer service-role-jwt') " +
        "or (headers.apikey == 'sb_publishable_abc' and 'Bearer anon-jwt') " +
        "or headers.apikey)",
    );
  });
});

describe("buildKongQueryToken", () => {
  test("builds the exact lua query-param expression (start.go:515-521)", () => {
    expect(buildKongQueryToken(apiKeys)).toBe(
      "$((query_params.apikey == 'sb_secret_abc' and 'service-role-jwt') " +
        "or (query_params.apikey == 'sb_publishable_abc' and 'anon-jwt') " +
        "or query_params.apikey)",
    );
  });
});

describe("resolveKongNginxWorkerProcesses", () => {
  test('defaults to "1" when unset (start.go:1466-1471)', () => {
    expect(resolveKongNginxWorkerProcesses(undefined)).toBe("1");
  });

  test("uses a project dotenv-only value, matching Go's post-Load os.LookupEnv", () => {
    expect(resolveKongNginxWorkerProcesses({ KONG_NGINX_WORKER_PROCESSES: "auto" })).toBe("auto");
  });
});

describe("buildKongEmailTemplateBind", () => {
  // Resolution and containment checks live in `start.handler.ts`'s
  // `resolveKongEmailTemplateMounts`; this function only formats an
  // already-resolved `mount.resolvedPath`.

  it.effect("builds the bind string from an already-resolved resolvedPath", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      expect(
        buildKongEmailTemplateBind(
          { id: "invite", resolvedPath: "/work/invite.html" },
          { path, posixPath },
        ),
      ).toBe("/work/invite.html:/home/kong/templates/email/invite.html:rw,z");
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect("drops the extension when resolvedPath has none", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      expect(
        buildKongEmailTemplateBind(
          { id: "invite_notification", resolvedPath: "/work/invite" },
          { path, posixPath },
        ),
      ).toBe("/work/invite:/home/kong/templates/email/invite_notification:rw,z");
    }).pipe(Effect.provide(BunPath.layer));
  });
});

describe("buildKongEntrypointScript", () => {
  test("writes only the custom_nginx.template heredoc, then execs docker-entrypoint.sh (start.go:588-601, minus the secretFiles-carried heredocs)", () => {
    const script = buildKongEntrypointScript("NGINX_TEMPLATE");
    expect(script).toBe(
      "cat <<'EOF' > /home/kong/custom_nginx.template && \\\n" +
        "exec ./docker-entrypoint.sh kong docker-start --nginx-conf /home/kong/custom_nginx.template\n" +
        "NGINX_TEMPLATE\nEOF\n",
    );
  });

  test("no longer references kong.yml or the TLS cert/key paths at all", () => {
    const script = buildKongEntrypointScript("NGINX_TEMPLATE");
    expect(script).not.toContain("kong.yml");
    expect(script).not.toContain("localhost.crt");
    expect(script).not.toContain("localhost.key");
  });
});

const base: KongContainerSpecInput = {
  image: "supabase/kong:3.0.0",
  containerName: "supabase_kong_proj",
  networkId: "supabase_network_proj",
  apiHost: "localhost",
  apiPort: 54321,
  apiTlsEnabled: false,
  tlsCertContent: "",
  tlsKeyContent: "",
  apiKeys,
  gotrueId: "supabase_auth_proj",
  restId: "supabase_rest_proj",
  realtimeTenantId: "realtime-dev",
  storageId: "supabase_storage_proj",
  studioId: "supabase_studio_proj",
  pgmetaId: "supabase_pg_meta_proj",
  edgeRuntimeId: "supabase_edge_runtime_proj",
  logflareId: "supabase_analytics_proj",
  poolerId: "supabase_pooler_proj",
  nginxWorkerProcesses: "1",
};

describe("buildKongContainerSpec", () => {
  it.effect(
    "builds identity, entrypoint, restart policy, and network aliases (start.go:564-627)",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
        const spec = buildKongContainerSpec(base, { path, posixPath });
        expect(spec.image).toBe("supabase/kong:3.0.0");
        expect(spec.containerName).toBe("supabase_kong_proj");
        expect(spec.entrypoint).toBe("sh");
        expect(spec.cmd?.[0]).toBe("-c");
        expect(spec.restartPolicy).toBe("unless-stopped");
        expect(spec.networkId).toBe("supabase_network_proj");
        expect(spec.networkAliases).toEqual(["kong", "api.supabase.internal"]);
        expect(spec.labels).toEqual({});
        expect(spec.healthcheck).toBeUndefined();
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect("emits the fixed KONG_* env vars, including the resolved worker-process count", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      const spec = buildKongContainerSpec(base, { path, posixPath });
      expect(spec.env).toEqual({
        KONG_DATABASE: "off",
        KONG_DECLARATIVE_CONFIG: "/home/kong/kong.yml",
        KONG_DNS_ORDER: "LAST,A,CNAME",
        KONG_DNS_NOT_FOUND_TTL: "1",
        KONG_DNS_VALID_TTL: "5",
        KONG_PLUGINS: "request-transformer,cors",
        KONG_PORT_MAPS: "54321:8000",
        KONG_NGINX_PROXY_PROXY_BUFFER_SIZE: "160k",
        KONG_NGINX_PROXY_PROXY_BUFFERS: "64 160k",
        KONG_NGINX_WORKER_PROCESSES: "1",
        KONG_SSL_CERT: "/home/kong/localhost.crt",
        KONG_SSL_CERT_KEY: "/home/kong/localhost.key",
      });
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect(
    "publishes 8000 to the host and exposes 8000/8443/8088 when TLS is disabled (start.go:560-563,602-612)",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
        const spec = buildKongContainerSpec({ ...base, apiTlsEnabled: false }, { path, posixPath });
        expect(spec.ports).toEqual([{ hostPort: "54321", containerPort: "8000" }]);
        expect(spec.exposedPorts).toEqual([
          { containerPort: "8000" },
          { containerPort: "8443" },
          { containerPort: "8088" },
        ]);
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect("publishes 8443 to the host when TLS is enabled, exposed ports unchanged", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      const spec = buildKongContainerSpec({ ...base, apiTlsEnabled: true }, { path, posixPath });
      expect(spec.ports).toEqual([{ hostPort: "54321", containerPort: "8443" }]);
      expect(spec.exposedPorts).toEqual([
        { containerPort: "8000" },
        { containerPort: "8443" },
        { containerPort: "8088" },
      ]);
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect(
    "renders kong.yml using Config.Realtime.TenantId, not Realtime's container name (start.go:492)",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
        const spec = buildKongContainerSpec(base, { path, posixPath });
        const kongYml = spec.secretFiles?.find(
          (f) => f.containerPath === "/home/kong/kong.yml",
        )?.content;
        expect(kongYml).toContain("http://realtime-dev:4000/socket");
        expect(kongYml).not.toContain("supabase_realtime_proj");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect("embeds the bearer/query token lua expressions into the rendered kong.yml", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      const spec = buildKongContainerSpec(base, { path, posixPath });
      const kongYml = spec.secretFiles?.find(
        (f) => f.containerPath === "/home/kong/kong.yml",
      )?.content;
      expect(kongYml).toContain(buildKongBearerToken(apiKeys));
      expect(kongYml).toContain(buildKongQueryToken(apiKeys));
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect("has no email template binds by default", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      const spec = buildKongContainerSpec(base, { path, posixPath });
      expect(spec.binds).toEqual([]);
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect("mounts every resolved email template bind (start.go:544-558)", () => {
    return Effect.gen(function* () {
      const path = yield* Path.Path;
      const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
      const spec = buildKongContainerSpec(
        {
          ...base,
          emailTemplateMounts: [
            { id: "invite", resolvedPath: "/work/invite.html" },
            { id: "recovery_notification", resolvedPath: "/abs/recovery.html" },
          ],
        },
        { path, posixPath },
      );
      expect(spec.binds).toEqual([
        "/work/invite.html:/home/kong/templates/email/invite.html:rw,z",
        "/abs/recovery.html:/home/kong/templates/email/recovery_notification.html:rw,z",
      ]);
    }).pipe(Effect.provide(BunPath.layer));
  });

  it.effect(
    "carries kong.yml and the TLS cert/key as secretFiles at the exact paths KONG_DECLARATIVE_CONFIG/KONG_SSL_CERT/KONG_SSL_CERT_KEY reference, never in cmd (CWE-214/522)",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
        const spec = buildKongContainerSpec(
          {
            ...base,
            tlsCertContent: "-----BEGIN CERTIFICATE-----",
            tlsKeyContent: "-----BEGIN PRIVATE KEY-----",
          },
          { path, posixPath },
        );
        expect(spec.secretFiles).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ containerPath: "/home/kong/localhost.crt" }),
            expect.objectContaining({ containerPath: "/home/kong/localhost.key" }),
          ]),
        );
        const cert = spec.secretFiles?.find(
          (f) => f.containerPath === "/home/kong/localhost.crt",
        )?.content;
        const key = spec.secretFiles?.find(
          (f) => f.containerPath === "/home/kong/localhost.key",
        )?.content;
        expect(cert).toBe("-----BEGIN CERTIFICATE-----");
        expect(key).toBe("-----BEGIN PRIVATE KEY-----");

        const script = String(spec.cmd?.[1]);
        expect(script).not.toContain("-----BEGIN CERTIFICATE-----");
        expect(script).not.toContain("-----BEGIN PRIVATE KEY-----");
        expect(script).not.toContain("kong.yml");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );

  it.effect(
    "still carries (empty-content) TLS cert/key secretFiles entries when TLS is unconfigured — an unconditional bind, matching Go's always-written empty files",
    () => {
      return Effect.gen(function* () {
        const path = yield* Path.Path;
        const posixPath = yield* Effect.provide(Path.Path, BunPath.layerPosix);
        const spec = buildKongContainerSpec(base, { path, posixPath });
        const cert = spec.secretFiles?.find((f) => f.containerPath === "/home/kong/localhost.crt");
        const key = spec.secretFiles?.find((f) => f.containerPath === "/home/kong/localhost.key");
        expect(cert?.content).toBe("");
        expect(key?.content).toBe("");
      }).pipe(Effect.provide(BunPath.layer));
    },
  );
});
