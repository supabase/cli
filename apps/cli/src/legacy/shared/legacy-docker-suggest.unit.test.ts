import { describe, expect, it } from "vitest";

import {
  LEGACY_SUGGEST_DOCKER_INSTALL,
  legacyIsDockerDaemonUnreachable,
} from "./legacy-docker-suggest.ts";

describe("legacyIsDockerDaemonUnreachable", () => {
  it("detects the docker/podman daemon-down CLI messages (Go's IsErrConnectionFailed)", () => {
    expect(
      legacyIsDockerDaemonUnreachable(
        "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      ),
    ).toBe(true);
    // Case-insensitive + the podman phrasing.
    expect(legacyIsDockerDaemonUnreachable("cannot connect to podman")).toBe(true);
    expect(legacyIsDockerDaemonUnreachable("Is the docker daemon running?")).toBe(true);
  });

  it("does not flag an unrelated inspect failure (e.g. a permission error)", () => {
    expect(legacyIsDockerDaemonUnreachable("permission denied while trying to connect")).toBe(
      false,
    );
    expect(legacyIsDockerDaemonUnreachable("Error: No such container: supabase_db_x")).toBe(false);
    expect(legacyIsDockerDaemonUnreachable("")).toBe(false);
  });

  it("exposes Go's install hint verbatim", () => {
    expect(LEGACY_SUGGEST_DOCKER_INSTALL).toContain("https://docs.docker.com/desktop");
  });
});
