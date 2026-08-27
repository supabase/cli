import { describe, expect, it } from "vitest";

import { LegacyDeclarativeShadowDbError } from "../commands/db/shared/legacy-pgdelta.errors.ts";
import { SchemaEngineError } from "../../shared/schema/schema-errors.ts";
import { legacyIsolatedShadowToEngineError } from "./legacy-docker-isolated-shadow.layer.ts";

const DELETE_CACHE_HINT = "delete ~/.supabase/cache/shadow-baseline";

describe("legacyIsolatedShadowToEngineError", () => {
  it("keeps a container-exit create-baseline failure in detail and does not suggest deleting the cache", () => {
    const mapped = legacyIsolatedShadowToEngineError(
      new LegacyDeclarativeShadowDbError({
        message:
          "error running container: exit 1:\nStorageBackendError: Migration fix-search-by-timestamp-sqli not found",
      }),
    );
    expect(mapped).toBeInstanceOf(SchemaEngineError);
    expect(mapped.detail).toContain(
      "StorageBackendError: Migration fix-search-by-timestamp-sqli not found",
    );
    expect(mapped.suggestion).toBe("Retry the command.");
    expect(mapped.suggestion).not.toContain(DELETE_CACHE_HINT);
  });

  it.each([
    "failed to restore shadow baseline: docker cp failed",
    "failed to create docker container: failed to restore archive into container",
  ])("suggests deleting the cache when restoring an existing tar failed: %s", (message) => {
    const mapped = legacyIsolatedShadowToEngineError(
      new LegacyDeclarativeShadowDbError({ message }),
    );
    expect(mapped.suggestion).toContain(DELETE_CACHE_HINT);
  });

  it("keeps the daemon hint when Docker is unreachable", () => {
    const mapped = legacyIsolatedShadowToEngineError(
      new LegacyDeclarativeShadowDbError({
        message: "Cannot connect to the Docker daemon",
        docker: "daemon",
      }),
    );
    expect(mapped.suggestion).toBe("Start Docker Desktop or Podman, then retry.");
    expect(mapped.suggestion).not.toContain(DELETE_CACHE_HINT);
  });

  it("keeps an underlying recovery suggestion when one is already attached", () => {
    const mapped = legacyIsolatedShadowToEngineError(
      new LegacyDeclarativeShadowDbError({
        message: "container supabase_db_x is not ready: exec format error",
        suggestion: "Run `docker image rm public.ecr.aws/supabase/postgres:17.4.1.056` and retry.",
      }),
    );
    expect(mapped.suggestion).toBe(
      "Run `docker image rm public.ecr.aws/supabase/postgres:17.4.1.056` and retry.",
    );
  });
});
