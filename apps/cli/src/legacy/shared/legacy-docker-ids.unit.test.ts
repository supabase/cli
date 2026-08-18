import { afterEach, describe, expect, it } from "vitest";

import {
  LEGACY_CLI_PROJECT_LABEL,
  legacyCliProjectFilterValue,
  legacyResolveLocalProjectId,
  legacySanitizeProjectId,
  legacyServiceContainerIds,
  localDbContainerId,
  localNetworkId,
} from "./legacy-docker-ids.ts";
import { resolveDockerNetworkMode } from "../../shared/functions/functions-docker.ts";
import { legacyViperEnvStringWithProjectFallback } from "../../shared/legacy/legacy-viper-env.ts";

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
    // kong, auth, inbucket, realtime,
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

describe("resolveDockerNetworkMode composed with legacyViperEnvStringWithProjectFallback (start/db start call shape)", () => {
  const KEY = "SUPABASE_NETWORK_ID";

  afterEach(() => {
    delete process.env[KEY];
  });

  // `start`/`db start` resolve the network exactly like the `functions`
  // Docker paths: the shared 3-way resolver fed by the viper-shaped
  // shell/project-dotenv env read — one home, per the review round on
  // CLI-1963 that deleted `legacyResolveNetworkId`'s divergent copy.
  function resolve(flagValue: string | undefined, projectEnv: Record<string, string>) {
    return resolveDockerNetworkMode({
      explicit: flagValue,
      envOverride: legacyViperEnvStringWithProjectFallback(KEY, projectEnv),
      projectId: "my-app",
    });
  }

  it("prefers an explicit --network-id flag over everything else", () => {
    process.env[KEY] = "env-network";
    expect(resolve("flag-network", { [KEY]: "toml-network" })).toBe("flag-network");
  });

  it("falls back to SUPABASE_NETWORK_ID (shell) when the flag is absent", () => {
    process.env[KEY] = "shell-network";
    expect(resolve(undefined, {})).toBe("shell-network");
  });

  it("falls back to SUPABASE_NETWORK_ID (project .env) when both the flag and shell are absent", () => {
    delete process.env[KEY];
    expect(resolve(undefined, { [KEY]: "project-network" })).toBe("project-network");
  });

  it("prefers the shell value over the project .env value (presence wins, matching godotenv.Load)", () => {
    process.env[KEY] = "shell-network";
    expect(resolve(undefined, { [KEY]: "project-network" })).toBe("shell-network");
  });

  it("falls back to the generated network name when the flag and env are all absent/empty", () => {
    delete process.env[KEY];
    expect(resolve(undefined, {})).toBe(localNetworkId("my-app"));
    expect(resolve("", {})).toBe(localNetworkId("my-app"));
  });

  it("an explicit-but-empty --network-id= skips the env var entirely (viper: a Changed pflag resolves before AutomaticEnv)", () => {
    process.env[KEY] = "env-network";
    expect(resolve("", { [KEY]: "project-network" })).toBe(localNetworkId("my-app"));
  });

  it("treats an empty shell value as present (blocks the project value) and falls to generated", () => {
    process.env[KEY] = "";
    expect(resolve(undefined, { [KEY]: "project-network" })).toBe(localNetworkId("my-app"));
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
