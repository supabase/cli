import { describe, expect, it, test } from "@effect/vitest";
import { Deferred, Effect, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  legacyBuildVectorContainerSpec,
  legacyBuildVectorEntrypointScript,
  legacyParseDockerHostUrl,
  legacyPlatformDefaultDockerHost,
  legacyResolveDockerDaemonHost,
  legacyResolveVectorDockerSocketPlan,
  legacyShouldMountRootDockerSocket,
  legacySplitHostPortPort,
  type LegacyVectorContainerSpecInput,
  type LegacyVectorDockerSocketPlan,
} from "./vector.service.ts";

/** Matches the standing `mockSpawner` shape in `image-prepull.unit.test.ts`. */
function mockSpawner(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      const result = handler(args);

      const exitDeferred = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      yield* Deferred.succeed(exitDeferred, ChildProcessSpawner.ExitCode(result.exitCode));

      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        stdout: Stream.fromIterable(
          result.stdout !== undefined ? [encoder.encode(result.stdout)] : [],
        ),
        stderr: Stream.fromIterable(
          result.stderr !== undefined ? [encoder.encode(result.stderr)] : [],
        ),
        all: Stream.empty,
        exitCode: Deferred.await(exitDeferred),
        isRunning: Effect.succeed(false),
        stdin: Sink.drain,
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );

  return {
    spawner,
    get spawned() {
      return spawned;
    },
  };
}

describe("legacyParseDockerHostUrl", () => {
  test("splits a tcp host into scheme/host", () => {
    expect(legacyParseDockerHostUrl("tcp://127.0.0.1:2375")).toEqual({
      scheme: "tcp",
      host: "127.0.0.1:2375",
    });
  });

  test("splits a unix socket host", () => {
    expect(legacyParseDockerHostUrl("unix:///var/run/docker.sock")).toEqual({
      scheme: "unix",
      host: "/var/run/docker.sock",
    });
  });

  test("splits an npipe host", () => {
    expect(legacyParseDockerHostUrl("npipe:////./pipe/docker_engine")).toEqual({
      scheme: "npipe",
      host: "//./pipe/docker_engine",
    });
  });

  test("strips a trailing path from a tcp host, matching Go's url.Parse round-trip", () => {
    expect(legacyParseDockerHostUrl("tcp://127.0.0.1:2375/some/path")).toEqual({
      scheme: "tcp",
      host: "127.0.0.1:2375",
    });
  });

  test("throws on a host with no scheme separator", () => {
    expect(() => legacyParseDockerHostUrl("not-a-host")).toThrow();
  });

  test("throws on an empty address", () => {
    expect(() => legacyParseDockerHostUrl("tcp://")).toThrow();
  });
});

describe("legacySplitHostPortPort", () => {
  test("extracts the port from host:port", () => {
    expect(legacySplitHostPortPort("127.0.0.1:2375")).toBe("2375");
  });

  test("returns undefined when there is no port", () => {
    expect(legacySplitHostPortPort("127.0.0.1")).toBeUndefined();
  });

  test("returns undefined when the trailing segment isn't numeric", () => {
    expect(legacySplitHostPortPort("host:not-a-port")).toBeUndefined();
  });
});

describe("legacyShouldMountRootDockerSocket", () => {
  test("recognizes Docker Desktop's current rootful socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/Users/me/.docker/run/docker.sock")).toBe(true);
  });

  test("recognizes Docker Desktop's older rootful socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/Users/me/.docker/desktop/docker.sock")).toBe(true);
  });

  test("recognizes any Colima profile's socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/Users/me/.colima/default/docker.sock")).toBe(true);
  });

  test("recognizes Colima's default (unprofiled) socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/Users/me/.colima/docker.sock")).toBe(true);
  });

  test("does not match a Podman rootless socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/run/user/1000/podman/podman.sock")).toBe(false);
  });

  test("does not match an OrbStack socket path", () => {
    expect(legacyShouldMountRootDockerSocket("/Users/me/.orbstack/run/docker.sock")).toBe(false);
  });

  test("does not match a bare Linux root socket path (never reached in practice, since that branch never checks it)", () => {
    expect(legacyShouldMountRootDockerSocket("/var/run/docker.sock")).toBe(false);
  });
});

describe("legacyPlatformDefaultDockerHost", () => {
  test("resolves the unix default off Windows", () => {
    expect(legacyPlatformDefaultDockerHost("darwin")).toBe("unix:///var/run/docker.sock");
    expect(legacyPlatformDefaultDockerHost("linux")).toBe("unix:///var/run/docker.sock");
  });

  test("resolves the npipe default on Windows", () => {
    expect(legacyPlatformDefaultDockerHost("win32")).toBe("npipe:////./pipe/docker_engine");
  });
});

describe("legacyResolveVectorDockerSocketPlan", () => {
  test("tcp: proxies through host.docker.internal on the daemon's own port, no binds/securityOpt (start.go:422-426)", () => {
    const plan = legacyResolveVectorDockerSocketPlan("tcp://127.0.0.1:2376");
    expect(plan).toEqual<LegacyVectorDockerSocketPlan>({
      env: { DOCKER_HOST: "http://host.docker.internal:2376" },
      binds: [],
      securityOpt: [],
      isNpipe: false,
    });
  });

  test("tcp: falls back to the default DinD port 2375 when the host string has no parseable port", () => {
    const plan = legacyResolveVectorDockerSocketPlan("tcp://myhost");
    expect(plan.env).toEqual({ DOCKER_HOST: "http://host.docker.internal:2375" });
  });

  test("npipe: proxies through host.docker.internal:2375 and flags isNpipe (start.go:427-430,481)", () => {
    const plan = legacyResolveVectorDockerSocketPlan("npipe:////./pipe/docker_engine");
    expect(plan).toEqual<LegacyVectorDockerSocketPlan>({
      env: { DOCKER_HOST: "http://host.docker.internal:2375" },
      binds: [],
      securityOpt: [],
      isNpipe: true,
    });
  });

  test("unix + known rootful socket (Docker Desktop): binds the STANDARD socket path to itself, no env/securityOpt (start.go:431-437)", () => {
    const plan = legacyResolveVectorDockerSocketPlan(
      "unix:///Users/me/.docker/run/docker.sock",
      "darwin",
    );
    expect(plan).toEqual<LegacyVectorDockerSocketPlan>({
      env: {},
      binds: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
      securityOpt: [],
      isNpipe: false,
    });
  });

  test("unix + known rootful socket (Colima): same standard-socket-to-itself bind", () => {
    const plan = legacyResolveVectorDockerSocketPlan(
      "unix:///Users/me/.colima/default/docker.sock",
      "darwin",
    );
    expect(plan.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock:ro"]);
    expect(plan.securityOpt).toEqual([]);
  });

  test("unix + rootless socket (Podman/OrbStack): binds the ACTUAL detected path onto the standard path, plus label:disable (start.go:438-442)", () => {
    const plan = legacyResolveVectorDockerSocketPlan(
      "unix:///run/user/1000/podman/podman.sock",
      "linux",
    );
    expect(plan).toEqual<LegacyVectorDockerSocketPlan>({
      env: {},
      binds: ["/run/user/1000/podman/podman.sock:/var/run/docker.sock:ro"],
      securityOpt: ["label:disable"],
      isNpipe: false,
    });
  });

  test("unix on a Windows-platform default (edge case): recomputes the platform default as npipe", () => {
    const plan = legacyResolveVectorDockerSocketPlan("unix:///run/user/1000/podman.sock", "win32");
    expect(plan.binds).toEqual(["/run/user/1000/podman.sock://./pipe/docker_engine:ro"]);
    expect(plan.securityOpt).toEqual(["label:disable"]);
  });
});

describe("legacyBuildVectorEntrypointScript", () => {
  test("writes vector.yaml then waits on Logflare's health endpoint before exec'ing vector (start.go:449-454)", () => {
    expect(legacyBuildVectorEntrypointScript("VECTOR_YAML", "supabase_analytics_proj")).toBe(
      "cat <<'EOF' > /etc/vector/vector.yaml\n" +
        "VECTOR_YAML" +
        "\nEOF\nuntil wget --no-verbose --tries=1 --spider http://" +
        "supabase_analytics_proj" +
        ":4000/health 2>/dev/null; do sleep 2; done\nvector --config /etc/vector/vector.yaml\n",
    );
  });
});

const base: LegacyVectorContainerSpecInput = {
  image: "supabase/vector:0.28.1",
  containerName: "supabase_vector_proj",
  networkId: "supabase_network_proj",
  apiKey: "api-key",
  logflareId: "supabase_analytics_proj",
  kongId: "supabase_kong_proj",
  gotrueId: "supabase_auth_proj",
  restId: "supabase_rest_proj",
  realtimeId: "supabase_realtime_proj",
  storageId: "supabase_storage_proj",
  edgeRuntimeId: "supabase_edge_runtime_proj",
  dbId: "supabase_db_proj",
  dockerSocketPlan: { env: {}, binds: [], securityOpt: [], isNpipe: false },
};

describe("legacyBuildVectorContainerSpec", () => {
  test("builds identity, entrypoint, healthcheck, restart policy, network aliases (start.go:444-477)", () => {
    const spec = legacyBuildVectorContainerSpec(base);
    expect(spec.image).toBe("supabase/vector:0.28.1");
    expect(spec.containerName).toBe("supabase_vector_proj");
    expect(spec.entrypoint).toBe("sh");
    expect(spec.cmd?.[0]).toBe("-c");
    expect(spec.healthcheck).toEqual({
      test: [
        "CMD",
        "wget",
        "--no-verbose",
        "--tries=1",
        "--spider",
        "http://127.0.0.1:9001/health",
      ],
      intervalSeconds: 10,
      timeoutSeconds: 2,
      retries: 3,
    });
    expect(spec.restartPolicy).toBe("unless-stopped");
    expect(spec.networkId).toBe("supabase_network_proj");
    expect(spec.networkAliases).toEqual(["vector"]);
    expect(spec.labels).toEqual({});
  });

  test("passes the docker-socket plan's env/binds/securityOpt straight through", () => {
    const spec = legacyBuildVectorContainerSpec({
      ...base,
      dockerSocketPlan: {
        env: { DOCKER_HOST: "http://host.docker.internal:2375" },
        binds: ["/var/run/docker.sock:/var/run/docker.sock:ro"],
        securityOpt: ["label:disable"],
        isNpipe: false,
      },
    });
    expect(spec.env).toEqual({ DOCKER_HOST: "http://host.docker.internal:2375" });
    expect(spec.binds).toEqual(["/var/run/docker.sock:/var/run/docker.sock:ro"]);
    expect(spec.securityOpt).toEqual(["label:disable"]);
  });

  test("renders vector.yaml using the container's own name as VectorId and excludes it from docker_logs", () => {
    const spec = legacyBuildVectorContainerSpec(base);
    const script = String(spec.cmd?.[1]);
    expect(script).toContain('"supabase_vector_proj"');
    expect(script).toContain('.appname == "supabase_kong_proj"');
  });
});

describe("legacyResolveDockerDaemonHost", () => {
  it.live("prefers an explicit DOCKER_HOST env var over any context inspection", () => {
    const mock = mockSpawner(() => ({ exitCode: 1 }));
    return legacyResolveDockerDaemonHost(
      mock.spawner,
      { DOCKER_HOST: "tcp://127.0.0.1:2376" },
      "darwin",
    ).pipe(
      Effect.map((host) => {
        expect(host).toBe("tcp://127.0.0.1:2376");
        expect(mock.spawned).toHaveLength(0);
      }),
    );
  });

  it.live("falls back to the current docker context's endpoint when DOCKER_HOST is unset", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "context" && args[1] === "inspect") {
        return { exitCode: 0, stdout: "unix:///Users/me/.colima/default/docker.sock\n" };
      }
      return { exitCode: 1 };
    });
    return legacyResolveDockerDaemonHost(mock.spawner, {}, "darwin").pipe(
      Effect.map((host) => {
        expect(host).toBe("unix:///Users/me/.colima/default/docker.sock");
      }),
    );
  });

  it.live("falls back to the platform default when docker context inspect fails", () => {
    const mock = mockSpawner(() => ({ exitCode: 1 }));
    return legacyResolveDockerDaemonHost(mock.spawner, {}, "darwin").pipe(
      Effect.map((host) => {
        expect(host).toBe("unix:///var/run/docker.sock");
      }),
    );
  });

  it.live(
    "falls back to the platform default when docker context inspect returns an empty host",
    () => {
      const mock = mockSpawner(() => ({ exitCode: 0, stdout: "\n" }));
      return legacyResolveDockerDaemonHost(mock.spawner, {}, "win32").pipe(
        Effect.map((host) => {
          expect(host).toBe("npipe:////./pipe/docker_engine");
        }),
      );
    },
  );

  it.live(
    "treats an empty DOCKER_HOST value as unset, falling through to context inspection",
    () => {
      const mock = mockSpawner((args) => {
        if (args[0] === "context" && args[1] === "inspect") {
          return { exitCode: 0, stdout: "tcp://127.0.0.1:2376\n" };
        }
        return { exitCode: 1 };
      });
      return legacyResolveDockerDaemonHost(mock.spawner, { DOCKER_HOST: "" }, "darwin").pipe(
        Effect.map((host) => {
          expect(host).toBe("tcp://127.0.0.1:2376");
        }),
      );
    },
  );
});
