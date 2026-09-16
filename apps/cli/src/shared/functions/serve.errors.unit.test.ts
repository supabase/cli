import { describe, expect, it } from "vitest";
import {
  SUGGEST_CONTAINER_MEMORY_LIMIT,
  SUGGEST_DOCKER_INSTALL,
  SUGGEST_DOCKER_START,
} from "../../command-internal/docker-suggest.ts";
import { actionability, classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import {
  DockerLogsStreamError,
  EdgeRuntimeContainerCrashedError,
  EdgeRuntimeLogStreamLostError,
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
    });
    expect(error.suggestion).toBeUndefined();

    const result = classifyCliErrorActionability(error);
    expect(result.error_category).toBe("unknown");
  });
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
