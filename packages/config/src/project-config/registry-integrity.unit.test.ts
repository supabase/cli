import { describe, expect, test } from "vitest";
import { CliConfigSchema } from "../base.ts";
import { ProjectConfigApiAttributesSchema } from "./api-attributes.ts";
import {
  DISABLED_SENTINEL_ENTRY_SWEEPS,
  DISABLED_SENTINEL_PRUNES,
  dualScopeProjectConfigPaths,
  SMS_PROVIDER_PUSH_PRECEDENCE,
} from "./project-config.ts";
import { unmappedSecretApiPaths } from "./registry-auth.ts";
import { projectConfigMappingRows } from "./registry.ts";

/**
 * Standing AST-walk drift guard (CLI-2230): every row's `configPath` must
 * resolve against {@link CliConfigSchema}'s AST, and every row's `apiPath`
 * (plus `alsoConsumes` and `./registry-auth.ts`'s `unmappedSecretApiPaths`)
 * must resolve against {@link ProjectConfigApiAttributesSchema}'s AST. This
 * is what keeps the 243 rows across `./registry.ts`/`./registry-auth.ts`
 * true when either schema moves — a renamed or removed field fails a test
 * here instead of silently producing a `ProjectConfig` that never populates
 * (a wrong `configPath`) or a row that never reads a real API field (a
 * wrong `apiPath`).
 *
 * The walker below mirrors `../lib/env.ts`'s `descendAst`/`../lib/
 * secret-paths.ts`'s `collectSecretPathPatterns`: Effect v4 represents both
 * `Schema.Struct` and `Schema.Record` as an `"Objects"` AST node
 * (`.repos/effect/packages/effect/src/SchemaAST.ts:2038-2090`), carrying
 * named `propertySignatures` (struct fields) and/or `indexSignatures`
 * (record key patterns) side by side on the same node type. Descending a
 * path segment therefore tries an exact-name property signature first, then
 * falls back to the first index signature's value type — the record
 * fallback is what "the auth record accepts any second segment" means for
 * `ProjectConfigApiAttributesSchema`'s `auth: Schema.Record(Schema.String,
 * Schema.Json)` field: every row's two-segment `["auth", "<gotrue_key>"]`
 * `apiPath` resolves through that index signature, not a named property.
 *
 * That same open-`Record` shape makes this file's `apiPath` check
 * structurally vacuous for all 189 auth rows: ANY second segment resolves
 * through the record's index signature, whether or not GoTrue actually has a
 * key by that name, so this walker cannot catch a renamed or invented
 * GoTrue key the way it catches a real `configPath`/`CliConfigSchema`
 * mismatch. The real check for the auth half of the registry — every row's
 * `apiPath` against the generated Management API v1 auth-config contract's
 * actual key set — lives in
 * `apps/cli/src/shared/config/project-config-auth-contract.unit.test.ts`,
 * since `packages/config` cannot depend on `packages/api`'s generated
 * client.
 */

interface AstNode {
  readonly _tag?: string;
  readonly propertySignatures?: ReadonlyArray<{
    readonly name: PropertyKey;
    readonly type: unknown;
  }>;
  readonly indexSignatures?: ReadonlyArray<{ readonly type: unknown }>;
  readonly types?: ReadonlyArray<unknown>;
  readonly thunk?: () => unknown;
}

/** Unwraps a `Suspend` (lazy AST reference from a recursive schema) down to its concrete node. */
function unwrapSuspend(node: unknown): AstNode | undefined {
  let current = node as AstNode | undefined;
  while (
    current !== undefined &&
    current._tag === "Suspend" &&
    typeof current.thunk === "function"
  ) {
    current = current.thunk() as AstNode;
  }
  return current;
}

/** Descends one path `segment` from `node`, trying every `Union` branch in order, then property signatures, then the first index signature. */
function descendOneSegment(node: unknown, segment: string): unknown {
  const ast = unwrapSuspend(node);
  if (ast === undefined) {
    return undefined;
  }
  if (ast._tag === "Union" && ast.types !== undefined) {
    for (const variant of ast.types) {
      const next = descendOneSegment(variant, segment);
      if (next !== undefined) {
        return next;
      }
    }
    return undefined;
  }
  const property = ast.propertySignatures?.find((candidate) => candidate.name === segment);
  if (property !== undefined) {
    return property.type;
  }
  if (ast.indexSignatures !== undefined && ast.indexSignatures.length > 0) {
    return ast.indexSignatures[0]?.type;
  }
  return undefined;
}

/** Whether every segment of `path` resolves, in order, starting from `rootAst`. */
function pathResolves(rootAst: unknown, path: ReadonlyArray<string>): boolean {
  let current: unknown = rootAst;
  for (const segment of path) {
    current = descendOneSegment(current, segment);
    if (current === undefined) {
      return false;
    }
  }
  return true;
}

/**
 * The named property-signature keys directly under `path` from `rootAst` —
 * empty if `path` doesn't resolve at all, or resolves to a node with no named
 * signatures (e.g. a bare `Schema.Record`). Used for the entry-sweep tables
 * below, whose `entryKeys` is sometimes omitted (the sweep walks
 * `Object.keys(container)` at runtime instead) — reading the schema's own
 * property names is the only way to still assert something concrete about
 * which entries that sweep can ever see.
 */
function structPropertyNames(rootAst: unknown, path: ReadonlyArray<string>): ReadonlyArray<string> {
  let current: unknown = rootAst;
  for (const segment of path) {
    current = descendOneSegment(current, segment);
    if (current === undefined) {
      return [];
    }
  }
  const ast = unwrapSuspend(current);
  return ast?.propertySignatures?.map((signature) => String(signature.name)) ?? [];
}

describe("registry integrity: every row resolves against both schemas", () => {
  test("the registry actually has rows to check", () => {
    // Guards against the loop below passing vacuously if the registry import
    // is ever broken.
    expect(projectConfigMappingRows.length).toBeGreaterThan(100);
  });

  for (const row of projectConfigMappingRows) {
    const configPathLabel = row.configPath.join(".");
    const apiPathLabel = row.apiPath.join(".");

    test(`configPath "${configPathLabel}" resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, row.configPath)).toBe(true);
    });

    test(`apiPath "${apiPathLabel}" (for configPath "${configPathLabel}") resolves against ProjectConfigApiAttributesSchema`, () => {
      expect(pathResolves(ProjectConfigApiAttributesSchema.ast, row.apiPath)).toBe(true);
    });

    for (const alsoPath of row.alsoConsumes ?? []) {
      test(`alsoConsumes path "${alsoPath.join(".")}" (for configPath "${configPathLabel}") resolves against ProjectConfigApiAttributesSchema`, () => {
        expect(pathResolves(ProjectConfigApiAttributesSchema.ast, alsoPath)).toBe(true);
      });
    }
  }

  for (const secretPath of unmappedSecretApiPaths) {
    test(`unmappedSecretApiPaths entry "${secretPath.join(".")}" resolves against ProjectConfigApiAttributesSchema`, () => {
      expect(pathResolves(ProjectConfigApiAttributesSchema.ast, secretPath)).toBe(true);
    });
  }
});

/**
 * Standing AST-walk drift guard for the three hand-written disabled-sentinel
 * tables in `./project-config.ts` (`DISABLED_SENTINEL_PRUNES`,
 * `DISABLED_SENTINEL_ENTRY_SWEEPS`, `SMS_PROVIDER_PUSH_PRECEDENCE`): these
 * tables were added after the registry-integrity walker above and carry no
 * AST guard of their own — a renamed `CliConfigSchema` field would silently
 * turn one of their rules into a no-op (the gating `enabled` check, a dropped
 * sibling, or an entry sweep simply never firing again for that field) with
 * no red test anywhere to catch it.
 */
describe("disabled-sentinel tables: every path/key resolves against CliConfigSchema", () => {
  test("DISABLED_SENTINEL_PRUNES actually has rows to check", () => {
    // Guards against the loop below passing vacuously if the table is ever
    // emptied out.
    expect(DISABLED_SENTINEL_PRUNES.length).toBeGreaterThan(5);
  });

  for (const rule of DISABLED_SENTINEL_PRUNES) {
    const containerLabel = rule.containerPath.join(".");

    test(`DISABLED_SENTINEL_PRUNES containerPath "${containerLabel}" resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, rule.containerPath)).toBe(true);
    });

    test(`DISABLED_SENTINEL_PRUNES containerPath "${containerLabel}"'s gating "enabled" flag resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, [...rule.containerPath, "enabled"])).toBe(true);
    });

    for (const dropKey of rule.dropKeys ?? []) {
      test(`DISABLED_SENTINEL_PRUNES containerPath "${containerLabel}"'s dropKey "${dropKey}" resolves against CliConfigSchema`, () => {
        expect(pathResolves(CliConfigSchema.ast, [...rule.containerPath, dropKey])).toBe(true);
      });
    }
  }

  test("DISABLED_SENTINEL_ENTRY_SWEEPS actually has rows to check", () => {
    expect(DISABLED_SENTINEL_ENTRY_SWEEPS.length).toBeGreaterThan(1);
  });

  for (const sweep of DISABLED_SENTINEL_ENTRY_SWEEPS) {
    const containerLabel = sweep.containerPath.join(".");

    test(`DISABLED_SENTINEL_ENTRY_SWEEPS containerPath "${containerLabel}" resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, sweep.containerPath)).toBe(true);
    });

    // A row without `entryKeys` sweeps `Object.keys(container)` at runtime —
    // fall back to the schema's own property names so this guard still
    // catches an "enabled" rename on any concrete entry the container can
    // ever hold.
    const entryKeys =
      sweep.entryKeys ?? structPropertyNames(CliConfigSchema.ast, sweep.containerPath);

    test(`DISABLED_SENTINEL_ENTRY_SWEEPS containerPath "${containerLabel}" has at least one entry key to sweep`, () => {
      expect(entryKeys.length).toBeGreaterThan(0);
    });

    for (const entryKey of entryKeys) {
      test(`DISABLED_SENTINEL_ENTRY_SWEEPS containerPath "${containerLabel}"'s entry "${entryKey}" gating "enabled" flag resolves against CliConfigSchema`, () => {
        expect(
          pathResolves(CliConfigSchema.ast, [...sweep.containerPath, entryKey, "enabled"]),
        ).toBe(true);
      });
    }
  }
});

/**
 * `SMS_PROVIDER_PUSH_PRECEDENCE` doubles as data (every entry must resolve as
 * a real `auth.sms` provider) and as a pinned ORDER (it must keep matching
 * the legacy push switch's fixed provider priority, since a reordering here
 * would silently change which provider `fromConfigDocument` treats as "the"
 * enabled one when a document enables more than one).
 */
describe("SMS_PROVIDER_PUSH_PRECEDENCE: every provider resolves and matches the legacy push order", () => {
  test("SMS_PROVIDER_PUSH_PRECEDENCE actually has rows to check", () => {
    expect(SMS_PROVIDER_PUSH_PRECEDENCE.length).toBeGreaterThan(1);
  });

  for (const provider of SMS_PROVIDER_PUSH_PRECEDENCE) {
    test(`SMS_PROVIDER_PUSH_PRECEDENCE entry "${provider}" resolves as a key under auth.sms against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, ["auth", "sms", provider])).toBe(true);
    });

    test(`SMS_PROVIDER_PUSH_PRECEDENCE entry "${provider}"'s gating "enabled" flag resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, ["auth", "sms", provider, "enabled"])).toBe(true);
    });
  }

  // Pinned against a hardcoded copy of the legacy switch's order (cited
  // below) — this test file cannot itself see auth.sync.ts. The FIRST
  // enabled provider wins and every later one is skipped entirely
  // (apps/cli/src/legacy/commands/config/push/config-sync/auth.sync.ts:2498-2539's
  // `switch (true)`: twilio (case at :2499), twilio_verify (:2507),
  // messagebird (:2515), textlocal (:2522), vonage (:2529), default (:2537-2539)).
  test("order matches the legacy push switch's fixed provider priority", () => {
    expect(SMS_PROVIDER_PUSH_PRECEDENCE).toEqual([
      "twilio",
      "twilio_verify",
      "messagebird",
      "textlocal",
      "vonage",
    ]);
  });
});

/**
 * `dualScope` (CLI-2064): every flagged row's `configPath` resolves against
 * `CliConfigSchema` (already exercised generically by the main loop above,
 * since every `dualScope` row is a member of `projectConfigMappingRows` —
 * asserted again here against the narrower subset so this describe block
 * stands on its own) and the exact dual-scope path SET is pinned by an inline
 * snapshot: adding (or removing) a `dualScope` flag anywhere in the registry
 * must be a deliberate, reviewed act, not a silent side effect of an
 * unrelated row edit.
 */
describe("dualScope rows: configPath resolves against CliConfigSchema and the path list is pinned", () => {
  const dualScopeRows = projectConfigMappingRows.filter((row) => row.dualScope === true);

  test("dualScope rows actually exist to check", () => {
    // Guards against the loop below passing vacuously if every `dualScope`
    // flag is ever accidentally removed from the registry.
    expect(dualScopeRows.length).toBeGreaterThan(0);
  });

  for (const row of dualScopeRows) {
    const configPathLabel = row.configPath.join(".");

    test(`dualScope row configPath "${configPathLabel}" resolves against CliConfigSchema`, () => {
      expect(pathResolves(CliConfigSchema.ast, row.configPath)).toBe(true);
    });
  }

  test("dualScopeProjectConfigPaths is pinned", () => {
    expect(dualScopeProjectConfigPaths.map((path) => path.join("."))).toMatchInlineSnapshot(`
      [
        "db.major_version",
        "db.settings.effective_cache_size",
        "db.settings.logical_decoding_work_mem",
        "db.settings.maintenance_work_mem",
        "db.settings.max_slot_wal_keep_size",
        "db.settings.max_standby_archive_delay",
        "db.settings.max_standby_streaming_delay",
        "db.settings.max_wal_size",
        "db.settings.shared_buffers",
        "db.settings.statement_timeout",
        "db.settings.track_activity_query_size",
        "db.settings.wal_keep_size",
        "db.settings.wal_sender_timeout",
        "db.settings.work_mem",
        "db.settings.session_replication_role",
        "db.settings.track_commit_timestamp",
        "db.settings.max_connections",
        "db.settings.max_locks_per_transaction",
        "db.settings.max_parallel_maintenance_workers",
        "db.settings.max_parallel_workers",
        "db.settings.max_parallel_workers_per_gather",
        "db.settings.max_replication_slots",
        "db.settings.max_wal_senders",
        "db.settings.max_worker_processes",
        "db.pooler.pool_mode",
        "db.pooler.default_pool_size",
        "db.pooler.max_client_conn",
        "auth.site_url",
        "auth.additional_redirect_urls",
        "auth.email.smtp.host",
        "auth.email.smtp.port",
        "auth.email.smtp.user",
        "auth.email.smtp.admin_email",
        "auth.email.smtp.sender_name",
        "auth.captcha.provider",
        "auth.sms.test_otp",
      ]
    `);
  });
});
