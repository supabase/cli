import { describe, expect, it } from "vitest";

import {
  applyRemoteNetworkRestrictions,
  dbSettingsToUpdateBody,
  diffDbSettingsWithRemote,
  diffNetworkRestrictionsWithRemote,
  diffSslEnforcementWithRemote,
  networkRestrictionsToUpdateBody,
  sslEnforcementToUpdateBody,
  type NetworkRestrictionsSubset,
} from "./db.sync.ts";

const lines = (...l: Array<string>) => l.join("\n") + "\n";

/**
 * Golden parity with Go `pkg/config/db_test.go`. Settings diffs are the exact
 * bytes of `pkg/config/testdata/TestDbSettingsDiff/*.diff`; network restrictions
 * and ssl diffs were captured from the Go functions directly (no committed
 * snapshot).
 */
describe("diffDbSettingsWithRemote", () => {
  const local = { effective_cache_size: "4GB", max_connections: 100, shared_buffers: "1GB" };

  it("detects differences", () => {
    expect(
      diffDbSettingsWithRemote(local, {
        effective_cache_size: "8GB",
        max_connections: 200,
        shared_buffers: "2GB",
      }),
    ).toBe(
      lines(
        "diff remote[db.settings] local[db.settings]",
        "--- remote[db.settings]",
        "+++ local[db.settings]",
        "@@ -1,3 +1,3 @@",
        '-effective_cache_size = "8GB"',
        "-max_connections = 200",
        '-shared_buffers = "2GB"',
        '+effective_cache_size = "4GB"',
        "+max_connections = 100",
        '+shared_buffers = "1GB"',
      ),
    );
  });

  it("handles no differences", () => {
    expect(
      diffDbSettingsWithRemote(local, {
        effective_cache_size: "4GB",
        max_connections: 100,
        shared_buffers: "1GB",
      }),
    ).toBe("");
  });

  it("handles remote all-nil (everything added)", () => {
    expect(diffDbSettingsWithRemote(local, {})).toBe(
      lines(
        "diff remote[db.settings] local[db.settings]",
        "--- remote[db.settings]",
        "+++ local[db.settings]",
        "@@ -0,0 +1,3 @@",
        '+effective_cache_size = "4GB"',
        "+max_connections = 100",
        '+shared_buffers = "1GB"',
      ),
    );
  });

  it("handles local all-nil (everything removed)", () => {
    expect(
      diffDbSettingsWithRemote(
        {},
        { effective_cache_size: "4GB", max_connections: 100, shared_buffers: "1GB" },
      ),
    ).toBe(
      lines(
        "diff remote[db.settings] local[db.settings]",
        "--- remote[db.settings]",
        "+++ local[db.settings]",
        "@@ -1,3 +0,0 @@",
        '-effective_cache_size = "4GB"',
        "-max_connections = 100",
        '-shared_buffers = "1GB"',
      ),
    );
  });
});

describe("dbSettingsToUpdateBody", () => {
  it("includes only set fields", () => {
    const body = dbSettingsToUpdateBody({
      effective_cache_size: "4GB",
      max_connections: 100,
      shared_buffers: "1GB",
      statement_timeout: "30s",
      session_replication_role: "replica",
    });
    expect(body).toEqual({
      effective_cache_size: "4GB",
      max_connections: 100,
      shared_buffers: "1GB",
      statement_timeout: "30s",
      session_replication_role: "replica",
    });
  });

  it("is empty for empty settings", () => {
    expect(dbSettingsToUpdateBody({})).toEqual({});
  });
});

describe("diffNetworkRestrictionsWithRemote", () => {
  const local: NetworkRestrictionsSubset = {
    enabled: true,
    allowed_cidrs: ["192.168.1.0/24"],
    allowed_cidrs_v6: ["2001:db8::/32"],
  };

  it("detects differences", () => {
    expect(
      diffNetworkRestrictionsWithRemote(local, {
        config: { dbAllowedCidrs: ["10.0.0.0/8"], dbAllowedCidrsV6: ["fd00::/8"] },
      }),
    ).toBe(
      lines(
        "diff remote[db.network_restrictions] local[db.network_restrictions]",
        "--- remote[db.network_restrictions]",
        "+++ local[db.network_restrictions]",
        "@@ -1,3 +1,3 @@",
        " enabled = true",
        '-allowed_cidrs = ["10.0.0.0/8"]',
        '-allowed_cidrs_v6 = ["fd00::/8"]',
        '+allowed_cidrs = ["192.168.1.0/24"]',
        '+allowed_cidrs_v6 = ["2001:db8::/32"]',
      ),
    );
  });

  it("disallow-all local vs allow-all remote", () => {
    expect(
      diffNetworkRestrictionsWithRemote(
        { enabled: true, allowed_cidrs: [], allowed_cidrs_v6: [] },
        { config: { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] } },
      ),
    ).toBe(
      lines(
        "diff remote[db.network_restrictions] local[db.network_restrictions]",
        "--- remote[db.network_restrictions]",
        "+++ local[db.network_restrictions]",
        "@@ -1,3 +1,3 @@",
        " enabled = true",
        '-allowed_cidrs = ["0.0.0.0/0"]',
        '-allowed_cidrs_v6 = ["::/0"]',
        "+allowed_cidrs = []",
        "+allowed_cidrs_v6 = []",
      ),
    );
  });

  it("locally disabled produces no diff", () => {
    expect(
      diffNetworkRestrictionsWithRemote(
        { enabled: false, allowed_cidrs: [], allowed_cidrs_v6: [] },
        { config: { dbAllowedCidrs: ["0.0.0.0/0"], dbAllowedCidrsV6: ["::/0"] } },
      ),
    ).toBe("");
  });

  it("keeps local cidrs when remote omits them", () => {
    expect(applyRemoteNetworkRestrictions(local, { config: {} })).toEqual(local);
  });

  it("builds the apply body", () => {
    expect(networkRestrictionsToUpdateBody(local)).toEqual({
      dbAllowedCidrs: ["192.168.1.0/24"],
      dbAllowedCidrsV6: ["2001:db8::/32"],
    });
  });
});

describe("diffSslEnforcementWithRemote", () => {
  it("detects a difference", () => {
    expect(
      diffSslEnforcementWithRemote({ enabled: true }, { currentConfig: { database: false } }),
    ).toBe(
      lines(
        "diff remote[db.ssl_enforcement] local[db.ssl_enforcement]",
        "--- remote[db.ssl_enforcement]",
        "+++ local[db.ssl_enforcement]",
        "@@ -1,1 +1,1 @@",
        "-enabled = false",
        "+enabled = true",
      ),
    );
  });

  it("builds the update body", () => {
    expect(sslEnforcementToUpdateBody({ enabled: true })).toEqual({
      requestedConfig: { database: true },
    });
  });
});
