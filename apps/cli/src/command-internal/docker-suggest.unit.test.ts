import { describe, expect, it } from "vitest";

import { containerRuntimeNotFoundMessage } from "./container-cli.ts";
import { SUGGEST_DOCKER_INSTALL, isDockerDaemonUnreachable } from "./docker-suggest.ts";

describe("isDockerDaemonUnreachable", () => {
  it("detects the docker/podman daemon-down CLI messages (Go's IsErrConnectionFailed)", () => {
    expect(
      isDockerDaemonUnreachable(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe(true);
    expect(isDockerDaemonUnreachable("cannot connect to podman")).toBe(true);
    expect(isDockerDaemonUnreachable("Is the docker daemon running?")).toBe(true);
    expect(
      isDockerDaemonUnreachable(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      ),
    ).toBe(true);
    expect(isDockerDaemonUnreachable(containerRuntimeNotFoundMessage)).toBe(true);
    expect(
      isDockerDaemonUnreachable(
        'error during connect: this error may indicate that the docker daemon is not running: Get "http://%2F%2F.%2Fpipe%2Fdocker_engine/v1.51/containers/supabase_db_test/json": open //./pipe/docker_engine: The system cannot find the file specified.',
      ),
    ).toBe(true);
    expect(
      isDockerDaemonUnreachable(
        "error during connect: in the default daemon configuration on Windows, the docker client must be run with elevated privileges to connect: open //./pipe/docker_engine: Access is denied.",
      ),
    ).toBe(true);
  });

  it("does not flag an unrelated inspect failure", () => {
    expect(isDockerDaemonUnreachable("Error: No such container: supabase_db_x")).toBe(false);
    expect(isDockerDaemonUnreachable("")).toBe(false);
  });

  it("exposes Go's install hint verbatim", () => {
    expect(SUGGEST_DOCKER_INSTALL).toContain("https://docs.docker.com/desktop");
  });
});
