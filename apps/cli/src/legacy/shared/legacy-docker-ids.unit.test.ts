import { describe, expect, it } from "vitest";

import {
  LEGACY_CLI_PROJECT_LABEL,
  legacyCliProjectFilterValue,
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
  legacyServiceContainerIds,
  localDbContainerId,
} from "./legacy-docker-ids.ts";

describe("legacyResolveLocalProjectId", () => {
  it("prefers SUPABASE_PROJECT_ID (env) over config.toml and the basename", () => {
    // Go applies SUPABASE_PROJECT_ID to Config.ProjectId (AutomaticEnv) before DbId.
    expect(legacyResolveLocalProjectId("env-id", "toml-id", "/work/proj")).toBe("env-id");
  });

  it("falls back to config.toml project_id when the env var is unset/empty", () => {
    expect(legacyResolveLocalProjectId(undefined, "toml-id", "/work/proj")).toBe("toml-id");
    expect(legacyResolveLocalProjectId("", "toml-id", "/work/proj")).toBe("toml-id");
  });

  it("falls back to the workdir basename when both env and config.toml are absent", () => {
    expect(legacyResolveLocalProjectId(undefined, undefined, "/work/my-app")).toBe("my-app");
    expect(legacyResolveLocalProjectId(undefined, "", "/work/my-app")).toBe("my-app");
  });

  it("feeds the resolved id into the local db container name", () => {
    const id = legacyResolveLocalProjectId("env-id", undefined, "/work/proj");
    expect(localDbContainerId(id)).toBe("supabase_db_env-id");
  });
});

describe("legacyServiceContainerIds", () => {
  it("returns the 13 service container ids in Go's GetDockerIds() order", () => {
    // apps/cli-go/internal/utils/config.go:82-98 — kong, auth, inbucket, realtime,
    // rest, storage, imgproxy, pg_meta, studio, edge_runtime, analytics, vector, pooler.
    expect(legacyServiceContainerIds("my-app")).toEqual([
      "supabase_kong_my-app",
      "supabase_auth_my-app",
      "supabase_inbucket_my-app",
      "supabase_realtime_my-app",
      "supabase_rest_my-app",
      "supabase_storage_my-app",
      "supabase_imgproxy_my-app",
      "supabase_pg_meta_my-app",
      "supabase_studio_my-app",
      "supabase_edge_runtime_my-app",
      "supabase_analytics_my-app",
      "supabase_vector_my-app",
      "supabase_pooler_my-app",
    ]);
  });

  it("sanitizes the project id the same way as localDbContainerId", () => {
    const ids = legacyServiceContainerIds("My App!!");
    expect(ids[0]).toBe("supabase_kong_My_App_");
  });
});

describe("legacyCliProjectFilterValue", () => {
  it("returns the bare label when the project id is empty (Go's --all path)", () => {
    expect(legacyCliProjectFilterValue("")).toBe(LEGACY_CLI_PROJECT_LABEL);
  });

  it("returns label=projectId when a project id is given", () => {
    expect(legacyCliProjectFilterValue("my-app")).toBe(`${LEGACY_CLI_PROJECT_LABEL}=my-app`);
  });

  it("must be sanitized by the caller for the label to match what start wrote", () => {
    // This function is a pure pass-through by design (see its doc comment) — a
    // dirty config/env-derived id must be sanitized by the caller BEFORE being
    // passed here, matching Go's Config.Validate sanitizing Config.ProjectId
    // once at config-load time so every reader (including the Docker label
    // `start` writes) sees the same string.
    const dirty = "My App!!";
    expect(legacyCliProjectFilterValue(dirty)).toBe(`${LEGACY_CLI_PROJECT_LABEL}=My App!!`);
    expect(legacyCliProjectFilterValue(legacySanitizeProjectId(dirty))).toBe(
      `${LEGACY_CLI_PROJECT_LABEL}=My_App_`,
    );
  });
});

describe("legacySanitizeProjectId", () => {
  it("replaces invalid character runs with a single underscore", () => {
    expect(legacySanitizeProjectId("My App!!")).toBe("My_App_");
  });

  it("strips leading underscore/dot/dash runs", () => {
    expect(legacySanitizeProjectId("...hidden-app")).toBe("hidden-app");
  });

  it("caps the result at 40 characters", () => {
    const long = "a".repeat(50);
    expect(legacySanitizeProjectId(long)).toBe("a".repeat(40));
  });

  it("leaves an already-clean id unchanged", () => {
    expect(legacySanitizeProjectId("my-app_123")).toBe("my-app_123");
  });
});
