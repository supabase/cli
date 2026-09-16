import type { CliConfig, ConfigChange, ConfigChangeSet, ProjectConfig } from "@supabase/config";
import { comparableProjectConfigPaths, getDefaultCliConfig } from "@supabase/config";
import { describe, expect, it } from "vitest";

import {
  PUSH_ADDON_GATES,
  PUSH_RESOURCES,
  PUSH_UNSUPPORTED_PREFIXES,
  applyMfaAddonDecline,
  changesCommunicated,
  planConfigPush,
  pushAddonPromptNeeded,
  pushPromptKey,
  pushResourceEnabled,
  pushResourceForPath,
  pushResponseBlock,
  type PushResource,
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
    absencePolicy: "absent-is-hands-off",
  };
}

/** A remote `ProjectConfig` with the given gate's `verify_enabled` flag set. */
function remoteWithVerifyEnabled(
  gate: (typeof PUSH_ADDON_GATES)[number],
  verifyEnabled: boolean,
): ProjectConfig {
  switch (gate.costKey) {
    case "auth_mfa_phone":
      return { auth: { mfa: { phone: { verify_enabled: verifyEnabled } } } };
    case "auth_mfa_web_authn":
      return { auth: { mfa: { web_authn: { verify_enabled: verifyEnabled } } } };
  }
}

describe("PUSH_RESOURCES", () => {
  it("is stable and matches the established per-section push order", () => {
    expect(PUSH_RESOURCES).toEqual([
      "api",
      "db.settings",
      "db.network_restrictions",
      "db.ssl_enforcement",
      "auth",
      "storage",
    ]);
  });
});

describe("pushPromptKey", () => {
  it("returns the resource's own key for api/auth/storage", () => {
    expect(pushPromptKey("api")).toBe("api");
    expect(pushPromptKey("auth")).toBe("auth");
    expect(pushPromptKey("storage")).toBe("storage");
  });

  it("routes every db.* resource to the shared 'db' cost-matrix key", () => {
    expect(pushPromptKey("db.settings")).toBe("db");
    expect(pushPromptKey("db.network_restrictions")).toBe("db");
    expect(pushPromptKey("db.ssl_enforcement")).toBe("db");
  });
});

describe("pushResponseBlock", () => {
  it("maps every db.* resource to the 'database' v2 response block", () => {
    expect(pushResponseBlock("db.settings")).toBe("database");
    expect(pushResponseBlock("db.network_restrictions")).toBe("database");
    expect(pushResponseBlock("db.ssl_enforcement")).toBe("database");
  });

  it("maps api/auth/storage to their own block", () => {
    expect(pushResponseBlock("api")).toBe("api");
    expect(pushResponseBlock("auth")).toBe("auth");
    expect(pushResponseBlock("storage")).toBe("storage");
  });
});

describe("pushResourceForPath", () => {
  it.each<[ReadonlyArray<string>, PushResource]>([
    [["api", "max_rows"], "api"],
    [["api", "schemas"], "api"],
    [["db", "settings", "shared_buffers"], "db.settings"],
    [["db", "network_restrictions", "allowed_cidrs"], "db.network_restrictions"],
    [["db", "network_restrictions", "allowed_cidrs_v6"], "db.network_restrictions"],
    [["db", "ssl_enforcement", "enabled"], "db.ssl_enforcement"],
    [["auth", "site_url"], "auth"],
    [["auth", "oauth_server", "enabled"], "auth"],
    [["auth", "oauth_server", "allow_dynamic_registration"], "auth"],
    [["auth", "oauth_server", "authorization_url_path"], "auth"],
    [["storage", "file_size_limit"], "storage"],
  ])("routes %j to %s", (path, resource) => {
    expect(pushResourceForPath(path)).toBe(resource);
  });

  it("routes a descendant of a mapped container to that container's resource", () => {
    // `auth.sms.test_otp` is a mapped record; `diffProjectConfig` yields one
    // leaf change per phone-number entry, e.g. this one.
    expect(pushResourceForPath(["auth", "sms", "test_otp", "+15555550123"])).toBe("auth");
  });

  it.each<[ReadonlyArray<string>]>([
    [["db", "major_version"]],
    [["db", "pooler", "pool_mode"]],
    [["db", "pooler", "default_pool_size"]],
    [["db", "pooler", "max_client_conn"]],
  ])("classifies %j as unsupported", (path) => {
    expect(pushResourceForPath(path)).toBe("unsupported");
  });

  it("classifies a path outside every registered prefix as unsupported rather than undefined", () => {
    expect(pushResourceForPath(["realtime", "enabled"])).toBe("unsupported");
  });

  it("drift guard: every comparable config path resolves to a resource, or one of the two intentionally-unsupported prefixes", () => {
    // An unroutable path also falls through to `"unsupported"`, the same result an
    // intentionally-listed prefix gets, so a plain `!== undefined` assertion wouldn't catch a
    // registry row this module forgot to route.
    for (const path of comparableProjectConfigPaths) {
      const resource = pushResourceForPath(path);
      const isIntentionallyUnsupported = PUSH_UNSUPPORTED_PREFIXES.some(
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

describe("planConfigPush", () => {
  it("groups pushable changes by resource, preserving path order", () => {
    const set = changeSet([
      change(["auth", "site_url"], "update"),
      change(["api", "max_rows"], "update"),
      change(["storage", "file_size_limit"], "local_only"),
      change(["db", "settings", "shared_buffers"], "update"),
    ]);
    const plan = planConfigPush(set);
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
    const plan = planConfigPush(changeSet([]));
    for (const resource of PUSH_RESOURCES) {
      expect(plan.changesByResource[resource]).toEqual([]);
    }
  });

  it("excludes remote_only changes from every resource bucket", () => {
    const set = changeSet([change(["auth", "site_url"], "remote_only", undefined, "remote")]);
    const plan = planConfigPush(set);
    expect(plan.changesByResource.auth).toEqual([]);
  });

  it("counts remote_only changes as informational only", () => {
    const plan = planConfigPush(changeSet([], 12));
    expect(plan.remoteOnly).toBe(12);
    expect(plan.unsupported).toEqual([]);
  });

  it("routes an unsupported-prefix pushable change into `unsupported`, not a resource bucket", () => {
    const set = changeSet([
      change(["db", "pooler", "pool_mode"], "update"),
      change(["db", "major_version"], "local_only"),
    ]);
    const plan = planConfigPush(set);
    expect(plan.unsupported).toEqual([
      ["db", "pooler", "pool_mode"],
      ["db", "major_version"],
    ]);
    expect(plan.changesByResource["db.settings"]).toEqual([]);
  });
});

describe("PUSH_UNSUPPORTED_PREFIXES", () => {
  it("names exactly the two unsupported subtrees", () => {
    expect(PUSH_UNSUPPORTED_PREFIXES).toEqual([
      ["db", "major_version"],
      ["db", "pooler"],
    ]);
  });
});

describe("pushResourceEnabled", () => {
  it("is always true for api and db.settings", () => {
    const config = getDefaultCliConfig();
    expect(pushResourceEnabled("api", config, {})).toBe(true);
    expect(pushResourceEnabled("db.settings", config, {})).toBe(true);
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
    expect(pushResourceEnabled("db.network_restrictions", enabled, {})).toBe(true);
    expect(pushResourceEnabled("db.network_restrictions", disabled, {})).toBe(false);
  });

  it("gates db.ssl_enforcement on the local projection's declared presence", () => {
    const config = getDefaultCliConfig();
    const declared: ProjectConfig = { db: { ssl_enforcement: { enabled: true } } };
    expect(pushResourceEnabled("db.ssl_enforcement", config, declared)).toBe(true);
    expect(pushResourceEnabled("db.ssl_enforcement", config, {})).toBe(false);
  });

  it("is always true for auth and storage, regardless of their local enabled toggle (CLI-2314)", () => {
    // `auth.enabled`/`storage.enabled` control only the local GoTrue/Storage Docker service; a
    // resource-wide gate on them would drop a declared hosted change whenever unused locally.
    const base = getDefaultCliConfig();
    const authOff: CliConfig = { ...base, auth: { ...base.auth, enabled: false } };
    const storageOff: CliConfig = { ...base, storage: { ...base.storage, enabled: false } };
    expect(pushResourceEnabled("auth", base, {})).toBe(true);
    expect(pushResourceEnabled("auth", authOff, {})).toBe(true);
    expect(pushResourceEnabled("storage", base, {})).toBe(true);
    expect(pushResourceEnabled("storage", storageOff, {})).toBe(true);
  });
});

describe("PUSH_ADDON_GATES", () => {
  it("names exactly the phone and web_authn MFA addons", () => {
    expect(PUSH_ADDON_GATES).toEqual([
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

describe("pushAddonPromptNeeded", () => {
  it.each(PUSH_ADDON_GATES)("prompts when $costKey's verify_enabled flips to true", (gate) => {
    const changes = [change(gate.verifyPath, "update", true, false)];
    expect(pushAddonPromptNeeded(changes, gate, {})).toBe(true);
  });

  it.each(PUSH_ADDON_GATES)(
    "prompts when only $costKey's enroll_enabled flips to true and verify_enabled is false on the remote",
    (gate) => {
      const changes = [change(gate.enrollPath, "update", true, false)];
      expect(pushAddonPromptNeeded(changes, gate, {})).toBe(true);
    },
  );

  it.each(PUSH_ADDON_GATES)(
    "does not prompt when $costKey's enroll_enabled flips to true but verify_enabled is already true on the remote",
    (gate) => {
      const changes = [change(gate.enrollPath, "update", true, false)];
      const remote = remoteWithVerifyEnabled(gate, true);
      expect(pushAddonPromptNeeded(changes, gate, remote)).toBe(false);
    },
  );

  it.each(PUSH_ADDON_GATES)("does not prompt when neither $costKey flag is turning on", (gate) => {
    const changes = [change(gate.verifyPath, "update", false, false)];
    expect(pushAddonPromptNeeded(changes, gate, {})).toBe(false);
  });

  it.each(PUSH_ADDON_GATES)(
    "does not prompt when $costKey's verify_enabled flips to true but the remote already has it on",
    (gate) => {
      const changes = [change(gate.verifyPath, "update", true, true)];
      const remote = remoteWithVerifyEnabled(gate, true);
      expect(pushAddonPromptNeeded(changes, gate, remote)).toBe(false);
    },
  );
});

describe("changesCommunicated", () => {
  it("narrows the routed change list to the paths a body actually communicated", () => {
    const changes = [
      change(["auth", "site_url"], "update"),
      change(["auth", "jwt_expiry"], "update"),
    ];
    const communicated = changesCommunicated(changes, [["auth", "site_url"]]);
    expect(communicated.map((c) => c.path)).toEqual([["auth", "site_url"]]);
  });

  it("returns an empty array when nothing was communicated", () => {
    expect(changesCommunicated([change(["auth", "site_url"], "update")], [])).toEqual([]);
  });
});

describe("applyMfaAddonDecline", () => {
  const gate = PUSH_ADDON_GATES[0];
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
    const result = applyMfaAddonDecline(changes, gate, remote);
    expect(result.map((c) => c.path)).toEqual([["auth", "site_url"]]);
  });

  it("drops the addon's changes outright when the remote has neither flag declared", () => {
    const changes = [change(gate.verifyPath, "update", true, undefined)];
    const result = applyMfaAddonDecline(changes, gate, {});
    expect(result).toEqual([]);
  });

  it("replaces the addon's changes with explicit falses when the remote currently has verify_enabled true", () => {
    const changes = [
      change(["auth", "site_url"], "update"),
      change(gate.verifyPath, "update", true, true),
    ];
    const remote: ProjectConfig = { auth: { mfa: { phone: { verify_enabled: true } } } };
    const result = applyMfaAddonDecline(changes, gate, remote);
    expect(result).toEqual([
      change(["auth", "site_url"], "update"),
      { path: gate.verifyPath, class: "update", local: false, remote: true, declared: true },
      { path: gate.enrollPath, class: "update", local: false, remote: undefined, declared: true },
    ]);
  });

  it("replaces the addon's changes with explicit falses when the remote currently has enroll_enabled true", () => {
    const changes = [change(gate.enrollPath, "update", true, true)];
    const remote: ProjectConfig = { auth: { mfa: { phone: { enroll_enabled: true } } } };
    const result = applyMfaAddonDecline(changes, gate, remote);
    expect(result).toEqual([
      { path: gate.verifyPath, class: "update", local: false, remote: undefined, declared: true },
      { path: gate.enrollPath, class: "update", local: false, remote: true, declared: true },
    ]);
  });
});
