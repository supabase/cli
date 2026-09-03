/**
 * Unit tests for push.plan.ts.
 */

import type { ConfigChange, ConfigChangeSet } from "@supabase/config/internal";
import { comparableProjectConfigPaths } from "@supabase/config";
import { describe, expect, it } from "vitest";

import {
  LEGACY_PUSH_RESOURCES,
  LEGACY_PUSH_UNSUPPORTED_PREFIXES,
  legacyPlanConfigPush,
  legacyPushPromptKey,
  legacyPushResourceForPath,
  type LegacyPushResource,
} from "./push.plan.ts";

function change(
  path: ReadonlyArray<string>,
  changeClass: ConfigChange["class"],
  local: unknown = "local",
  remote: unknown = "remote",
): ConfigChange {
  return { path, class: changeClass, local, remote, declared: true };
}

function changeSet(changes: ReadonlyArray<ConfigChange>, remoteOnly = 0): ConfigChangeSet {
  return {
    changes,
    masked: [],
    unmanaged: [],
    counts: {
      update: changes.filter((c) => c.class === "update").length,
      remote_only: remoteOnly,
      local_only: changes.filter((c) => c.class === "local_only").length,
      total: changes.length + remoteOnly,
    },
  };
}

describe("LEGACY_PUSH_RESOURCES", () => {
  it("is stable and matches the established per-section push order", () => {
    expect(LEGACY_PUSH_RESOURCES).toEqual([
      "api",
      "db.settings",
      "db.network_restrictions",
      "db.ssl_enforcement",
      "auth",
      "storage",
    ]);
  });
});

describe("legacyPushPromptKey", () => {
  it("returns the resource's own key for api/auth/storage", () => {
    expect(legacyPushPromptKey("api")).toBe("api");
    expect(legacyPushPromptKey("auth")).toBe("auth");
    expect(legacyPushPromptKey("storage")).toBe("storage");
  });

  it("routes every db.* resource to the shared 'db' cost-matrix key", () => {
    expect(legacyPushPromptKey("db.settings")).toBe("db");
    expect(legacyPushPromptKey("db.network_restrictions")).toBe("db");
    expect(legacyPushPromptKey("db.ssl_enforcement")).toBe("db");
  });
});

describe("legacyPushResourceForPath", () => {
  it.each<[ReadonlyArray<string>, LegacyPushResource]>([
    [["api", "max_rows"], "api"],
    [["api", "schemas"], "api"],
    [["db", "settings", "shared_buffers"], "db.settings"],
    [["db", "network_restrictions", "allowed_cidrs"], "db.network_restrictions"],
    [["db", "network_restrictions", "allowed_cidrs_v6"], "db.network_restrictions"],
    [["db", "ssl_enforcement", "enabled"], "db.ssl_enforcement"],
    [["auth", "site_url"], "auth"],
    [["storage", "file_size_limit"], "storage"],
  ])("routes %j to %s", (path, resource) => {
    expect(legacyPushResourceForPath(path)).toBe(resource);
  });

  it("routes a descendant of a mapped container to that container's resource", () => {
    // `auth.sms.test_otp` is a mapped record; `diffProjectConfig` yields one
    // leaf change per phone-number entry, e.g. this one.
    expect(legacyPushResourceForPath(["auth", "sms", "test_otp", "+15555550123"])).toBe("auth");
  });

  it.each<[ReadonlyArray<string>]>([
    [["db", "major_version"]],
    [["db", "pooler", "pool_mode"]],
    [["db", "pooler", "default_pool_size"]],
    [["db", "pooler", "max_client_conn"]],
    [["auth", "oauth_server", "enabled"]],
    [["auth", "oauth_server", "allow_dynamic_registration"]],
    [["auth", "oauth_server", "authorization_url_path"]],
  ])("classifies %j as unsupported", (path) => {
    expect(legacyPushResourceForPath(path)).toBe("unsupported");
  });

  it("returns undefined for a path outside every registered prefix", () => {
    expect(legacyPushResourceForPath(["realtime", "enabled"])).toBeUndefined();
  });

  it("drift guard: every comparable config path resolves to a resource or an unsupported prefix", () => {
    for (const path of comparableProjectConfigPaths) {
      expect(
        legacyPushResourceForPath(path),
        `unmapped comparable path: ${JSON.stringify(path)}`,
      ).not.toBeUndefined();
    }
  });
});

describe("legacyPlanConfigPush", () => {
  it("groups pushable changes by resource, preserving path order", () => {
    const set = changeSet([
      change(["auth", "site_url"], "update"),
      change(["api", "max_rows"], "update"),
      change(["storage", "file_size_limit"], "local_only"),
      change(["db", "settings", "shared_buffers"], "update"),
    ]);
    const plan = legacyPlanConfigPush(set);
    expect(plan.changesByResource.get("api")?.map((c) => c.path)).toEqual([["api", "max_rows"]]);
    expect(plan.changesByResource.get("auth")?.map((c) => c.path)).toEqual([["auth", "site_url"]]);
    expect(plan.changesByResource.get("storage")?.map((c) => c.path)).toEqual([
      ["storage", "file_size_limit"],
    ]);
    expect(plan.changesByResource.get("db.settings")?.map((c) => c.path)).toEqual([
      ["db", "settings", "shared_buffers"],
    ]);
  });

  it("includes every declared resource, even with no changes routed to it", () => {
    const plan = legacyPlanConfigPush(changeSet([]));
    for (const resource of LEGACY_PUSH_RESOURCES) {
      expect(plan.changesByResource.get(resource)).toEqual([]);
    }
  });

  it("excludes remote_only changes from every resource bucket", () => {
    const set = changeSet([change(["auth", "site_url"], "remote_only", undefined, "remote")]);
    const plan = legacyPlanConfigPush(set);
    expect(plan.changesByResource.get("auth")).toEqual([]);
  });

  it("counts remote_only changes as informational only", () => {
    const plan = legacyPlanConfigPush(changeSet([], 12));
    expect(plan.remoteOnly).toBe(12);
    expect(plan.unsupported).toEqual([]);
  });

  it("routes an unsupported-prefix pushable change into `unsupported`, not a resource bucket", () => {
    const set = changeSet([
      change(["db", "pooler", "pool_mode"], "update"),
      change(["auth", "oauth_server", "enabled"], "local_only"),
    ]);
    const plan = legacyPlanConfigPush(set);
    expect(plan.unsupported).toEqual([
      ["db", "pooler", "pool_mode"],
      ["auth", "oauth_server", "enabled"],
    ]);
    expect(plan.changesByResource.get("db.settings")).toEqual([]);
    expect(plan.changesByResource.get("auth")).toEqual([]);
  });
});

describe("LEGACY_PUSH_UNSUPPORTED_PREFIXES", () => {
  it("names exactly the three unsupported subtrees", () => {
    expect(LEGACY_PUSH_UNSUPPORTED_PREFIXES).toEqual([
      ["db", "major_version"],
      ["db", "pooler"],
      ["auth", "oauth_server"],
    ]);
  });
});
