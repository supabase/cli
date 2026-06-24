import { describe, expect, it } from "vitest";

import { legacyResolveLocalProjectId, localDbContainerId } from "./legacy-docker-ids.ts";

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
