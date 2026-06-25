import { describe, expect, it } from "vitest";

import { legacyIsMissingContainerInspectError } from "./legacy-pgdelta.seam.layer.ts";

describe("legacyIsMissingContainerInspectError", () => {
  it("matches Docker and Podman missing-container stderr", () => {
    expect(legacyIsMissingContainerInspectError("Error: No such container: supabase_db_test")).toBe(
      true,
    );
    expect(legacyIsMissingContainerInspectError("Error: no such container: supabase_db_test")).toBe(
      true,
    );
  });

  it("does not match unrelated inspect failures", () => {
    expect(legacyIsMissingContainerInspectError("Cannot connect to the Docker daemon")).toBe(false);
  });
});
