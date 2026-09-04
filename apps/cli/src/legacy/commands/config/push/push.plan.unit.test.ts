/**
 * Unit tests for push.plan.ts.
 */

import type { CliConfig, ConfigChange, ConfigChangeSet, ProjectConfig } from "@supabase/config";
import { comparableProjectConfigPaths, getDefaultCliConfig } from "@supabase/config";
import { describe, expect, it } from "vitest";

import {
  LEGACY_PUSH_ADDON_GATES,
  LEGACY_PUSH_RESOURCES,
  LEGACY_PUSH_UNSUPPORTED_PREFIXES,
  legacyApplyMfaAddonDecline,
  legacyChangesCommunicated,
  legacyPlanConfigPush,
  legacyPushAddonPromptNeeded,
  legacyPushPromptKey,
  legacyPushResourceEnabled,
  legacyPushResourceForPath,
  legacyPushResponseBlock,
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

/** A remote `ProjectConfig` with the given gate's `verify_enabled` flag set. */
function remoteWithVerifyEnabled(
  gate: (typeof LEGACY_PUSH_ADDON_GATES)[number],
  verifyEnabled: boolean,
): ProjectConfig {
  switch (gate.costKey) {
    case "auth_mfa_phone":
      return { auth: { mfa: { phone: { verify_enabled: verifyEnabled } } } };
    case "auth_mfa_web_authn":
      return { auth: { mfa: { web_authn: { verify_enabled: verifyEnabled } } } };
  }
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

describe("legacyPushResponseBlock", () => {
  it("maps every db.* resource to the 'database' v2 response block", () => {
    expect(legacyPushResponseBlock("db.settings")).toBe("database");
    expect(legacyPushResponseBlock("db.network_restrictions")).toBe("database");
    expect(legacyPushResponseBlock("db.ssl_enforcement")).toBe("database");
  });

  it("maps api/auth/storage to their own block", () => {
    expect(legacyPushResponseBlock("api")).toBe("api");
    expect(legacyPushResponseBlock("auth")).toBe("auth");
    expect(legacyPushResponseBlock("storage")).toBe("storage");
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

  it("classifies a path outside every registered prefix as unsupported rather than undefined", () => {
    expect(legacyPushResourceForPath(["realtime", "enabled"])).toBe("unsupported");
  });

  it("drift guard: every comparable config path resolves to a resource, or one of the three intentionally-unsupported prefixes", () => {
    // `legacyPushResourceForPath` never returns `undefined` (B12) — an
    // unroutable path falls through to `"unsupported"` too, the same result
    // an intentionally-listed prefix gets. So a plain `!== undefined`
    // assertion here would never catch a new registry row this module
    // forgot to route. Assert the stronger claim instead: every
    // `"unsupported"` result must be explained by one of
    // `LEGACY_PUSH_UNSUPPORTED_PREFIXES`, not by falling through unnoticed.
    for (const path of comparableProjectConfigPaths) {
      const resource = legacyPushResourceForPath(path);
      const isIntentionallyUnsupported = LEGACY_PUSH_UNSUPPORTED_PREFIXES.some(
        (prefix) =>
          prefix.length <= path.length && prefix.every((segment, index) => path[index] === segment),
      );
      expect(
        resource !== "unsupported" || isIntentionallyUnsupported,
        `comparable path silently fell through to "unsupported": ${JSON.stringify(path)}`,
      ).toBe(true);
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
    expect(plan.changesByResource.api.map((c) => c.path)).toEqual([["api", "max_rows"]]);
    expect(plan.changesByResource.auth.map((c) => c.path)).toEqual([["auth", "site_url"]]);
    expect(plan.changesByResource.storage.map((c) => c.path)).toEqual([
      ["storage", "file_size_limit"],
    ]);
    expect(plan.changesByResource["db.settings"].map((c) => c.path)).toEqual([
      ["db", "settings", "shared_buffers"],
    ]);
  });

  it("includes every declared resource, even with no changes routed to it", () => {
    const plan = legacyPlanConfigPush(changeSet([]));
    for (const resource of LEGACY_PUSH_RESOURCES) {
      expect(plan.changesByResource[resource]).toEqual([]);
    }
  });

  it("excludes remote_only changes from every resource bucket", () => {
    const set = changeSet([change(["auth", "site_url"], "remote_only", undefined, "remote")]);
    const plan = legacyPlanConfigPush(set);
    expect(plan.changesByResource.auth).toEqual([]);
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
    expect(plan.changesByResource["db.settings"]).toEqual([]);
    expect(plan.changesByResource.auth).toEqual([]);
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

describe("legacyPushResourceEnabled", () => {
  it("is always true for api and db.settings", () => {
    const config = getDefaultCliConfig();
    expect(legacyPushResourceEnabled("api", config, {})).toBe(true);
    expect(legacyPushResourceEnabled("db.settings", config, {})).toBe(true);
  });

  it("gates db.network_restrictions on the decoded config's own enabled flag", () => {
    const base = getDefaultCliConfig();
    const enabled: CliConfig = {
      ...base,
      db: { ...base.db, network_restrictions: { ...base.db.network_restrictions, enabled: true } },
    };
    const disabled: CliConfig = {
      ...base,
      db: { ...base.db, network_restrictions: { ...base.db.network_restrictions, enabled: false } },
    };
    expect(legacyPushResourceEnabled("db.network_restrictions", enabled, {})).toBe(true);
    expect(legacyPushResourceEnabled("db.network_restrictions", disabled, {})).toBe(false);
  });

  it("gates db.ssl_enforcement on the local projection's declared presence", () => {
    const config = getDefaultCliConfig();
    const declared: ProjectConfig = { db: { ssl_enforcement: { enabled: true } } };
    expect(legacyPushResourceEnabled("db.ssl_enforcement", config, declared)).toBe(true);
    expect(legacyPushResourceEnabled("db.ssl_enforcement", config, {})).toBe(false);
  });

  it("gates auth and storage on the decoded config's own enabled flag", () => {
    const base = getDefaultCliConfig();
    const authOff: CliConfig = { ...base, auth: { ...base.auth, enabled: false } };
    const storageOff: CliConfig = { ...base, storage: { ...base.storage, enabled: false } };
    expect(legacyPushResourceEnabled("auth", base, {})).toBe(true);
    expect(legacyPushResourceEnabled("auth", authOff, {})).toBe(false);
    expect(legacyPushResourceEnabled("storage", base, {})).toBe(true);
    expect(legacyPushResourceEnabled("storage", storageOff, {})).toBe(false);
  });
});

describe("LEGACY_PUSH_ADDON_GATES", () => {
  it("names exactly the phone and web_authn MFA addons", () => {
    expect(LEGACY_PUSH_ADDON_GATES).toEqual([
      {
        costKey: "auth_mfa_phone",
        verifyPath: ["auth", "mfa", "phone", "verify_enabled"],
        enrollPath: ["auth", "mfa", "phone", "enroll_enabled"],
      },
      {
        costKey: "auth_mfa_web_authn",
        verifyPath: ["auth", "mfa", "web_authn", "verify_enabled"],
        enrollPath: ["auth", "mfa", "web_authn", "enroll_enabled"],
      },
    ]);
  });
});

describe("legacyPushAddonPromptNeeded", () => {
  it.each(LEGACY_PUSH_ADDON_GATES)(
    "prompts when $costKey's verify_enabled flips to true",
    (gate) => {
      const changes = [change(gate.verifyPath, "update", true, false)];
      expect(legacyPushAddonPromptNeeded(changes, gate, {})).toBe(true);
    },
  );

  it.each(LEGACY_PUSH_ADDON_GATES)(
    "prompts when only $costKey's enroll_enabled flips to true and verify_enabled is false on the remote",
    (gate) => {
      const changes = [change(gate.enrollPath, "update", true, false)];
      expect(legacyPushAddonPromptNeeded(changes, gate, {})).toBe(true);
    },
  );

  it.each(LEGACY_PUSH_ADDON_GATES)(
    "does not prompt when $costKey's enroll_enabled flips to true but verify_enabled is already true on the remote",
    (gate) => {
      const changes = [change(gate.enrollPath, "update", true, false)];
      const remote = remoteWithVerifyEnabled(gate, true);
      expect(legacyPushAddonPromptNeeded(changes, gate, remote)).toBe(false);
    },
  );

  it.each(LEGACY_PUSH_ADDON_GATES)(
    "does not prompt when neither $costKey flag is turning on",
    (gate) => {
      const changes = [change(gate.verifyPath, "update", false, false)];
      expect(legacyPushAddonPromptNeeded(changes, gate, {})).toBe(false);
    },
  );

  it.each(LEGACY_PUSH_ADDON_GATES)(
    "does not prompt when $costKey's verify_enabled flips to true but the remote already has it on",
    (gate) => {
      const changes = [change(gate.verifyPath, "update", true, true)];
      const remote = remoteWithVerifyEnabled(gate, true);
      expect(legacyPushAddonPromptNeeded(changes, gate, remote)).toBe(false);
    },
  );
});

describe("legacyChangesCommunicated", () => {
  it("narrows the routed change list to the paths a body actually communicated", () => {
    const changes = [
      change(["auth", "site_url"], "update"),
      change(["auth", "jwt_expiry"], "update"),
    ];
    const communicated = legacyChangesCommunicated(changes, [["auth", "site_url"]]);
    expect(communicated.map((c) => c.path)).toEqual([["auth", "site_url"]]);
  });

  it("returns an empty array when nothing was communicated", () => {
    expect(legacyChangesCommunicated([change(["auth", "site_url"], "update")], [])).toEqual([]);
  });
});

describe("legacyApplyMfaAddonDecline", () => {
  const gate = LEGACY_PUSH_ADDON_GATES[0];
  if (gate === undefined) throw new Error("expected at least one addon gate");

  it("drops the addon's changes outright when the remote already has both flags false", () => {
    const changes = [
      change(["auth", "site_url"], "update"),
      change(gate.verifyPath, "update", true, false),
      change(gate.enrollPath, "update", true, false),
    ];
    const remote: ProjectConfig = {
      auth: { mfa: { phone: { verify_enabled: false, enroll_enabled: false } } },
    };
    const result = legacyApplyMfaAddonDecline(changes, gate, remote);
    expect(result.map((c) => c.path)).toEqual([["auth", "site_url"]]);
  });

  it("drops the addon's changes outright when the remote has neither flag declared", () => {
    const changes = [change(gate.verifyPath, "update", true, undefined)];
    const result = legacyApplyMfaAddonDecline(changes, gate, {});
    expect(result).toEqual([]);
  });

  it("replaces the addon's changes with explicit falses when the remote currently has verify_enabled true", () => {
    const changes = [
      change(["auth", "site_url"], "update"),
      change(gate.verifyPath, "update", true, true),
    ];
    const remote: ProjectConfig = { auth: { mfa: { phone: { verify_enabled: true } } } };
    const result = legacyApplyMfaAddonDecline(changes, gate, remote);
    expect(result).toEqual([
      change(["auth", "site_url"], "update"),
      { path: gate.verifyPath, class: "update", local: false, remote: true, declared: true },
      { path: gate.enrollPath, class: "update", local: false, remote: undefined, declared: true },
    ]);
  });

  it("replaces the addon's changes with explicit falses when the remote currently has enroll_enabled true", () => {
    const changes = [change(gate.enrollPath, "update", true, true)];
    const remote: ProjectConfig = { auth: { mfa: { phone: { enroll_enabled: true } } } };
    const result = legacyApplyMfaAddonDecline(changes, gate, remote);
    expect(result).toEqual([
      { path: gate.verifyPath, class: "update", local: false, remote: undefined, declared: true },
      { path: gate.enrollPath, class: "update", local: false, remote: true, declared: true },
    ]);
  });
});
