import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach } from "vitest";

import {
  LegacyContainerCreateError,
  LegacyContainerRemoveError,
  LegacyContainerStartError,
  LegacyNetworkCreateError,
  LegacyVolumeCreateError,
  LegacyVolumeInspectError,
  LegacyVolumeRemoveError,
  legacyEnsureNetwork,
  legacyEnsureVolume,
  legacyRemoveContainer,
  legacyRemoveVolume,
  legacyCreateContainer,
  legacyVolumeExists,
} from "./container-lifecycle.ts";
import type { LegacyStartContainerSpec } from "./docker-create-args.ts";

let workdir: string;

beforeEach(() => {
  workdir = mkdtempSync(join(tmpdir(), "supabase-legacy-start-container-lifecycle-"));
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

/** Matches the standing `mockSpawner` shape used across `legacy-docker-*.unit.test.ts` files, generalized to a per-call handler for multi-step orchestration (volume create -> container create -> container start). */
function mockSpawner(
  handler: (args: ReadonlyArray<string>) => { exitCode: number; stdout?: string; stderr?: string },
) {
  const encoder = new TextEncoder();
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawnedOptions: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: Record<string, string | undefined> | undefined;
    readonly extendEnv: boolean | undefined;
    readonly stdin: ChildProcess.CommandInput | ChildProcess.StdinConfig | undefined;
  }> = [];

  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const args = command._tag === "StandardCommand" ? command.args : [];
      spawned.push(args);
      if (command._tag === "StandardCommand") {
        spawnedOptions.push({
          args,
          env: command.options.env,
          extendEnv: command.options.extendEnv,
          stdin: command.options.stdin,
        });
      }
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
    get spawnedOptions() {
      return spawnedOptions;
    },
  };
}

function tarRegularFileModes(archive: Uint8Array): ReadonlyArray<number> {
  const decoder = new TextDecoder();
  const parseOctal = (field: Uint8Array) =>
    Number.parseInt(decoder.decode(field).replaceAll("\0", "").trim() || "0", 8);
  const modes: Array<number> = [];
  let offset = 0;

  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const type = header[156];
    if (type === 0 || type === 0x30) modes.push(parseOctal(header.subarray(100, 108)));

    const size = parseOctal(header.subarray(124, 136));
    offset += 512 + Math.ceil(size / 512) * 512;
  }

  return modes;
}

const baseSpec: LegacyStartContainerSpec = {
  image: "public.ecr.aws/supabase/postgres:15",
  containerName: "supabase_db_proj",
  env: {},
  binds: ["supabase_db_proj:/var/lib/postgresql/data", "/repo/backup.sql:/etc/backup.sql:ro"],
  securityOpt: ["label:disable"],
  networkId: "supabase_network_proj",
  networkAliases: ["db"],
  labels: {},
};

function alwaysSucceed(stdout = "container-id-123\n") {
  return mockSpawner((args) => {
    if (args[0] === "create") return { exitCode: 0, stdout };
    return { exitCode: 0 };
  });
}

describe("legacyCreateContainer", () => {
  it.live(
    "merges project + compose labels, provisions named volumes, then creates and starts",
    () => {
      const mock = alwaysSucceed();
      return legacyCreateContainer(mock.spawner, baseSpec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map((containerId) => {
          expect(containerId).toBe("container-id-123");

          const volumeCreate = mock.spawned.find(
            (args) => args[0] === "volume" && args[1] === "create",
          );
          expect(volumeCreate).toEqual([
            "volume",
            "create",
            "--label",
            "com.supabase.cli.project=proj",
            "--label",
            "com.docker.compose.project=proj",
            "supabase_db_proj",
          ]);

          const create = mock.spawned.find((args) => args[0] === "create");
          expect(create).toContain("--label");
          expect(create).toContain("com.supabase.cli.project=proj");
          expect(create).toContain("com.docker.compose.project=proj");
          // Both the named-volume bind and the plain bind mount survive outside Bitbucket.
          expect(create).toContain("supabase_db_proj:/var/lib/postgresql/data");
          expect(create).toContain("/repo/backup.sql:/etc/backup.sql:ro");
          expect(create).toContain("--security-opt");

          const start = mock.spawned.find((args) => args[0] === "start");
          expect(start).toEqual(["start", "container-id-123"]);

          // Order matters: the volume must exist before `docker create` references it.
          expect(mock.spawned.map((args) => args[0])).toEqual(["volume", "create", "start"]);
        }),
      );
    },
  );

  it.live(
    "stamps the container (but not its named volumes) with a com.supabase.cli.workdir label matching opts.workdir",
    () => {
      // Read back later by `legacyListContainerIdsAndNames` so a subsequent `stop`/rollback can
      // reclaim `legacyCleanupStartSecrets`'s staged-secret directory from the CONTAINER's own
      // label rather than the invoking caller's own cwd/`--workdir` (see that label's doc
      // comment, `legacy-docker-ids.ts`). Volumes deliberately do NOT get this label — nothing
      // ever reads it back off a volume, and the "merges project + compose labels..." test above
      // already pins the volume's label list to exactly the two project-identity labels via
      // `toEqual`, so a regression that leaked the workdir label onto volumes too would fail that
      // test's exact-match assertion.
      const mock = alwaysSucceed();
      return legacyCreateContainer(mock.spawner, baseSpec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map(() => {
          const create = mock.spawned.find((args) => args[0] === "create");
          expect(create).toContain(`com.supabase.cli.workdir=${workdir}`);
        }),
      );
    },
  );

  it.live(
    "passes the spec's env values through the spawned process's own environment, extending it",
    () => {
      // `docker-create-args.ts` emits the key-only `-e KEY` form (never `-e KEY=value`) so
      // secrets never appear in argv — Docker then resolves each key's value from the
      // spawned `docker create` process's own environment. If `env`/`extendEnv` are ever
      // dropped from the spawn call again, every `-e KEY` flag silently resolves to nothing
      // and every container starts with none of its configured environment.
      const mock = alwaysSucceed();
      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        env: { POSTGRES_PASSWORD: "s3cret", JWT_SECRET: "super-secret-value" },
      };
      return legacyCreateContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map(() => {
          const create = mock.spawnedOptions.find((entry) => entry.args[0] === "create");
          expect(create?.env).toEqual({
            POSTGRES_PASSWORD: "s3cret",
            JWT_SECRET: "super-secret-value",
          });
          expect(create?.extendEnv).toBe(true);
        }),
      );
    },
  );

  it.live(
    "excludes DOCKER_HOST from the spawned docker create process's own env, even though it's in spec.env (Vector's tcp/npipe daemon host)",
    () => {
      // `env`/`extendEnv: true` merge `spec.env` INTO the spawned `docker create` process's own
      // environment (see the previous test) — but `DOCKER_HOST` configures which daemon the
      // `docker`/`podman` CLI CLIENT itself talks to, not a container env var read via `-e KEY`.
      // Letting a container-facing `DOCKER_HOST` (e.g. Vector's `http://host.docker.internal:...`
      // for a tcp/npipe daemon host) leak into the spawned process's own env would hijack which
      // daemon this `docker create` call itself targets, before the container even exists.
      const mock = alwaysSucceed();
      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        env: { DOCKER_HOST: "http://host.docker.internal:2375", API_KEY: "s3cret" },
      };
      return legacyCreateContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map(() => {
          const create = mock.spawnedOptions.find((entry) => entry.args[0] === "create");
          expect(create?.env).toEqual({ API_KEY: "s3cret" });
          expect(create?.args).toContain("DOCKER_HOST=http://host.docker.internal:2375");
        }),
      );
    },
  );

  it.live(
    "skips volume creation and drops the named-volume bind + security-opt under Bitbucket Pipelines",
    () => {
      const mock = alwaysSucceed();
      return legacyCreateContainer(mock.spawner, baseSpec, {
        projectId: "proj",
        isBitbucketPipeline: true,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map(() => {
          expect(mock.spawned.some((args) => args[0] === "volume")).toBe(false);

          const create = mock.spawned.find((args) => args[0] === "create");
          expect(create).not.toContain("supabase_db_proj:/var/lib/postgresql/data");
          expect(create).toContain("/repo/backup.sql:/etc/backup.sql:ro");
          expect(create).not.toContain("--security-opt");
        }),
      );
    },
  );

  it.live("fails with LegacyVolumeCreateError before ever creating the container", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "volume") return { exitCode: 1, stderr: "no space left on device\n" };
      return { exitCode: 0, stdout: "should-not-be-created\n" };
    });
    return legacyCreateContainer(mock.spawner, baseSpec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyVolumeCreateError);
        expect(error.message).toBe("failed to create volume: no space left on device");
        expect(mock.spawned.some((args) => args[0] === "create")).toBe(false);
      }),
    );
  });

  it.live("fails with LegacyContainerCreateError on a `docker create` non-zero exit", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 1, stderr: "no such image\n" };
      return { exitCode: 0 };
    });
    const spec: LegacyStartContainerSpec = { ...baseSpec, binds: [] };
    return legacyCreateContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerCreateError);
        expect(error.message).toBe("failed to create docker container: no such image");
        expect(mock.spawned.some((args) => args[0] === "start")).toBe(false);
      }),
    );
  });

  it.live("fails with LegacyContainerStartError, unmodified, on a plain start failure", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 0, stdout: "abc\n" };
      if (args[0] === "start") return { exitCode: 1, stderr: "container is already stopped\n" };
      return { exitCode: 0 };
    });
    const spec: LegacyStartContainerSpec = { ...baseSpec, binds: [] };
    return legacyCreateContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerStartError);
        expect(error.message).toBe(
          'failed to start docker container "supabase_db_proj": container is already stopped',
        );
      }),
    );
  });

  it.live(
    "appends a port-conflict suggestion, naming the container's first network alias, on a port-already-allocated failure",
    () => {
      const mock = mockSpawner((args) => {
        if (args[0] === "create") return { exitCode: 0, stdout: "abc\n" };
        if (args[0] === "start") {
          return {
            exitCode: 1,
            stderr:
              "Error response from daemon: driver failed programming external connectivity on endpoint supabase_db_proj: Bind for 0.0.0.0:5432 failed: port is already allocated\n",
          };
        }
        return { exitCode: 0 };
      });
      const spec: LegacyStartContainerSpec = { ...baseSpec, binds: [] };
      return legacyCreateContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyContainerStartError);
          expect(error.message).toContain('failed to start docker container "supabase_db_proj"');
          expect(error.message).toContain("0.0.0.0:5432");
          expect(error.message).toContain("db port in supabase/config.toml");
        }),
      );
    },
  );
});

describe("legacyCreateContainer secretFiles", () => {
  it.live("starts when the container CLI cannot see the caller's temporary filesystem", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 0, stdout: "container-id-snap\n" };
      if (args[0] === "cp" && args[1] !== "-") {
        return {
          exitCode: 1,
          stderr: `lstat ${args[1] ?? "/tmp/supabase-start-secret-missing"}: no such file or directory\n`,
        };
      }
      return { exitCode: 0 };
    });

    const spec: LegacyStartContainerSpec = {
      ...baseSpec,
      binds: [],
      secretFiles: [
        { containerPath: "/etc/kong/kong.yml", content: "super-secret-content" },
        { containerPath: "/home/kong/localhost.key", content: "tls-private-key" },
        { containerPath: "/home/kong/localhost.crt", content: "" },
      ],
    };

    return Effect.gen(function* () {
      const containerId = yield* legacyCreateContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      });

      expect(containerId).toBe("container-id-snap");
      // `docker cp` runs strictly between `docker create` and `docker start` — the
      // container must already exist for it to have a target, and must not be running
      // yet so its entrypoint never races the copy.
      expect(mock.spawned.map((args) => args[0])).toEqual(["create", "cp", "start"]);

      const cp = mock.spawnedOptions.find((entry) => entry.args[0] === "cp");
      expect(cp?.args).toEqual(["cp", "-", "container-id-snap:/"]);
      const spawnedArgv = mock.spawned.flat();
      expect(spawnedArgv.some((arg) => arg.includes("super-secret-content"))).toBe(false);
      expect(spawnedArgv.some((arg) => arg.includes("tls-private-key"))).toBe(false);
      expect(spawnedArgv.some((arg) => arg.includes("supabase-start-secret"))).toBe(false);

      const stdin = cp?.stdin;
      expect(Stream.isStream(stdin)).toBe(true);
      if (!Stream.isStream(stdin)) return yield* Effect.die("docker cp stdin was not a stream");

      const chunks = yield* Stream.runCollect(stdin);
      expect(chunks).toHaveLength(1);
      const archiveBytes = chunks[0];
      expect(archiveBytes).toBeInstanceOf(Uint8Array);
      if (!(archiveBytes instanceof Uint8Array)) {
        return yield* Effect.die("docker cp stdin did not contain archive bytes");
      }

      const files = yield* Effect.promise(() => new Bun.Archive(archiveBytes).files());
      expect([...files.keys()]).toEqual([
        "etc/kong/kong.yml",
        "home/kong/localhost.key",
        "home/kong/localhost.crt",
      ]);

      const kongConfig = files.get("etc/kong/kong.yml");
      const tlsKey = files.get("home/kong/localhost.key");
      const tlsCert = files.get("home/kong/localhost.crt");
      expect(kongConfig).toBeDefined();
      expect(tlsKey).toBeDefined();
      expect(tlsCert).toBeDefined();
      if (kongConfig === undefined || tlsKey === undefined || tlsCert === undefined) {
        return yield* Effect.die("docker cp archive did not contain the requested files");
      }
      expect(yield* Effect.promise(() => kongConfig.text())).toBe("super-secret-content");
      expect(yield* Effect.promise(() => tlsKey.text())).toBe("tls-private-key");
      expect(yield* Effect.promise(() => tlsCert.text())).toBe("");

      expect(tarRegularFileModes(archiveBytes)).toEqual([0o644, 0o644, 0o644]);
    });
  });

  it.live("fails when docker cp rejects the archive and never invokes docker start", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 0, stdout: "container-id-def\n" };
      if (args[0] === "cp") {
        return { exitCode: 1, stderr: "Error: No such container: container-id-def\n" };
      }
      return { exitCode: 0 };
    });

    const spec: LegacyStartContainerSpec = {
      ...baseSpec,
      binds: [],
      secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
    };

    return legacyCreateContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerCreateError);
        expect(error.message).toBe(
          "failed to create docker container: failed to copy secret file into container: exit 1: Error: No such container: container-id-def",
        );
        expect(mock.spawned.map((args) => args[0])).toEqual(["create", "cp"]);
        expect(mock.spawned[1]).toEqual(["cp", "-", "container-id-def:/"]);
        expect(mock.spawned.some((args) => args[0] === "start")).toBe(false);
      }),
    );
  });

  it.live("propagates docker start failure after copying the secret archive", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 0, stdout: "container-id-start-fail\n" };
      if (args[0] === "start") {
        return { exitCode: 1, stderr: "container is already stopped\n" };
      }
      return { exitCode: 0 };
    });

    const spec: LegacyStartContainerSpec = {
      ...baseSpec,
      binds: [],
      secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
    };

    return legacyCreateContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerStartError);
        expect(error.message).toBe(
          'failed to start docker container "supabase_db_proj": container is already stopped',
        );
        expect(mock.spawned.map((args) => args[0])).toEqual(["create", "cp", "start"]);
        expect(mock.spawned[1]).toEqual(["cp", "-", "container-id-start-fail:/"]);
      }),
    );
  });

  it.live("never invokes docker cp or docker start when docker create fails", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 1, stderr: "no such image\n" };
      return { exitCode: 0 };
    });

    const spec: LegacyStartContainerSpec = {
      ...baseSpec,
      binds: [],
      secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
    };

    return legacyCreateContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerCreateError);
        expect(mock.spawned.some((args) => args[0] === "cp")).toBe(false);
        expect(mock.spawned.some((args) => args[0] === "start")).toBe(false);
      }),
    );
  });
});

describe("legacyEnsureNetwork", () => {
  it.live("creates the network with labels when it does not exist yet", () => {
    const mock = mockSpawner((args) =>
      args[1] === "inspect"
        ? { exitCode: 1, stderr: "Error: No such network: supabase_network_proj\n" }
        : { exitCode: 0 },
    );
    return legacyEnsureNetwork(mock.spawner, "supabase_network_proj", {
      "com.supabase.cli.project": "proj",
      "com.docker.compose.project": "proj",
    }).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          ["network", "inspect", "supabase_network_proj"],
          [
            "network",
            "create",
            "--label",
            "com.supabase.cli.project=proj",
            "--label",
            "com.docker.compose.project=proj",
            "supabase_network_proj",
          ],
        ]);
      }),
    );
  });

  it.live("never spawns a create for an already-existing network", () => {
    const mock = mockSpawner((args) =>
      args[1] === "inspect"
        ? { exitCode: 0 }
        : { exitCode: 1, stderr: "error during connect: write: broken pipe\n" },
    );
    return legacyEnsureNetwork(mock.spawner, "supabase_network_proj", {
      "com.supabase.cli.project": "proj",
    }).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([["network", "inspect", "supabase_network_proj"]]);
      }),
    );
  });

  it.live("treats an already-exists failure as success", () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr:
        "Error response from daemon: network with name supabase_network_proj already exists\n",
    }));
    return legacyEnsureNetwork(mock.spawner, "supabase_network_proj", {}).pipe(
      Effect.map(() => {
        // Just needs to not fail — no return value to assert on.
      }),
    );
  });

  it.live("fails with LegacyNetworkCreateError on any other failure", () => {
    const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
    return legacyEnsureNetwork(mock.spawner, "supabase_network_proj", {}).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyNetworkCreateError);
        expect(error.message).toBe("failed to create docker network: permission denied");
      }),
    );
  });

  it.live.each(["default", "bridge", "host", "none"])(
    "skips docker network create for the built-in %s network",
    (networkId) => {
      const mock = mockSpawner(() => ({
        exitCode: 1,
        stderr: "operation is not permitted on predefined host network",
      }));
      return legacyEnsureNetwork(mock.spawner, networkId, {}).pipe(
        Effect.map(() => {
          expect(mock.spawned).toEqual([]);
        }),
      );
    },
  );

  it.live("skips docker network create for a container: network mode", () => {
    // Go's `container.NetworkMode.IsUserDefined()`
    // (`docker/api/types/container/hostconfig_unix.go:23-25`) explicitly
    // excludes `IsContainer()` — `--network-id container:redis` attaches to
    // another container's network stack, not a name `docker network create`
    // could ever act on (review round on CLI-1963's `functions download`
    // port, which surfaced the same gap in the shared
    // `isUserDefinedDockerNetwork` predicate this helper reuses).
    const mock = mockSpawner(() => ({ exitCode: 1, stderr: "some failure" }));
    return legacyEnsureNetwork(mock.spawner, "container:redis", {}).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([]);
      }),
    );
  });
});

describe("legacyEnsureVolume", () => {
  it.live("creates the named volume with labels", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyEnsureVolume(mock.spawner, "supabase_db_proj", {
      "com.supabase.cli.project": "proj",
    }).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          ["volume", "create", "--label", "com.supabase.cli.project=proj", "supabase_db_proj"],
        ]);
      }),
    );
  });

  it.live("treats podman's already-exists rejection as success", () => {
    const mock = mockSpawner(() => ({
      exitCode: 125,
      stderr: "Error: volume with name supabase_db_proj already exists: volume already exists\n",
    }));
    return legacyEnsureVolume(mock.spawner, "supabase_db_proj", {}).pipe(
      Effect.map(() => {
        // Just needs to not fail — no return value to assert on.
      }),
    );
  });

  it.live("treats an already-exists rejection without the trailing sentinel as success", () => {
    const mock = mockSpawner(() => ({
      exitCode: 125,
      stderr: "volume with name supabase_db_proj already exists\n",
    }));
    return legacyEnsureVolume(mock.spawner, "supabase_db_proj", {}).pipe(
      Effect.map(() => {
        // Just needs to not fail — no return value to assert on.
      }),
    );
  });

  it.live("fails with LegacyVolumeCreateError on any other failure", () => {
    const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
    return legacyEnsureVolume(mock.spawner, "supabase_db_proj", {}).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyVolumeCreateError);
        expect(error.message).toBe("failed to create volume: permission denied");
      }),
    );
  });

  it.live("still fails when the volume exists under a different specification", () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr:
        "a volume named supabase_db_proj already exists but was not created for the current specification\n",
    }));
    return legacyEnsureVolume(mock.spawner, "supabase_db_proj", {}).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyVolumeCreateError);
        expect(error.message).toBe(
          "failed to create volume: a volume named supabase_db_proj already exists but was not created for the current specification",
        );
      }),
    );
  });
});

describe("legacyVolumeExists", () => {
  it.live("resolves true when `docker volume inspect` exits 0", () => {
    const mock = mockSpawner(() => ({ exitCode: 0, stdout: "[]\n" }));
    return legacyVolumeExists(mock.spawner, "supabase_db_proj").pipe(
      Effect.map((exists) => {
        expect(exists).toBe(true);
        expect(mock.spawned).toEqual([["volume", "inspect", "supabase_db_proj"]]);
      }),
    );
  });

  it.live('resolves false on a "no such volume" non-zero exit', () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr: "Error: No such volume: supabase_db_proj\n",
    }));
    return legacyVolumeExists(mock.spawner, "supabase_db_proj").pipe(
      Effect.map((exists) => {
        expect(exists).toBe(false);
      }),
    );
  });

  it.live(
    "resolves true (protected, not fresh) on an ambiguous inspect failure, matching Go's IsNotFound gate",
    () => {
      const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
      return legacyVolumeExists(mock.spawner, "supabase_db_proj").pipe(
        Effect.map((exists) => {
          expect(exists).toBe(true);
        }),
      );
    },
  );

  it.live("fails with LegacyVolumeInspectError when no runtime can be spawned", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn ENOENT",
        }),
      ),
    );
    return legacyVolumeExists(spawner, "supabase_db_proj").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyVolumeInspectError);
      }),
    );
  });
});

describe("legacyRemoveContainer", () => {
  it.live("spawns `docker container rm -f <id>` and succeeds on exit 0", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyRemoveContainer(mock.spawner, "supabase_db_proj").pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([["container", "rm", "-f", "supabase_db_proj"]]);
      }),
    );
  });

  it.live(
    'fails with LegacyContainerRemoveError on ANY non-zero exit — not tolerant of "not found"',
    () => {
      const mock = mockSpawner(() => ({
        exitCode: 1,
        stderr: "Error: No such container: supabase_db_proj\n",
      }));
      return legacyRemoveContainer(mock.spawner, "supabase_db_proj").pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyContainerRemoveError);
          expect(error.message).toContain("failed to remove container");
          expect(error.message).toContain("No such container");
        }),
      );
    },
  );

  it.live("fails with LegacyContainerRemoveError when no runtime can be spawned", () => {
    const spawner = ChildProcessSpawner.make(() =>
      Effect.fail(
        PlatformError.systemError({
          _tag: "NotFound",
          module: "ChildProcess",
          method: "spawn",
          description: "spawn ENOENT",
        }),
      ),
    );
    return legacyRemoveContainer(spawner, "supabase_db_proj").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyContainerRemoveError);
      }),
    );
  });
});

describe("legacyRemoveVolume", () => {
  it.live("spawns `docker volume rm -f <name>` and succeeds on exit 0", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyRemoveVolume(mock.spawner, "supabase_db_proj").pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([["volume", "rm", "-f", "supabase_db_proj"]]);
      }),
    );
  });

  it.live("fails with LegacyVolumeRemoveError on a genuine non-zero exit", () => {
    const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
    return legacyRemoveVolume(mock.spawner, "supabase_db_proj").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyVolumeRemoveError);
        expect(error.message).toContain("failed to remove volume");
      }),
    );
  });
});

describe("legacyCreateContainer with an empty containerName (the shadow database)", () => {
  it.live(
    "omits --name from the create argv and still delivers secretFiles via `docker cp` against the container's own id, exactly like a named container",
    () => {
      let cpArgs: ReadonlyArray<string> | undefined;
      const mock = mockSpawner((args) => {
        if (args[0] === "create") {
          expect(args).not.toContain("--name");
          return { exitCode: 0, stdout: "shadow-container-id\n" };
        }
        if (args[0] === "cp") {
          cpArgs = args;
        }
        return { exitCode: 0 };
      });

      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        containerName: "",
        binds: [],
        networkAliases: undefined,
        autoRemove: true,
        secretFiles: [
          { containerPath: "/etc/postgresql-custom/pgsodium_root.key", content: "root-key" },
        ],
      };

      return legacyCreateContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map((containerId) => {
          expect(containerId).toBe("shadow-container-id");
          // `docker cp` addresses the container by the id `docker create` returned, never by
          // name — the unnamed shadow container is delivered its secret the same way a named
          // one is.
          expect(cpArgs).toEqual(["cp", "-", "shadow-container-id:/"]);
        }),
      );
    },
  );
});
