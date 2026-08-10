import { describe, expect, it } from "vitest";

import {
  legacyIsMissingContainerInspectError,
  legacyResolveContainerInspectImageName,
} from "./legacy-pgdelta.seam.layer.ts";

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

describe("legacyResolveContainerInspectImageName", () => {
  it("reads Docker's config image from inspect JSON", () => {
    expect(
      legacyResolveContainerInspectImageName(
        JSON.stringify([{ Config: { Image: "public.ecr.aws/supabase/postgres:17.4.1.056" } }]),
      ),
    ).toBe("public.ecr.aws/supabase/postgres:17.4.1.056");
  });

  it("prefers Podman's image name from inspect JSON", () => {
    expect(
      legacyResolveContainerInspectImageName(
        JSON.stringify([
          {
            Image: "sha256:0123456789",
            ImageName: "public.ecr.aws/supabase/postgres:17.4.1.056",
          },
        ]),
      ),
    ).toBe("public.ecr.aws/supabase/postgres:17.4.1.056");
  });

  it("keeps raw formatter output as a compatibility fallback", () => {
    expect(legacyResolveContainerInspectImageName("supabase/postgres:15.1.0")).toBe(
      "supabase/postgres:15.1.0",
    );
  });

  it("returns empty when JSON inspect output has no image-name field", () => {
    expect(legacyResolveContainerInspectImageName(JSON.stringify([{ Image: "sha256:0123" }]))).toBe(
      "",
    );
  });
});
