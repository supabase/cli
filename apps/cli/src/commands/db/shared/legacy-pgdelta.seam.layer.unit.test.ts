import { describe, expect, it } from "vitest";

import {
  legacyIsMissingContainerInspectError,
  legacyPostgresImageRemediation,
  legacyResolveContainerInspectImageName,
  legacyResolvePostgresImageMajor,
  legacyToShadowDbError,
} from "./legacy-pgdelta.seam.layer.ts";

describe("legacyResolvePostgresImageMajor", () => {
  it("reads standard and OrioleDB Postgres tags", () => {
    expect(legacyResolvePostgresImageMajor("public.ecr.aws/supabase/postgres:17.6.1.167")).toBe(17);
    expect(legacyResolvePostgresImageMajor("supabase/postgres:orioledb-15.1.0.55")).toBe(15);
    expect(legacyResolvePostgresImageMajor("supabase/postgres:16.0.0.1-orioledb")).toBe(16);
  });

  it("returns undefined when the tag does not expose a numeric major", () => {
    expect(legacyResolvePostgresImageMajor("supabase/postgres:latest")).toBeUndefined();
    expect(legacyResolvePostgresImageMajor("registry.example:5000/postgres")).toBeUndefined();
  });
});

describe("legacyPostgresImageRemediation", () => {
  it("preserves data for same-major tag drift", () => {
    const remediation = legacyPostgresImageRemediation(
      "supabase/postgres:17.6.1.166",
      "public.ecr.aws/supabase/postgres:17.6.1.167",
    );
    expect(remediation).toContain("Run supabase stop, then supabase start");
    expect(remediation).not.toContain("--no-backup");
  });

  it("preserves data for image-family drift", () => {
    const remediation = legacyPostgresImageRemediation(
      "supabase/postgres:17.6.1.167",
      "ghcr.io/supabase/cli/postgres:17.6.1.167",
    );
    expect(remediation).toContain("same SUPABASE_USE_SLIM_IMAGES setting");
    expect(remediation).not.toContain("--no-backup");
  });

  it("deletes local data only for a proven major change", () => {
    const remediation = legacyPostgresImageRemediation(
      "supabase/postgres:15.8.1.085",
      "public.ecr.aws/supabase/postgres:17.6.1.167",
    );
    expect(remediation).toContain("supabase stop --all --no-backup");
    expect(remediation).toContain("deletes all local database data");
  });

  it("uses the data-preserving remedy when a major is unparseable", () => {
    const remediation = legacyPostgresImageRemediation(
      "supabase/postgres:latest",
      "public.ecr.aws/supabase/postgres:17.6.1.167",
    );
    expect(remediation).toContain("Run supabase stop, then supabase start");
    expect(remediation).not.toContain("--no-backup");
  });
});

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

describe("legacyToShadowDbError", () => {
  it("carries the underlying recovery suggestion onto the seam error", () => {
    const mapped = legacyToShadowDbError({
      message: "container supabase_db_x is not ready: exec format error",
      suggestion: "Run `docker image rm public.ecr.aws/supabase/postgres:17.4.1.056` and retry.",
    });
    expect(mapped.suggestion).toBe(
      "Run `docker image rm public.ecr.aws/supabase/postgres:17.4.1.056` and retry.",
    );
    expect(mapped.message).toBe(
      "failed to provision the shadow database: container supabase_db_x is not ready: exec format error",
    );
  });

  it("omits suggestion when the underlying failure has none", () => {
    const mapped = legacyToShadowDbError({ message: "boom" });
    expect(mapped.suggestion).toBeUndefined();
  });

  it("still tags daemon failures while carrying a suggestion", () => {
    const mapped = legacyToShadowDbError({
      message: "cannot connect to the Docker daemon",
      reason: "docker_daemon",
      suggestion: "Start Docker Desktop and retry.",
    });
    expect(mapped.docker).toBe("daemon");
    expect(mapped.suggestion).toBe("Start Docker Desktop and retry.");
  });
});
