import { describe, expect, test } from "vitest";

import {
  legacyBuildStartContainerCreateArgs,
  legacyApplyBitbucketStartContainerFilter,
  legacyBuildHealthCmdArg,
  legacyIsDockerClientEnvKey,
  type LegacyStartContainerSpec,
} from "./docker-create-args.ts";

// Mirrors the Logflare/analytics container (`start.go:350-394`): the fullest
// worked example in the Go source — Hostname, Entrypoint+Cmd, exec-form
// Healthcheck with StartPeriod, ExposedPorts alongside a matching
// PortBinding, RestartPolicy, and network aliases.
const full: LegacyStartContainerSpec = {
  image: "supabase/logflare:1.0.0",
  containerName: "supabase_analytics_proj",
  hostname: "127.0.0.1",
  env: { DB_PASSWORD: "super-secret", DB_HOSTNAME: "supabase_db_proj" },
  entrypoint: "sh",
  cmd: ["-c", "./logflare start"],
  binds: ["/host/gcloud.json:/opt/app/gcloud.json"],
  volumesFrom: ["supabase_storage_proj"],
  tmpfs: { "/docker-entrypoint-initdb.d": "" },
  ports: [{ hostPort: "4000", containerPort: "4000" }],
  exposedPorts: [{ containerPort: "4000" }],
  healthcheck: {
    test: ["CMD", "curl", "-sSfL", "--head", "-o", "/dev/null", "http://127.0.0.1:4000/health"],
    intervalSeconds: 10,
    timeoutSeconds: 2,
    retries: 3,
    startPeriodSeconds: 10,
  },
  restartPolicy: "unless-stopped",
  securityOpt: ["label:disable"],
  extraHosts: ["host.docker.internal:host-gateway"],
  networkId: "supabase_network_proj",
  networkAliases: ["analytics"],
  labels: {
    "com.supabase.cli.project": "proj",
    "com.docker.compose.project": "proj",
  },
};

describe("legacyBuildStartContainerCreateArgs", () => {
  test("assembles full-option argv in the documented fixed order", () => {
    expect(legacyBuildStartContainerCreateArgs(full)).toEqual([
      "create",
      "--name",
      "supabase_analytics_proj",
      "--hostname",
      "127.0.0.1",
      "-e",
      "DB_PASSWORD",
      "-e",
      "DB_HOSTNAME",
      "-v",
      "/host/gcloud.json:/opt/app/gcloud.json",
      "--volumes-from",
      "supabase_storage_proj",
      "--tmpfs",
      "/docker-entrypoint-initdb.d",
      "-p",
      "4000:4000",
      "--expose",
      "4000",
      "--health-cmd",
      "curl -sSfL --head -o /dev/null http://127.0.0.1:4000/health",
      "--health-interval",
      "10s",
      "--health-timeout",
      "2s",
      "--health-retries",
      "3",
      "--health-start-period",
      "10s",
      "--restart",
      "unless-stopped",
      "--security-opt",
      "label:disable",
      "--add-host",
      "host.docker.internal:host-gateway",
      "--network",
      "supabase_network_proj",
      "--network-alias",
      "analytics",
      "--label",
      "com.supabase.cli.project=proj",
      "--label",
      "com.docker.compose.project=proj",
      "--entrypoint",
      "sh",
      "supabase/logflare:1.0.0",
      "-c",
      "./logflare start",
    ]);
  });

  test("emits only required flags for the minimal-options case", () => {
    const minimal: LegacyStartContainerSpec = {
      image: "supabase/postgres-meta:v1",
      containerName: "supabase_pg_meta_proj",
      env: {},
      binds: [],
      networkId: "supabase_network_proj",
      labels: {},
    };
    expect(legacyBuildStartContainerCreateArgs(minimal)).toEqual([
      "create",
      "--name",
      "supabase_pg_meta_proj",
      "--network",
      "supabase_network_proj",
      "supabase/postgres-meta:v1",
    ]);
  });

  test("omits --name entirely when containerName is empty (Docker auto-generates one, e.g. the shadow database)", () => {
    const spec: LegacyStartContainerSpec = {
      image: "supabase/postgres:17.4.1.030",
      containerName: "",
      env: {},
      binds: [],
      networkId: "supabase_network_proj",
      labels: {},
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args).not.toContain("--name");
    expect(args).toEqual(["create", "--network", "supabase_network_proj", spec.image]);
  });

  test("emits --rm when autoRemove is true, omits it otherwise", () => {
    const base: LegacyStartContainerSpec = {
      image: "supabase/postgres:17.4.1.030",
      containerName: "",
      env: {},
      binds: [],
      networkId: "supabase_network_proj",
      labels: {},
    };
    expect(legacyBuildStartContainerCreateArgs(base)).not.toContain("--rm");
    expect(legacyBuildStartContainerCreateArgs({ ...base, autoRemove: true })).toContain("--rm");
    expect(legacyBuildStartContainerCreateArgs({ ...base, autoRemove: false })).not.toContain(
      "--rm",
    );
  });

  test("never serializes env values into argv (CWE-214: secrets must not leak to ps)", () => {
    const args = legacyBuildStartContainerCreateArgs(full);
    expect(args).toContain("DB_PASSWORD");
    expect(args.some((a) => a.includes("super-secret"))).toBe(false);
    // Every -e argument is a bare key: no '=' anywhere in an -e value.
    const envValues = args.flatMap((a, i) => (args[i - 1] === "-e" ? [a] : []));
    expect(envValues.every((v) => !v.includes("="))).toBe(true);
  });

  test("emits DOCKER_HOST inline as -e KEY=value, not key-only, since it's not a secret (Vector's tcp/npipe daemon host)", () => {
    const spec: LegacyStartContainerSpec = {
      image: "timberio/vector:0.36.0-alpine",
      containerName: "supabase_vector_proj",
      env: { DOCKER_HOST: "http://host.docker.internal:2375", API_KEY: "super-secret" },
      binds: [],
      networkId: "supabase_network_proj",
      labels: {},
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args).toContain("-e");
    const dockerHostIndex = args.indexOf("DOCKER_HOST=http://host.docker.internal:2375");
    expect(dockerHostIndex).toBeGreaterThan(-1);
    expect(args[dockerHostIndex - 1]).toBe("-e");
    // The genuine secret alongside it must still stay key-only.
    expect(args).toContain("API_KEY");
    expect(args.some((a) => a.includes("super-secret"))).toBe(false);
  });

  test("legacyIsDockerClientEnvKey recognizes Docker/Podman client env vars and nothing else", () => {
    expect(legacyIsDockerClientEnvKey("DOCKER_HOST")).toBe(true);
    expect(legacyIsDockerClientEnvKey("DOCKER_TLS_VERIFY")).toBe(true);
    expect(legacyIsDockerClientEnvKey("DOCKER_CERT_PATH")).toBe(true);
    expect(legacyIsDockerClientEnvKey("DOCKER_CONTEXT")).toBe(true);
    expect(legacyIsDockerClientEnvKey("DOCKER_API_VERSION")).toBe(true);
    // `docker/cli`'s `EnvOverrideConfigDir` (`cli/config/config.go:25`) — also read by
    // `legacyGetHostname`'s `dockerConfigDir()`, so a project-dotenv-only override must reach
    // `process.env` the same way `DOCKER_HOST`/`DOCKER_CONTEXT` already do (review: PRRT_kwDOErm0O86Vk-ex).
    expect(legacyIsDockerClientEnvKey("DOCKER_CONFIG")).toBe(true);
    expect(legacyIsDockerClientEnvKey("DB_PASSWORD")).toBe(false);
  });

  test("omits the protocol suffix for tcp ports and adds /udp when specified", () => {
    const spec: LegacyStartContainerSpec = {
      image: "img",
      containerName: "c",
      env: {},
      binds: [],
      networkId: "net",
      labels: {},
      ports: [
        { hostPort: "53", containerPort: "53", protocol: "udp" },
        { hostPort: "80", containerPort: "80" },
        { hostPort: "81", containerPort: "81", protocol: "tcp" },
      ],
      exposedPorts: [{ containerPort: "9999" }, { containerPort: "9998", protocol: "udp" }],
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args).toEqual(
      expect.arrayContaining([
        "-p",
        "53:53/udp",
        "-p",
        "80:80",
        "-p",
        "81:81",
        "--expose",
        "9999",
        "--expose",
        "9998/udp",
      ]),
    );
  });

  test("emits --tmpfs with :options only when options are non-empty", () => {
    const spec: LegacyStartContainerSpec = {
      image: "img",
      containerName: "c",
      env: {},
      binds: [],
      networkId: "net",
      labels: {},
      tmpfs: { "/tmp/bare": "", "/tmp/opts": "rw,size=100m" },
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args).toEqual(
      expect.arrayContaining(["--tmpfs", "/tmp/bare", "--tmpfs", "/tmp/opts:rw,size=100m"]),
    );
  });

  test("emits cmd tokens after the image even when entrypoint is absent (Pooler: start.go:1234-1237)", () => {
    const spec: LegacyStartContainerSpec = {
      image: "supabase/supavisor:2.0.0",
      containerName: "supabase_pooler_proj",
      env: {},
      binds: [],
      networkId: "net",
      labels: {},
      cmd: ["/bin/sh", "-c", "/app/bin/migrate && /app/bin/server"],
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args).not.toContain("--entrypoint");
    const imageIdx = args.indexOf("supabase/supavisor:2.0.0");
    expect(args.slice(imageIdx)).toEqual([
      "supabase/supavisor:2.0.0",
      "/bin/sh",
      "-c",
      "/app/bin/migrate && /app/bin/server",
    ]);
  });

  test("omits health flags entirely when healthcheck is absent (Kong/PostgREST: start.go:975)", () => {
    const spec: LegacyStartContainerSpec = {
      image: "kong:3",
      containerName: "supabase_kong_proj",
      env: {},
      binds: [],
      networkId: "net",
      labels: {},
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args.some((a) => a.startsWith("--health"))).toBe(false);
  });

  test("never reads spec.secretFiles — the pure builder emits nothing from it (container-lifecycle.ts alone `docker cp`s it into the container, CWE-214/522)", () => {
    const spec: LegacyStartContainerSpec = {
      image: "kong:3",
      containerName: "supabase_kong_proj",
      env: {},
      binds: ["/host/other.txt:/etc/other.txt"],
      networkId: "net",
      labels: {},
      secretFiles: [{ containerPath: "/etc/secret.yml", content: "top-secret-content" }],
    };
    const args = legacyBuildStartContainerCreateArgs(spec);
    expect(args.some((a) => a.includes("top-secret-content"))).toBe(false);
    expect(args.some((a) => a.includes("/etc/secret.yml"))).toBe(false);
    // Only the spec's own `binds` entries are ever emitted — secretFiles contributes nothing.
    expect(args.filter((a) => a === "-v")).toHaveLength(1);
  });
});

describe("legacyBuildHealthCmdArg", () => {
  test("forwards CMD-SHELL scripts verbatim, with no quoting applied", () => {
    const script = `node --eval="fetch('http://127.0.0.1:8080/health').then((r) => {if (!r.ok) throw new Error(r.status)})"`;
    expect(legacyBuildHealthCmdArg(["CMD-SHELL", script])).toBe(script);
  });

  test("shell-quotes each exec-form argument and joins with spaces", () => {
    expect(
      legacyBuildHealthCmdArg([
        "CMD",
        "curl",
        "-sSfL",
        "--head",
        "-o",
        "/dev/null",
        "http://127.0.0.1:4000/health",
      ]),
    ).toBe("curl -sSfL --head -o /dev/null http://127.0.0.1:4000/health");
  });

  test("quotes an exec-form argument containing spaces so the container shell re-splits it back to one token", () => {
    expect(legacyBuildHealthCmdArg(["CMD", "echo", "hello world"])).toBe("echo 'hello world'");
  });

  test("escapes an embedded single quote using the '\\'' POSIX technique", () => {
    expect(legacyBuildHealthCmdArg(["CMD", "echo", "it's here"])).toBe("echo 'it'\\''s here'");
  });
});

describe("legacyApplyBitbucketStartContainerFilter", () => {
  const dbLike: LegacyStartContainerSpec = {
    image: "supabase/postgres:15",
    containerName: "supabase_db_proj",
    env: {},
    binds: ["supabase_db_proj:/var/lib/postgresql/data", "/repo/backup.sql:/etc/backup.sql:ro"],
    networkId: "net",
    labels: {},
    securityOpt: ["label:disable"],
    tmpfs: { "/docker-entrypoint-initdb.d": "" },
    volumesFrom: ["supabase_storage_proj"],
  };

  test("passes the spec through unchanged outside Bitbucket", () => {
    expect(legacyApplyBitbucketStartContainerFilter(dbLike, false)).toBe(dbLike);
  });

  test("drops named-volume binds and clears security-opt under Bitbucket, leaving tmpfs/volumesFrom untouched", () => {
    const filtered = legacyApplyBitbucketStartContainerFilter(dbLike, true);
    expect(filtered.binds).toEqual(["/repo/backup.sql:/etc/backup.sql:ro"]);
    expect(filtered.securityOpt).toEqual([]);
    expect(filtered.tmpfs).toEqual({ "/docker-entrypoint-initdb.d": "" });
    expect(filtered.volumesFrom).toEqual(["supabase_storage_proj"]);
  });
});
