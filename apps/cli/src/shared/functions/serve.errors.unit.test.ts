import { describe, expect, it } from "vitest";
import { SUGGEST_DOCKER_INSTALL } from "../../command-internal/docker-suggest.ts";
import { actionability, classifyCliErrorActionability } from "../telemetry/error-actionability.ts";
import { DockerLogsStreamError, EdgeRuntimeContainerCrashedError } from "./serve.errors.ts";

describe("EdgeRuntimeContainerCrashedError actionability", () => {
  it("classifies an ordinary crash exit as an internal runtime crash", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 1",
      containerId: "abc123",
      exitCode: 1,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
  });

  it("classifies a SIGTERM exit (143) as user-cancelled, not an internal bug", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 143",
      containerId: "abc123",
      exitCode: 143,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.cancelled.error_kind);
    expect(result.error_category).toBe(actionability.cancelled.error_category);
    expect(result.error_fingerprint).toBe("tag:EdgeRuntimeContainerCrashedError:cancelled");
  });

  it("classifies a SIGINT exit (130) as user-cancelled, not an internal bug", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 130",
      containerId: "abc123",
      exitCode: 130,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.cancelled.error_kind);
    expect(result.error_category).toBe(actionability.cancelled.error_category);
  });

  it("still classifies a crash signal (SIGSEGV, 139) as an internal runtime crash", () => {
    const error = new EdgeRuntimeContainerCrashedError({
      message: "error running container: exit 139",
      containerId: "abc123",
      exitCode: 139,
    });

    const result = classifyCliErrorActionability(error);
    expect(result.error_kind).toBe(actionability.runtimeCrash.error_kind);
    expect(result.error_category).toBe(actionability.runtimeCrash.error_category);
  });
});

describe("DockerLogsStreamError suggestion", () => {
  it("surfaces the docker install remediation when the daemon is down", () => {
    const error = new DockerLogsStreamError({
      message: "docker logs -f exited",
      containerId: "abc123",
      exitCode: 1,
      stderr: "Cannot connect to the Docker daemon",
      daemonDown: true,
    });
    expect(error.suggestion).toBe(SUGGEST_DOCKER_INSTALL);

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
