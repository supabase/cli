import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { afterEach, beforeEach } from "vitest";

import {
  LegacyStartContainerCreateError,
  LegacyStartContainerStartError,
  LegacyStartNetworkCreateError,
  LegacyStartVolumeCreateError,
  LegacyStartVolumeInspectError,
  legacyEnsureStartNetwork,
  legacyEnsureStartVolume,
  legacyStartContainer,
  legacyStartVolumeExists,
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

describe("legacyStartContainer", () => {
  it.live(
    "merges project + compose labels, provisions named volumes, then creates and starts",
    () => {
      const mock = alwaysSucceed();
      return legacyStartContainer(mock.spawner, baseSpec, {
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
      return legacyStartContainer(mock.spawner, baseSpec, {
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
      return legacyStartContainer(mock.spawner, spec, {
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
      return legacyStartContainer(mock.spawner, spec, {
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
      return legacyStartContainer(mock.spawner, baseSpec, {
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

  it.live("fails with LegacyStartVolumeCreateError before ever creating the container", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "volume") return { exitCode: 1, stderr: "no space left on device\n" };
      return { exitCode: 0, stdout: "should-not-be-created\n" };
    });
    return legacyStartContainer(mock.spawner, baseSpec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartVolumeCreateError);
        expect(error.message).toBe("failed to create volume: no space left on device");
        expect(mock.spawned.some((args) => args[0] === "create")).toBe(false);
      }),
    );
  });

  it.live("fails with LegacyStartContainerCreateError on a `docker create` non-zero exit", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 1, stderr: "no such image\n" };
      return { exitCode: 0 };
    });
    const spec: LegacyStartContainerSpec = { ...baseSpec, binds: [] };
    return legacyStartContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartContainerCreateError);
        expect(error.message).toBe("failed to create docker container: no such image");
        expect(mock.spawned.some((args) => args[0] === "start")).toBe(false);
      }),
    );
  });

  it.live("fails with LegacyStartContainerStartError, unmodified, on a plain start failure", () => {
    const mock = mockSpawner((args) => {
      if (args[0] === "create") return { exitCode: 0, stdout: "abc\n" };
      if (args[0] === "start") return { exitCode: 1, stderr: "container is already stopped\n" };
      return { exitCode: 0 };
    });
    const spec: LegacyStartContainerSpec = { ...baseSpec, binds: [] };
    return legacyStartContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartContainerStartError);
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
      return legacyStartContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyStartContainerStartError);
          expect(error.message).toContain('failed to start docker container "supabase_db_proj"');
          expect(error.message).toContain("0.0.0.0:5432");
          expect(error.message).toContain("db port in supabase/config.toml");
        }),
      );
    },
  );
});

describe("legacyStartContainer secretFiles", () => {
  it.live(
    "stages a secretFile as a mode-0644 HOST file (readable by non-root container users) under a mode-0700 deterministic, per-container directory, bind-mounts it read-only at the exact containerPath, keeps the raw content out of argv, and PERSISTS the file after a successful start so a `restartPolicy: unless-stopped` container can survive a host/daemon restart (CWE-214/522)",
    () => {
      let hostPath: string | undefined;
      let modeAtCreateTime: number | undefined;
      let dirModeAtCreateTime: number | undefined;
      const mock = mockSpawner((args) => {
        if (args[0] === "create") {
          const bind = args.find((a) => a.endsWith(":/etc/kong/kong.yml:ro"));
          if (bind !== undefined) {
            hostPath = bind.slice(0, bind.length - ":/etc/kong/kong.yml:ro".length);
            modeAtCreateTime = statSync(hostPath).mode & 0o777;
            dirModeAtCreateTime = statSync(dirname(hostPath)).mode & 0o777;
          }
          return { exitCode: 0, stdout: "container-id-789\n" };
        }
        return { exitCode: 0 };
      });

      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
      };

      return legacyStartContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map((containerId) => {
          expect(containerId).toBe("container-id-789");

          const create = mock.spawned.find((a) => a[0] === "create");
          expect(create?.some((a) => a.includes("super-secret-content"))).toBe(false);

          expect(hostPath).toBeDefined();
          expect(modeAtCreateTime).toBe(0o644);
          expect(dirModeAtCreateTime).toBe(0o700);
          expect(create).toContain(`${hostPath}:/etc/kong/kong.yml:ro`);

          // Deterministic — rooted in the project's own workdir, not an OS temp dir, and
          // scoped by container name so sibling services never collide.
          expect(hostPath).toBe(
            join(workdir, "supabase", ".temp", "start-secrets", spec.containerName, "secret-0"),
          );

          // The staged file is left in place after a successful start: it must survive for
          // the container's whole lifetime so a `restartPolicy: unless-stopped` restart (e.g.
          // dockerd re-attaching this bind mount after a host reboot, long after this process
          // has exited) can still read it.
          expect(existsSync(hostPath ?? "")).toBe(true);
        }),
      );
    },
  );

  it.live(
    "removes any pre-existing directory at the deterministic path before writing fresh files (self-healing across config changes)",
    () => {
      const dir = join(workdir, "supabase", ".temp", "start-secrets", baseSpec.containerName);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "stale-leftover-from-a-previous-config"), "old-content");

      const mock = alwaysSucceed("container-id-stale\n");
      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "fresh-content" }],
      };

      return legacyStartContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.map(() => {
          expect(readdirSync(dir)).toEqual(["secret-0"]);
          expect(readFileSync(join(dir, "secret-0"), "utf8")).toBe("fresh-content");
        }),
      );
    },
  );

  it.live("cleans up the staged file even when `docker create` fails", () => {
    let hostPath: string | undefined;
    const mock = mockSpawner((args) => {
      if (args[0] === "create") {
        const bind = args.find((a) => a.endsWith(":/etc/kong/kong.yml:ro"));
        hostPath = bind?.slice(0, bind.length - ":/etc/kong/kong.yml:ro".length);
        return { exitCode: 1, stderr: "no such image\n" };
      }
      return { exitCode: 0 };
    });

    const spec: LegacyStartContainerSpec = {
      ...baseSpec,
      binds: [],
      secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
    };

    return legacyStartContainer(mock.spawner, spec, {
      projectId: "proj",
      isBitbucketPipeline: false,
      workdir,
      extraHosts: [],
    }).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartContainerCreateError);
        expect(hostPath).toBeDefined();
        expect(existsSync(hostPath ?? "")).toBe(false);
      }),
    );
  });

  it.live(
    "cleans up the staged file when `docker create` succeeds but `docker start` fails",
    () => {
      let hostPath: string | undefined;
      const mock = mockSpawner((args) => {
        if (args[0] === "create") {
          const bind = args.find((a) => a.endsWith(":/etc/kong/kong.yml:ro"));
          hostPath = bind?.slice(0, bind.length - ":/etc/kong/kong.yml:ro".length);
          return { exitCode: 0, stdout: "container-id-abc\n" };
        }
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

      return legacyStartContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyStartContainerStartError);
          expect(hostPath).toBeDefined();
          // The container never successfully started, so nothing depends on the file surviving.
          expect(existsSync(hostPath ?? "")).toBe(false);
        }),
      );
    },
  );

  it.live(
    "maps a staging write failure to LegacyStartContainerCreateError, without ever invoking `docker create`",
    () => {
      const dir = join(workdir, "supabase", ".temp", "start-secrets", baseSpec.containerName);
      // `dir` itself doesn't exist yet, so the self-healing `rm(dir, ...)` up front is a no-op —
      // but its PARENT ("start-secrets") is a plain file instead of a directory, which forces
      // `mkdir(dir, { recursive: true })` to fail with ENOTDIR. This exercises the staging
      // try/catch's failure branch, which has no other way to fail deterministically from a
      // unit test.
      mkdirSync(dirname(dirname(dir)), { recursive: true });
      writeFileSync(dirname(dir), "not a directory");

      const mock = mockSpawner(() => ({ exitCode: 0, stdout: "should-not-be-created\n" }));
      const spec: LegacyStartContainerSpec = {
        ...baseSpec,
        binds: [],
        secretFiles: [{ containerPath: "/etc/kong/kong.yml", content: "super-secret-content" }],
      };

      return legacyStartContainer(mock.spawner, spec, {
        projectId: "proj",
        isBitbucketPipeline: false,
        workdir,
        extraHosts: [],
      }).pipe(
        Effect.flip,
        Effect.map((error) => {
          expect(error).toBeInstanceOf(LegacyStartContainerCreateError);
          expect(error.message).toMatch(
            /^failed to create docker container: failed to stage container secret files: /,
          );
          expect(mock.spawned.some((args) => args[0] === "create")).toBe(false);
          // `mkdir` never got far enough to create anything at the per-container path — the
          // inner catch's own `rm(dir, ...)` cleanup call is a no-op here, but still runs.
          expect(existsSync(dir)).toBe(false);
        }),
      );
    },
  );
});

describe("legacyEnsureStartNetwork", () => {
  it.live("creates the network with labels", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyEnsureStartNetwork(mock.spawner, "supabase_network_proj", {
      "com.supabase.cli.project": "proj",
      "com.docker.compose.project": "proj",
    }).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([
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

  it.live("treats an already-exists failure as success", () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr:
        "Error response from daemon: network with name supabase_network_proj already exists\n",
    }));
    return legacyEnsureStartNetwork(mock.spawner, "supabase_network_proj", {}).pipe(
      Effect.map(() => {
        // Just needs to not fail — no return value to assert on.
      }),
    );
  });

  it.live("fails with LegacyStartNetworkCreateError on any other failure", () => {
    const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
    return legacyEnsureStartNetwork(mock.spawner, "supabase_network_proj", {}).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartNetworkCreateError);
        expect(error.message).toBe("failed to create docker network: permission denied");
      }),
    );
  });
});

describe("legacyEnsureStartVolume", () => {
  it.live("creates the named volume with labels", () => {
    const mock = mockSpawner(() => ({ exitCode: 0 }));
    return legacyEnsureStartVolume(mock.spawner, "supabase_db_proj", {
      "com.supabase.cli.project": "proj",
    }).pipe(
      Effect.map(() => {
        expect(mock.spawned).toEqual([
          ["volume", "create", "--label", "com.supabase.cli.project=proj", "supabase_db_proj"],
        ]);
      }),
    );
  });

  it.live("fails on any non-zero exit, with no already-exists tolerance", () => {
    const mock = mockSpawner(() => ({
      exitCode: 1,
      stderr:
        "a volume named supabase_db_proj already exists but was not created for the current specification\n",
    }));
    return legacyEnsureStartVolume(mock.spawner, "supabase_db_proj", {}).pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartVolumeCreateError);
        expect(error.message).toBe(
          "failed to create volume: a volume named supabase_db_proj already exists but was not created for the current specification",
        );
      }),
    );
  });
});

describe("legacyStartVolumeExists", () => {
  it.live("resolves true when `docker volume inspect` exits 0", () => {
    const mock = mockSpawner(() => ({ exitCode: 0, stdout: "[]\n" }));
    return legacyStartVolumeExists(mock.spawner, "supabase_db_proj").pipe(
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
    return legacyStartVolumeExists(mock.spawner, "supabase_db_proj").pipe(
      Effect.map((exists) => {
        expect(exists).toBe(false);
      }),
    );
  });

  it.live(
    "resolves true (protected, not fresh) on an ambiguous inspect failure, matching Go's IsNotFound gate",
    () => {
      const mock = mockSpawner(() => ({ exitCode: 1, stderr: "permission denied\n" }));
      return legacyStartVolumeExists(mock.spawner, "supabase_db_proj").pipe(
        Effect.map((exists) => {
          expect(exists).toBe(true);
        }),
      );
    },
  );

  it.live("fails with LegacyStartVolumeInspectError when no runtime can be spawned", () => {
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
    return legacyStartVolumeExists(spawner, "supabase_db_proj").pipe(
      Effect.flip,
      Effect.map((error) => {
        expect(error).toBeInstanceOf(LegacyStartVolumeInspectError);
      }),
    );
  });
});
