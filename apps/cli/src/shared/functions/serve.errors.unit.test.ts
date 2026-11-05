import { PlatformError } from "effect";
import { describe, expect, it } from "vitest";
import {
  SUGGEST_CONTAINER_MEMORY_LIMIT,
  SUGGEST_DOCKER_INSTALL,
  SUGGEST_DOCKER_START,
  SUGGEST_DOCKER_START_RERUN,
} from "../../command-internal/docker-suggest.ts";
import { actionability, classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import {
  classifyDockerResourceCreateStderr,
  classifyEdgeRuntimeDockerStepStderr,
  DockerLogsStreamError,
  DockerResourceCreateError,
  EdgeRuntimeContainerCrashedError,
  EdgeRuntimeDockerStepError,
  EdgeRuntimeLogStreamLostError,
  ServeConfigError,
  ServeEnvFileError,
  ServeFilesystemError,
  ServeLocalDbInspectError,
  ServeLocalDbNotRunningError,
} from "./serve.errors.ts";

describe("EdgeRuntimeContainerCrashedError actionability", () => {
  it("classifies an ordinary crash exit as an internal runtime crash", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 1",
      containerId: "abc123",
      exitCode: 1,
      oomKilled: false,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
  });

  it("classifies exit 143 as an internal runtime crash: streamContainerLogs ends the session before this error is ever raised for supervisor-teardown codes", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container abc123: exit 143",
      containerId: "abc123",
      exitCode: 143,
      oomKilled: false,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
    expect(result.error_fingerprint).toBe("tag:EdgeRuntimeContainerCrashedError");
  });

  it("classifies exit 130 as an internal runtime crash for the same reason", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container abc123: exit 130",
      containerId: "abc123",
      exitCode: 130,
      oomKilled: false,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
  });

  it("still classifies a crash signal (SIGSEGV, 139) as an internal runtime crash", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 139",
      containerId: "abc123",
      exitCode: 139,
      oomKilled: false,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
  });

  it("classifies an out-of-memory kill (137, OOMKilled) as user-actionable, with a suggestion", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container abc123: exit 137",
      containerId: "abc123",
      exitCode: 137,
      oomKilled: true,
    });

    expect(error.suggestion).toBe(SUGGEST_CONTAINER_MEMORY_LIMIT);
    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.resourceLimit.error_kind);
    expect(result.error_category).toBe(actionability.resourceLimit.error_category);
    expect(result.error_fingerprint).toBe("tag:EdgeRuntimeContainerCrashedError:out_of_memory");
  });

  it("classifies a non-OOM kill (137, not OOMKilled) as unknown, not our bug", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container abc123: exit 137",
      containerId: "abc123",
      exitCode: 137,
      oomKilled: false,
    });

    expect(error.suggestion).toBeUndefined();
    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.unknown.error_kind);
    expect(result.error_category).toBe(actionability.unknown.error_category);
    expect(result.error_fingerprint).toBe("tag:EdgeRuntimeContainerCrashedError:container_killed");
  });

  it("classifies OOMKilled as out-of-memory even with a non-137 exit code", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container abc123: exit 1",
      containerId: "abc123",
      exitCode: 1,
      oomKilled: true,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.resourceLimit.error_kind);
    expect(result.error_category).toBe(actionability.resourceLimit.error_category);
  });
});

describe("DockerLogsStreamError suggestion", () => {
  it("surfaces the docker start remediation when the daemon is down", () => {
    const error = new DockerLogsStreamError({
      message: "docker logs -f exited",
      containerId: "abc123",
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
      daemonDown: true,
      oomKilled: false,
    });
    expect(error.suggestion).toBe(SUGGEST_DOCKER_START);

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("docker_not_running");
    expect(result.error_fingerprint).toBe("tag:DockerLogsStreamError:docker_not_running");
  });

  it("carries no suggestion for an unrelated stream failure", () => {
    const error = new DockerLogsStreamError({
      message: "docker logs -f exited",
      containerId: "abc123",
      exitCode: 1,
      stderr: "unexpected error",
      daemonDown: false,
      oomKilled: false,
    });
    expect(error.suggestion).toBeUndefined();

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("unknown");
  });

  it("surfaces the memory-limit remediation when the container was killed for exceeding its memory", () => {
    const error = new DockerLogsStreamError({
      message: "docker logs -f exited",
      containerId: "abc123",
      exitCode: 1,
      stderr: "unexpected error",
      daemonDown: false,
      oomKilled: true,
    });
    expect(error.suggestion).toBe(SUGGEST_CONTAINER_MEMORY_LIMIT);

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.resourceLimit.error_kind);
    expect(result.error_category).toBe(actionability.resourceLimit.error_category);
    expect(result.error_fingerprint).toBe("tag:DockerLogsStreamError:out_of_memory");
  });

  it.each([
    { containerExitCode: undefined, category: "unknown", fingerprint: ":engine_command_inspect" },
    { containerExitCode: 137, category: "unknown", fingerprint: ":container_killed" },
    { containerExitCode: 0, category: "unknown", fingerprint: ":runtime_stopped" },
    { containerExitCode: 143, category: "unknown", fingerprint: ":runtime_stopped" },
    { containerExitCode: 1, category: "runtime_crash", fingerprint: "" },
  ])(
    "fingerprints a reachable-daemon stream failure with container exit $containerExitCode",
    ({ containerExitCode, category, fingerprint }) => {
      const error = new DockerLogsStreamError({
        message: "docker logs -f exited",
        containerId: "abc123",
        exitCode: 1,
        stderr: "unexpected error",
        daemonDown: false,
        oomKilled: false,
        containerExitCode,
      });

      const result = classifyCliErrorActionability(error);
      expect(result.error_category).toBe(category);
      expect(result.error_fingerprint).toBe(`tag:DockerLogsStreamError${fingerprint}`);
    },
  );
});

describe("EdgeRuntimeLogStreamLostError actionability", () => {
  it("classifies a repeated re-attach loss as an external-service failure", () => {
    const error = new EdgeRuntimeLogStreamLostError({
      message: "lost the Edge Runtime log stream 5 times; container abc123 is still running",
      containerId: "abc123",
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.externalNetwork.error_kind);
    expect(result.error_category).toBe(actionability.externalNetwork.error_category);
    expect(result.error_fingerprint).toBe("tag:EdgeRuntimeLogStreamLostError");
  });
});

describe("ServeLocalDbNotRunningError actionability", () => {
  it("classifies a missing local DB container as user-actionable with the start-stack remediation", () => {
    const error = new ServeLocalDbNotRunningError({ message: "supabase start is not running." });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.startStack.error_kind);
    expect(result.error_category).toBe(actionability.startStack.error_category);
    expect(result.suggestion_type).toBe(actionability.startStack.suggestion_type);
    expect(result.suggested_command).toBe("supabase start");
    expect(result.error_fingerprint).toBe("tag:ServeLocalDbNotRunningError");
  });
});

describe("ServeLocalDbInspectError actionability", () => {
  it("classifies an unreachable daemon as docker-not-running with the install suggestion", () => {
    const error = new ServeLocalDbInspectError({
      message: "failed to inspect service: Cannot connect to the Docker daemon",
      daemonDown: true,
    });
    expect(error.suggestion).toBe(SUGGEST_DOCKER_INSTALL);

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("docker_not_running");
    expect(result.error_fingerprint).toBe("tag:ServeLocalDbInspectError:docker_not_running");
  });

  it("carries no suggestion and lands in unknown for any other inspect failure, keeping a tagged fingerprint", () => {
    const error = new ServeLocalDbInspectError({
      message: "failed to inspect service: unexpected error",
      daemonDown: false,
    });
    expect(error.suggestion).toBeUndefined();

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("unknown");
    expect(result.error_fingerprint).toBe("tag:ServeLocalDbInspectError");
  });
});

const platformCause = (tag: "NotFound" | "PermissionDenied") =>
  new PlatformError.PlatformError(
    new PlatformError.SystemError({ _tag: tag, module: "FileSystem", method: "readFile" }),
  );

describe("ServeConfigError actionability", () => {
  it.each([
    ["inspect_flags", "user_actionable", "invalid_input", "tag:ServeConfigError:flags"],
    [
      "signing_keys_invalid",
      "user_actionable",
      "invalid_config",
      "tag:ServeConfigError:invalid_content",
    ],
    ["jwt_secret", "user_actionable", "invalid_config", "tag:ServeConfigError:invalid_config"],
    ["deno_version", "user_actionable", "invalid_config", "tag:ServeConfigError:project_config"],
    ["missing_import", "user_actionable", "invalid_input", "tag:ServeConfigError:not_found"],
  ] as const)("classifies %s", (reason, kind, category, fingerprint) => {
    const result = classifyCliErrorActionability(new ServeConfigError({ message: "m", reason }));

    expect(result.error_kind).toBe(kind);
    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(fingerprint);
  });
});

describe("ServeEnvFileError actionability", () => {
  it.each([
    ["syntax", undefined, "invalid_input", "tag:ServeEnvFileError:invalid_content"],
    ["env_name", undefined, "invalid_input", "tag:ServeEnvFileError:functions_env"],
    ["not_found", undefined, "invalid_input", "tag:ServeEnvFileError:not_found"],
    [
      "read",
      Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }),
      "unknown",
      "tag:ServeEnvFileError:filesystem_io",
    ],
    ["read", undefined, "unknown", "tag:ServeEnvFileError:filesystem_io"],
  ] as const)("classifies a %s failure with cause %#", (reason, cause, category, fingerprint) => {
    const result = classifyCliErrorActionability(
      new ServeEnvFileError({ message: "m", reason, cause }),
    );

    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(fingerprint);
  });
});

describe("ServeFilesystemError actionability", () => {
  it.each([
    [platformCause("NotFound"), "invalid_input", "tag:ServeFilesystemError:not_found"],
    [platformCause("PermissionDenied"), "permission", "tag:ServeFilesystemError:filesystem"],
    [undefined, "unknown", "tag:ServeFilesystemError:filesystem_io"],
  ] as const)("classifies cause %#", (cause, category, fingerprint) => {
    const result = classifyCliErrorActionability(
      new ServeFilesystemError({ message: "m", step: "env_staging", cause }),
    );

    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(fingerprint);
  });
});

describe("EdgeRuntimeDockerStepError actionability", () => {
  it.each([
    [
      "create",
      "daemon_down",
      "docker_not_running",
      "tag:EdgeRuntimeDockerStepError:docker_not_running",
    ],
    ["create", "port_in_use", "invalid_config", "tag:EdgeRuntimeDockerStepError:port_conflict"],
    ["start", "name_conflict", "invalid_input", "tag:EdgeRuntimeDockerStepError:conflict"],
    [
      "cp",
      "mount_denied",
      "invalid_config",
      "tag:EdgeRuntimeDockerStepError:container_configuration",
    ],
    ["cp", "disk_full", "resource_limit", "tag:EdgeRuntimeDockerStepError:disk_full"],
    ["create", "other", "runtime_crash", "tag:EdgeRuntimeDockerStepError:engine_command_create"],
    ["cp", "other", "runtime_crash", "tag:EdgeRuntimeDockerStepError:engine_command_copy"],
    ["start", "other", "runtime_crash", "tag:EdgeRuntimeDockerStepError:engine_command_start"],
  ] as const)("classifies %s step failing with %s", (step, reason, category, fingerprint) => {
    const error = new EdgeRuntimeDockerStepError({ message: "m", step, reason });

    const result = classifyCliErrorActionability(error);

    expect(result.error_category).toBe(category);
    expect(result.error_fingerprint).toBe(fingerprint);
    expect(error.suggestion).toBe(
      reason === "daemon_down" ? SUGGEST_DOCKER_START_RERUN : undefined,
    );
  });
});

describe("DockerResourceCreateError actionability", () => {
  it.each([
    [
      "network",
      "daemon_down",
      "docker_not_running",
      "tag:DockerResourceCreateError:docker_not_running",
    ],
    [
      "network",
      "address_pool",
      "invalid_config",
      "tag:DockerResourceCreateError:container_configuration",
    ],
    ["volume", "other", "runtime_crash", "tag:DockerResourceCreateError:engine_command_create"],
  ] as const)(
    "classifies a %s create failing with %s",
    (resource, reason, category, fingerprint) => {
      const error = new DockerResourceCreateError({ message: "m", resource, reason });

      const result = classifyCliErrorActionability(error);

      expect(result.error_category).toBe(category);
      expect(result.error_fingerprint).toBe(fingerprint);
      expect(error.suggestion).toBe(
        reason === "daemon_down" ? SUGGEST_DOCKER_START_RERUN : undefined,
      );
    },
  );
});

describe("new serve errors built without fields", () => {
  it.each([
    ServeConfigError,
    ServeEnvFileError,
    ServeFilesystemError,
    EdgeRuntimeDockerStepError,
    DockerResourceCreateError,
  ])("keeps a tagged fingerprint for $name", (ErrorClass) => {
    const error: unknown = Reflect.construct(ErrorClass, [{}]);

    const result = classifyCliErrorActionability(error);

    expect(result.error_fingerprint).toMatch(new RegExp(`^tag:${ErrorClass.name}`));
  });
});

describe("classifyEdgeRuntimeDockerStepStderr", () => {
  it.each([
    [
      "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      "daemon_down",
    ],
    ["Bind for 0.0.0.0:54321 failed: port is already allocated", "port_in_use"],
    [
      'Conflict. The container name "/supabase_edge_runtime_x" is already in use by container "abc"',
      "name_conflict",
    ],
    ["Mounts denied: The path /Users/x is not shared from the host", "mount_denied"],
    ["write /var/lib/docker/tmp: no space left on device", "disk_full"],
    ["something unexpected", "other"],
    ["", "other"],
    ["permission denied while trying to connect to the Docker daemon socket", "daemon_down"],
  ] as const)("reads %j as %s", (stderr, reason) => {
    expect(classifyEdgeRuntimeDockerStepStderr(stderr)).toBe(reason);
  });
});

describe("classifyDockerResourceCreateStderr", () => {
  it.each([
    ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock", "daemon_down"],
    ["all predefined address pools have been fully subnetted", "address_pool"],
    ["Pool overlaps with other one on this address space", "address_pool"],
    [
      "could not find an available, non-overlapping IPv4 address pool among the defaults to assign to the network",
      "address_pool",
    ],
    ["something unexpected", "other"],
  ] as const)("reads %j as %s", (stderr, reason) => {
    expect(classifyDockerResourceCreateStderr(stderr)).toBe(reason);
  });
});
