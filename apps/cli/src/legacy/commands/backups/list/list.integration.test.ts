import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type V1ListAllBackupsOutput } from "@supabase/api/effect";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";

import { withJsonErrorHandling } from "../../../../shared/output/json-error-handling.ts";
import { mockOutput } from "../../../../../tests/helpers/mocks.ts";
import {
  LEGACY_VALID_REF,
  buildLegacyTestRuntime,
  mockLegacyCliConfig,
  mockLegacyPlatformApi,
  useLegacyTempWorkdir,
} from "../../../../../tests/helpers/legacy-mocks.ts";
import { legacyBackupsList } from "./list.handler.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PITR_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [],
  physical_backup_data: {},
};

const LOGICAL_RESPONSE: typeof V1ListAllBackupsOutput.Type = {
  region: "ap-southeast-1",
  walg_enabled: true,
  pitr_enabled: true,
  backups: [
    {
      id: 1,
      is_physical_backup: true,
      status: "COMPLETED",
      inserted_at: "2026-02-08T16:44:07Z",
    },
  ],
  physical_backup_data: {},
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

interface SetupOpts {
  format?: "text" | "json" | "stream-json";
  goOutput?: "env" | "pretty" | "json" | "toml" | "yaml";
  response?: typeof V1ListAllBackupsOutput.Type;
  status?: number;
  network?: "fail";
  apiUrl?: string;
  userAgent?: string;
}

const tempRoot = useLegacyTempWorkdir("supabase-backups-list-int-");

function setup(opts: SetupOpts = {}) {
  const out = mockOutput({ format: opts.format ?? "text" });
  const api = mockLegacyPlatformApi({
    response: { status: opts.status ?? 200, body: opts.response ?? PITR_RESPONSE },
    network: opts.network,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const cliConfig = mockLegacyCliConfig({
    workdir: tempRoot.current,
    apiUrl: opts.apiUrl,
    userAgent: opts.userAgent,
  });
  const layer = buildLegacyTestRuntime({
    out,
    api,
    cliConfig,
    goOutput: opts.goOutput === undefined ? Option.none() : Option.some(opts.goOutput),
  });
  return { layer, out, api };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("legacy backups list integration", () => {
  it.live("renders a PITR-only table when no physical backups exist", () => {
    const { layer, out } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("REGION");
      expect(out.stdoutText).toContain("WALG");
      expect(out.stdoutText).toContain("PITR");
      expect(out.stdoutText).toContain("EARLIEST TIMESTAMP");
      expect(out.stdoutText).toContain("LATEST TIMESTAMP");
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
      expect(out.stdoutText).toContain("| true ");
    }).pipe(Effect.provide(layer));
  });

  it.live("renders a logical backups table with PHYSICAL classification", () => {
    const { layer, out } = setup({ response: LOGICAL_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("BACKUP TYPE");
      expect(out.stdoutText).toContain("PHYSICAL");
      expect(out.stdoutText).toContain("COMPLETED");
      expect(out.stdoutText).toContain("2026-02-08 16:44:07");
    }).pipe(Effect.provide(layer));
  });

  it.live("translates ap-southeast-1 to Southeast Asia (Singapore)", () => {
    const { layer, out } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a JSON success event when --output-format=json", () => {
    const { layer, out } = setup({ format: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1", walg_enabled: true });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a result event for --output-format=stream-json", () => {
    const { layer, out } = setup({ format: "stream-json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      const success = out.messages.find((m) => m.type === "success");
      expect(success).toBeDefined();
      expect(success?.data).toMatchObject({ region: "ap-southeast-1" });
    }).pipe(Effect.provide(layer));
  });

  it.live("emits indented JSON to stdout for --output json (Go-compat)", () => {
    const { layer, out } = setup({ goOutput: "json", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      // Byte-identical to Go's `encoding/json` output: alphabetical struct-field order,
      // and a nil Backups slice serializes as `null` (matches
      // `apps/cli-go/internal/backups/list/list_test.go` fixture).
      expect(out.stdoutText).toBe(
        `{
  "backups": null,
  "physical_backup_data": {},
  "pitr_enabled": true,
  "region": "ap-southeast-1",
  "walg_enabled": true
}
`,
      );
    }).pipe(Effect.provide(layer));
  });

  it.live("emits YAML to stdout for --output yaml", () => {
    const { layer, out } = setup({ goOutput: "yaml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("region: ap-southeast-1");
      expect(out.stdoutText).toContain("walg_enabled: true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits TOML to stdout for --output toml", () => {
    const { layer, out } = setup({ goOutput: "toml", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('region = "ap-southeast-1"');
      expect(out.stdoutText).toContain("walg_enabled = true");
    }).pipe(Effect.provide(layer));
  });

  it.live("emits KEY=VALUE lines for --output env", () => {
    const { layer, out } = setup({ goOutput: "env", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain('REGION="ap-southeast-1"');
      expect(out.stdoutText).toContain('WALG_ENABLED="true"');
    }).pipe(Effect.provide(layer));
  });

  it.live("treats --output pretty as identical to text mode (Glamour table)", () => {
    const { layer, out } = setup({ goOutput: "pretty", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("Southeast Asia (Singapore)");
    }).pipe(Effect.provide(layer));
  });

  it.live("--output flag value wins over --output-format when both provided", () => {
    const { layer, out } = setup({
      format: "json",
      goOutput: "yaml",
      response: PITR_RESPONSE,
    });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(out.stdoutText).toContain("region: ap-southeast-1");
      expect(out.stdoutText.startsWith("{")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.live("passes the resolved project ref into the listAllBackups URL", () => {
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(api.requests).toHaveLength(1);
      expect(api.requests[0]?.url).toContain(`/v1/projects/${LEGACY_VALID_REF}/database/backups`);
    }).pipe(Effect.provide(layer));
  });

  it.live("uses --project-ref flag value over LegacyCliConfig.projectId env", () => {
    const flagRef = "zzzzzzzzzzzzzzzzzzzz";
    const { layer, api } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.some(flagRef) });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${flagRef}/`);
    }).pipe(Effect.provide(layer));
  });

  it.live("reads supabase/.temp/project-ref when env and flag are unset", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-list-int-fileref-"));
    const fileRef = "filerefabcdefghijklm";
    mkdirSync(join(localTempRoot, "supabase", ".temp"), { recursive: true });
    writeFileSync(join(localTempRoot, "supabase", ".temp", "project-ref"), fileRef);

    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: PITR_RESPONSE } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() });
      expect(api.requests[0]?.url).toContain(`/v1/projects/${fileRef}/`);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyProjectNotLinkedError when no ref source matches off-TTY", () => {
    const localTempRoot = mkdtempSync(join(tmpdir(), "supabase-backups-list-int-no-ref-"));
    const out = mockOutput({ format: "text" });
    const api = mockLegacyPlatformApi({ response: { status: 200, body: PITR_RESPONSE } });
    const cliConfig = mockLegacyCliConfig({
      workdir: localTempRoot,
      projectId: Option.none(),
    });
    const layer = buildLegacyTestRuntime({ out, api, cliConfig });

    return Effect.gen(function* () {
      const exit = yield* Effect.exit(
        legacyBackupsList({ projectRef: Option.none() }).pipe(Effect.provide(layer)),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyProjectNotLinkedError");
      }
    }).pipe(
      Effect.ensuring(Effect.sync(() => rmSync(localTempRoot, { recursive: true, force: true }))),
    );
  });

  it.live("fails with LegacyInvalidProjectRefError when the resolved ref is malformed", () => {
    const { layer } = setup({ response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.some("BADREF") }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(JSON.stringify(exit.cause)).toContain("LegacyInvalidProjectRefError");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupListUnexpectedStatusError on HTTP 503", () => {
    const { layer } = setup({ status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupListUnexpectedStatusError");
        expect(errorJson).toContain("unexpected list backup status 503");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("fails with LegacyBackupListNetworkError on transport failure", () => {
    const { layer } = setup({ network: "fail", response: PITR_RESPONSE });
    return Effect.gen(function* () {
      const exit = yield* Effect.exit(legacyBackupsList({ projectRef: Option.none() }));
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const errorJson = JSON.stringify(exit.cause);
        expect(errorJson).toContain("LegacyBackupListNetworkError");
        expect(errorJson).toContain("failed to list physical backups");
      }
    }).pipe(Effect.provide(layer));
  });

  it.live("emits a fail event when withJsonErrorHandling wraps a JSON-mode error", () => {
    const { layer, out } = setup({ format: "json", status: 503, response: PITR_RESPONSE });
    return Effect.gen(function* () {
      yield* legacyBackupsList({ projectRef: Option.none() }).pipe(withJsonErrorHandling);
      expect(out.messages.some((m) => m.type === "fail")).toBe(true);
    }).pipe(Effect.provide(layer));
  });

  it.live(
    "sends User-Agent SupabaseCLI/<version> and no X-Supabase-Command headers (Go parity)",
    () => {
      const { layer, api } = setup({
        response: PITR_RESPONSE,
        userAgent: "SupabaseCLI/1.42.0",
      });
      return Effect.gen(function* () {
        yield* legacyBackupsList({ projectRef: Option.none() });
        const headers = api.requests[0]?.headers;
        expect(headers?.["user-agent"]).toBe("SupabaseCLI/1.42.0");
        expect(headers?.["x-supabase-command"]).toBeUndefined();
        expect(headers?.["x-supabase-command-run-id"]).toBeUndefined();
      }).pipe(Effect.provide(layer));
    },
  );
});
