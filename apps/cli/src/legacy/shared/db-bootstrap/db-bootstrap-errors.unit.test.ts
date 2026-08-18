import { describe, expect, it } from "vitest";

import { classifyCliErrorActionability } from "../../../shared/telemetry/error-actionability.ts";
import {
  LegacyContainerCreateError,
  LegacyContainerStartError,
  LegacyNetworkCreateError,
} from "./container-lifecycle.ts";
import { LegacyDbSetupError } from "./db-setup.ts";
import { LegacyImagePrepullError } from "./image-prepull.ts";
import { LegacyLocalDbRunningError } from "./local-db-running.ts";
import { LegacyResetReplicationSlotsError } from "./recreate-local-database.ts";

const classify = (error: unknown) => classifyCliErrorActionability(error);

describe("db bootstrap error actionability discriminants", () => {
  it("distinguishes container-runtime, configuration, internal, and port failures", () => {
    expect(
      classify(new LegacyNetworkCreateError({ message: "ignored", reason: "runtime" })),
    ).toMatchObject({ error_category: "docker_not_running" });
    expect(
      classify(new LegacyNetworkCreateError({ message: "ignored", reason: "configuration" })),
    ).toMatchObject({ error_category: "invalid_config" });
    expect(
      classify(new LegacyContainerCreateError({ message: "ignored", reason: "internal" })),
    ).toMatchObject({ error_kind: "internal_bug", error_category: "panic" });
    expect(
      classify(new LegacyContainerStartError({ message: "ignored", reason: "port_conflict" })),
    ).toMatchObject({
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyContainerStartError:port_conflict",
    });
  });

  it("keeps database setup causes in separate KPI families", () => {
    expect(
      classify(new LegacyDbSetupError({ message: "ignored", reason: "database" })),
    ).toMatchObject({ error_category: "invalid_config" });
    expect(
      classify(new LegacyDbSetupError({ message: "ignored", reason: "filesystem" })),
    ).toMatchObject({ error_category: "permission" });
    expect(
      classify(new LegacyDbSetupError({ message: "ignored", reason: "docker_daemon" })),
    ).toMatchObject({ error_category: "docker_not_running" });
    expect(
      classify(new LegacyDbSetupError({ message: "ignored", reason: "registry_pull" })),
    ).toMatchObject({ error_kind: "external_service", error_category: "network" });
    expect(
      classify(new LegacyDbSetupError({ message: "ignored", reason: "image_inspect" })),
    ).toMatchObject({ error_category: "invalid_config" });
  });

  it("distinguishes an active replication slot from a failed slot query", () => {
    expect(
      classify(new LegacyResetReplicationSlotsError({ message: "ignored", retryable: true })),
    ).toMatchObject({
      error_category: "invalid_config",
      error_fingerprint: "tag:LegacyResetReplicationSlotsError:replication_slots_active",
    });
    expect(
      classify(new LegacyResetReplicationSlotsError({ message: "ignored", retryable: false })),
    ).toMatchObject({
      error_category: "db_connection",
      error_fingerprint: "tag:LegacyResetReplicationSlotsError:replication_slots_query",
    });
  });

  it("distinguishes an unavailable daemon from another local DB inspect failure", () => {
    expect(
      classify(new LegacyLocalDbRunningError({ message: "ignored", daemonDown: true })),
    ).toMatchObject({ error_category: "docker_not_running" });
    expect(classify(new LegacyLocalDbRunningError({ message: "ignored" }))).toMatchObject({
      error_category: "invalid_config",
      suggested_command: "supabase start",
    });
  });

  it("distinguishes daemon, registry, and image-inspection prepull failures", () => {
    expect(
      classify(new LegacyImagePrepullError({ message: "ignored", reason: "docker_daemon" })),
    ).toMatchObject({ error_category: "docker_not_running" });
    expect(
      classify(new LegacyImagePrepullError({ message: "ignored", reason: "registry_pull" })),
    ).toMatchObject({ error_kind: "external_service", error_category: "network" });
    expect(
      classify(new LegacyImagePrepullError({ message: "ignored", reason: "image_inspect" })),
    ).toMatchObject({ error_category: "invalid_config" });
  });
});
