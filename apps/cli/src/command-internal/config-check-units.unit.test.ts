import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { CliConfigSchema, type CliConfig } from "@supabase/config";
import { cliConfigSmtpIssues, decodeCliConfigWithoutTableRules } from "@supabase/config/internal";
import { Effect, Result, Schema } from "effect";

import { authSignedKeys, DB_SIGNING_KEYS_UNIT } from "./config-check-auth-units.ts";
import {
  makeCliConfigUnitIo,
  runConfigUnitsFirst,
  untrackedCliConfigView,
  type CliConfigCheckUnit,
  type CountingCliConfigView,
  type Segments,
} from "./config-check-core.ts";
import { DB_CHECK_ORDER, LOCAL_CHECK_ORDER } from "./config-check-units.ts";
import { VALIDATE_ONLY_UNITS } from "../commands/config/validate/validate.units.ts";
import {
  listAuthExternalProviderNames,
  resolveAuthExternalProviders,
} from "./local-config-values.ts";

const decodeConfig = Schema.decodeUnknownSync(CliConfigSchema);
const WORKDIR = "/tmp/config-check-units-test";

type Doc = Readonly<Record<string, unknown>>;

const firstMessage = (
  units: ReadonlyArray<CliConfigCheckUnit>,
  overrides: Record<string, unknown>,
  document?: Doc,
) =>
  Effect.gen(function* () {
    const config = decodeConfig({ project_id: "test", ...overrides });
    const io = yield* makeCliConfigUnitIo("local");
    const result = yield* Effect.result(
      runConfigUnitsFirst(
        units,
        untrackedCliConfigView({ config, document, workdir: WORKDIR }),
        io,
      ),
    );
    return Result.isFailure(result) ? result.failure.message : undefined;
  }).pipe(Effect.provide(BunServices.layer));

const auth = (extra: Record<string, unknown>) => ({
  auth: { enabled: true, site_url: "http://localhost:3000", ...extra },
});

interface Case {
  readonly name: string;
  readonly overrides: Record<string, unknown>;
  readonly document?: Doc;
  readonly message: string | undefined;
}

const cases: ReadonlyArray<Case> = [
  { name: "a minimal config passes", overrides: {}, message: undefined },
  {
    name: "major_version 0",
    overrides: { db: { major_version: 0 } },
    message: "Missing required field in config: db.major_version",
  },
  {
    name: "major_version 12",
    overrides: { db: { major_version: 12 } },
    message: "Postgres version 12.x is unsupported.",
  },
  {
    name: "major_version 16",
    overrides: { db: { major_version: 16 } },
    message: "Failed reading config: Invalid db.major_version: 16.",
  },
  {
    name: "major_version 15 is supported",
    overrides: { db: { major_version: 15 } },
    message: undefined,
  },
  {
    name: "bucket name",
    overrides: { storage: { buckets: { "bad/name": {} } } },
    message: "Invalid Bucket name: bad/name.",
  },
  {
    name: "bucket file_size_limit 5MB is valid",
    overrides: { storage: { buckets: { avatars: { file_size_limit: "5MB" } } } },
    message: undefined,
  },
  {
    name: "deno_version 3",
    overrides: { edge_runtime: { deno_version: 3 } },
    message: "Invalid edge_runtime.deno_version: 3.",
  },
  {
    name: "function slug",
    overrides: { functions: { "1bad": {} } },
    message: "Invalid Function name: 1bad.",
  },
  {
    name: "bigquery without gcp_project_id",
    overrides: {
      analytics: { enabled: true, backend: "bigquery", gcp_project_number: "1", gcp_jwt_path: "k" },
    },
    message: "Missing required field in config: analytics.gcp_project_id",
  },
  {
    name: "bigquery fields are not required while analytics is disabled",
    overrides: { analytics: { enabled: false, backend: "bigquery" } },
    message: undefined,
  },
  {
    name: "webhooks section without enabled = true",
    overrides: { experimental: { webhooks: { enabled: false } } },
    document: { experimental: { webhooks: { enabled: false } } },
    message: "Webhooks cannot be deactivated.",
  },
  {
    name: "pgdelta format_options is not JSON",
    overrides: { experimental: { pgdelta: { format_options: "{not json" } } },
    message: "Invalid config for experimental.pgdelta.format_options: must be valid JSON",
  },
  {
    name: "empty site_url with auth enabled",
    overrides: { auth: { enabled: true, site_url: "" } },
    message: "Missing required field in config: auth.site_url",
  },
  {
    name: "empty site_url with auth disabled",
    overrides: { auth: { enabled: false, site_url: "" } },
    message: undefined,
  },
  {
    name: "captcha enabled without provider",
    overrides: auth({ captcha: { enabled: true, secret: "s" } }),
    message: "Missing required field in config: auth.captcha.provider",
  },
  {
    name: "captcha enabled without secret",
    overrides: auth({ captcha: { enabled: true, provider: "hcaptcha" } }),
    message: "Missing required field in config: auth.captcha.secret",
  },
  {
    name: "passkey without webauthn",
    overrides: auth({}),
    document: { auth: { passkey: { enabled: true } } },
    message: "Missing required config section: auth.webauthn",
  },
  {
    name: "passkey with webauthn missing rp_origins",
    overrides: auth({}),
    document: { auth: { passkey: { enabled: true }, webauthn: { rp_id: "localhost" } } },
    message: "Missing required field in config: auth.webauthn.rp_origins",
  },
  {
    name: "passkey with a complete webauthn section",
    overrides: auth({}),
    document: {
      auth: {
        passkey: { enabled: true },
        webauthn: { rp_id: "localhost", rp_origins: ["http://localhost:3000"] },
      },
    },
    message: undefined,
  },
  {
    name: "passkey is not checked with auth disabled",
    overrides: { auth: { enabled: false } },
    document: { auth: { passkey: { enabled: true } } },
    message: undefined,
  },
  {
    name: "smtp table without host",
    overrides: auth({}),
    document: { auth: { email: { smtp: { user: "u" } } } },
    message: "Missing required field in config: auth.email.smtp.host",
  },
  {
    name: "smtp table with enabled = false",
    overrides: auth({}),
    document: { auth: { email: { smtp: { enabled: false } } } },
    message: undefined,
  },
  {
    name: "hook without uri",
    overrides: auth({ hook: { custom_access_token: { enabled: true } } }),
    message: "Missing required field in config: auth.hook.custom_access_token.uri",
  },
  {
    name: "http hook without secrets",
    overrides: auth({
      hook: { custom_access_token: { enabled: true, uri: "https://example.com/hook" } },
    }),
    message: "Missing required field in config: auth.hook.custom_access_token.secrets",
  },
  {
    name: "pg-functions hook with secrets",
    overrides: auth({
      hook: {
        custom_access_token: {
          enabled: true,
          uri: "pg-functions://postgres/public/hook",
          secrets: "x",
        },
      },
    }),
    message: "auth.hook.custom_access_token.secrets is unsupported for pg-functions URI",
  },
  {
    name: "hook with an unsupported scheme",
    overrides: auth({ hook: { custom_access_token: { enabled: true, uri: "ftp://example.com" } } }),
    message: "auth.hook.custom_access_token.uri should be a HTTP, HTTPS, or pg-functions URI",
  },
  {
    name: "mfa enroll without verify",
    overrides: auth({ mfa: { totp: { enroll_enabled: true, verify_enabled: false } } }),
    message: "Invalid MFA config: auth.mfa.totp.enroll_enabled requires verify_enabled",
  },
  {
    name: "firebase without project_id",
    overrides: auth({ third_party: { firebase: { enabled: true } } }),
    message: "Invalid config: auth.third_party.firebase is enabled but without a project_id.",
  },
  {
    name: "cognito with a pool id but no region",
    overrides: auth({ third_party: { aws_cognito: { enabled: true, user_pool_id: "p" } } }),
    message: "Invalid config: auth.third_party.cognito is enabled but without a user_pool_region.",
  },
  {
    name: "clerk with a bad domain",
    overrides: auth({ third_party: { clerk: { enabled: true, domain: "nope" } } }),
    message: "Invalid config: auth.third_party.clerk has invalid domain",
  },
  {
    name: "two third-party providers",
    overrides: auth({
      third_party: {
        firebase: { enabled: true, project_id: "p" },
        auth0: { enabled: true, tenant: "t" },
      },
    }),
    message: "Invalid config: Only one third_party provider allowed to be enabled at a time.",
  },
  {
    name: "custom external provider without client_id",
    overrides: auth({}),
    document: { auth: { external: { my_oidc: { enabled: true } } } },
    message: "Missing required field in config: auth.external.my_oidc.client_id",
  },
  {
    name: "api.tls cert without key",
    overrides: { api: { enabled: true, tls: { enabled: true, cert_path: "c.pem" } } },
    message: "Missing required field in config: api.tls.key_path",
  },
];

describe("config check units", () => {
  for (const testCase of cases) {
    it.effect(`local order: ${testCase.name}`, () =>
      Effect.gen(function* () {
        const message = yield* firstMessage(
          LOCAL_CHECK_ORDER,
          testCase.overrides,
          testCase.document,
        );
        if (testCase.message === undefined) expect(message).toBeUndefined();
        else expect(message).toContain(testCase.message);
      }),
    );
  }

  it.effect(
    "a bucket file_size_limit that does not parse fails the db order, not the local one",
    () =>
      Effect.gen(function* () {
        const overrides = { storage: { buckets: { avatars: { file_size_limit: "nonsense" } } } };
        expect(yield* firstMessage(LOCAL_CHECK_ORDER, overrides)).toBeUndefined();
        expect(yield* firstMessage(DB_CHECK_ORDER, overrides)).toContain(
          "failed to parse config: invalid storage.buckets.avatars.file_size_limit.",
        );
      }),
  );

  it.effect("the db order reports the first failure in its own order", () =>
    Effect.gen(function* () {
      const message = yield* firstMessage(DB_CHECK_ORDER, {
        db: { major_version: 12 },
        functions: { "1bad": {} },
      });
      expect(message).toContain("Postgres version 12.x");
    }),
  );

  it.effect("the db signing-keys unit reports an unreadable keys file", () =>
    Effect.gen(function* () {
      const message = yield* firstMessage([DB_SIGNING_KEYS_UNIT], {
        auth: { enabled: true, signing_keys_path: "./missing-keys.json" },
      });
      expect(message).toContain("failed to read signing keys");
    }),
  );
});

interface Read {
  readonly method: "get" | "written" | "has" | "keys";
  readonly path: Segments;
}

const recordingView = (
  inner: CountingCliConfigView,
  reads: Array<Read>,
): CountingCliConfigView => ({
  get: (path) => (reads.push({ method: "get", path }), inner.get(path)),
  written: (path) => (reads.push({ method: "written", path }), inner.written(path)),
  has: (path) => (reads.push({ method: "has", path }), inner.has(path)),
  hasTable: (path) => (reads.push({ method: "has", path }), inner.hasTable(path)),
  keys: (path) => (reads.push({ method: "keys", path }), inner.keys(path)),
  isKnown: (path) => inner.isKnown(path),
  defer: (path) => inner.defer(path),
  workdir: inner.workdir,
  configPath: inner.configPath,
  hasDocument: inner.hasDocument,
});

const withinScope = (scope: Segments, read: Read): boolean =>
  scope.every((segment, index) => read.path[index] === segment) ||
  (read.method === "keys" && read.path.every((segment, index) => scope[index] === segment));

const richFixture = (): { config: CliConfig; document: Doc } => ({
  config: decodeConfig({
    project_id: "test",
    storage: { buckets: { avatars: {} } },
    functions: { hello: {} },
    ...auth({
      captcha: { enabled: true, provider: "hcaptcha", secret: "s" },
      hook: { custom_access_token: { enabled: true, uri: "pg-functions://postgres/public/hook" } },
      mfa: { totp: { enroll_enabled: true, verify_enabled: true } },
      third_party: { firebase: { enabled: true, project_id: "p" } },
      sms: {
        twilio: { enabled: true, account_sid: "a", message_service_sid: "m", auth_token: "t" },
      },
    }),
  }),
  document: {
    auth: {
      passkey: { enabled: true },
      webauthn: { rp_id: "localhost", rp_origins: ["http://localhost:3000"] },
      email: { smtp: { host: "h", port: 25, user: "u", pass: "p", admin_email: "a@b.c" } },
      external: { my_oidc: { enabled: true, client_id: "c", secret: "s" } },
    },
    remotes: { staging: { project_id: "abcdefghijklmnopqrst" } },
    experimental: { webhooks: { enabled: true } },
  },
});

const maximalFixture = (): { config: CliConfig; document: Doc } => ({
  config: decodeConfig({
    project_id: "test",
    api: { enabled: true, tls: { enabled: true, cert_path: "cert.pem", key_path: "key.pem" } },
    analytics: {
      enabled: true,
      backend: "bigquery",
      gcp_project_id: "p",
      gcp_project_number: "1",
      gcp_jwt_path: "key.json",
    },
    studio: { enabled: true },
    local_smtp: { enabled: true },
    local: { services: { auth: { version: "bundled" } } },
    ...auth({
      signing_keys_path: "keys.json",
      jwt_secret: "a-sufficiently-long-jwt-secret",
      hook: {
        send_sms: {
          enabled: true,
          uri: "https://example.com/hook",
          secrets: "v1,whsec_dGVzdHRlc3R0ZXN0dGVzdHRlc3R0ZXN0dGVzdHRlc3Q=",
        },
        custom_access_token: { enabled: true, uri: "pg-functions://postgres/public/hook" },
      },
      mfa: {
        totp: { enroll_enabled: true, verify_enabled: true },
        phone: { enroll_enabled: true, verify_enabled: false },
      },
      third_party: { clerk: { enabled: true, domain: "clerk.example.com" } },
      sms: { vonage: { enabled: true, from: "f", api_key: "k", api_secret: "s" } },
      email: {
        smtp: { enabled: true, host: "h", port: 25, user: "u", pass: "p", admin_email: "a@b.c" },
        template: { confirmation: { subject: "s", content_path: "./confirm.html" } },
        notification: { password_changed: { enabled: true, content_path: "./pw.html" } },
      },
    }),
  }),
  document: {
    auth: {
      passkey: { enabled: true },
      webauthn: { rp_id: "localhost", rp_origins: ["http://localhost:3000"] },
      email: { smtp: { host: "h", port: 25, user: "u", pass: "p", admin_email: "a@b.c" } },
      external: { my_oidc: { enabled: true, client_id: "c", secret: "s" } },
    },
    db: { root_key: "k", migrations: { checks: { enabled: true } } },
    remotes: {
      staging: { project_id: "abcdefghijklmnopqrst" },
      prod: { project_id: "tsrqponmlkjihgfedcba" },
    },
    experimental: { webhooks: { enabled: true } },
  },
});

const commonPrefix = (paths: ReadonlyArray<Segments>): Segments => {
  const [first, ...rest] = paths;
  if (first === undefined) return [];
  let length = first.length;
  for (const path of rest) {
    let shared = 0;
    while (shared < length && path[shared] === first[shared]) shared += 1;
    length = shared;
  }
  return first.slice(0, length);
};

describe("config check unit scopes", () => {
  it.effect(
    "every read stays inside the unit's declared scope, and the scope is the tightest",
    () =>
      Effect.gen(function* () {
        const io = yield* makeCliConfigUnitIo("local");
        const units = [
          ...new Set([
            ...LOCAL_CHECK_ORDER,
            authSignedKeys,
            DB_SIGNING_KEYS_UNIT,
            ...VALIDATE_ONLY_UNITS,
          ]),
        ];
        const observed = new Map<string, Array<Segments>>();
        for (const { config, document } of [richFixture(), maximalFixture()]) {
          const inner = untrackedCliConfigView({ config, document, workdir: WORKDIR });
          for (const unit of units) {
            const reads: Array<Read> = [];
            const view = recordingView(inner, reads);
            const entries = unit.entries === undefined ? [undefined] : unit.entries(view);
            const entryReads = [...reads];
            const scopeOf = (entry: string | undefined) =>
              typeof unit.scope === "function" ? unit.scope(entry ?? "") : unit.scope;
            for (const entry of entries.length === 0 ? [undefined] : entries) {
              const scope = scopeOf(entry);
              reads.splice(0, reads.length, ...entryReads);
              yield* unit.run(view, io, entry);
              for (const read of reads) {
                expect(
                  withinScope(scope, read),
                  `${unit.id} read ${read.path.join(".")} outside ${scope.join(".")}`,
                ).toBe(true);
              }
              if (typeof unit.scope !== "function") {
                observed.set(unit.id, [
                  ...(observed.get(unit.id) ?? []),
                  ...reads.filter((read) => read.method !== "keys").map((read) => read.path),
                ]);
              }
            }
          }
        }
        for (const unit of units) {
          const paths = observed.get(unit.id) ?? [];
          if (paths.length === 0 || typeof unit.scope === "function") continue;
          expect(unit.scope, `${unit.id} scope is not the lowest table holding its reads`).toEqual(
            commonPrefix(paths),
          );
        }
      }).pipe(Effect.provide(BunServices.layer)),
  );
});

const unknownAt = (
  known: ReadonlyArray<Segments>,
  base: CountingCliConfigView,
  reads: Array<Segments>,
): CountingCliConfigView => ({
  ...base,
  get: (path) => (reads.push(path), base.get(path)),
  written: (path) => (reads.push(path), base.written(path)),
  isKnown: (path) => known.some((candidate) => candidate.join(".") === path.join(".")),
});

const unitById = (id: string): CliConfigCheckUnit => {
  const unit = [...LOCAL_CHECK_ORDER, authSignedKeys, ...VALIDATE_ONLY_UNITS].find(
    (candidate) => candidate.id === id,
  );
  if (unit === undefined) throw new Error(`no unit ${id}`);
  return unit;
};

describe("counting units", () => {
  const run = (id: string, view: CountingCliConfigView) =>
    Effect.gen(function* () {
      const io = yield* makeCliConfigUnitIo("local");
      const unit = unitById(id);
      const entries = unit.entries === undefined ? [undefined] : unit.entries(view);
      const findings = [];
      for (const entry of entries) findings.push(...(yield* unit.run(view, io, entry)));
      return findings;
    }).pipe(Effect.provide(BunServices.layer));

  const twoProviders = decodeConfig({
    project_id: "test",
    ...auth({
      third_party: {
        firebase: { enabled: true, project_id: "p" },
        auth0: { enabled: true, tenant: "t" },
      },
    }),
  });
  const base = untrackedCliConfigView({ config: twoProviders, workdir: WORKDIR });
  const thirdParty = (provider: string): Segments => ["auth", "third_party", provider, "enabled"];

  it.effect("third_party settles on the known flags when two are already enabled", () =>
    Effect.gen(function* () {
      const reads: Array<Segments> = [];
      const known = [["auth", "enabled"], thirdParty("firebase"), thirdParty("auth0")];
      const findings = yield* run("auth.third_party", unknownAt(known, base, reads));
      expect(findings.map((finding) => finding.message)).toEqual([
        "Invalid config: Only one third_party provider allowed to be enabled at a time.",
      ]);
      expect(reads).not.toContainEqual(thirdParty("aws_cognito"));
      expect(reads).not.toContainEqual(thirdParty("clerk"));
      expect(reads).not.toContainEqual(thirdParty("workos"));
    }),
  );

  it.effect("third_party does not defer when one unknown flag cannot break the rule", () =>
    Effect.gen(function* () {
      const reads: Array<Segments> = [];
      const known = [
        ["auth", "enabled"],
        thirdParty("firebase"),
        thirdParty("auth0"),
        thirdParty("aws_cognito"),
        thirdParty("clerk"),
      ];
      const noneEnabled = untrackedCliConfigView({
        config: decodeConfig({ project_id: "test", ...auth({}) }),
        workdir: WORKDIR,
      });
      const findings = yield* run("auth.third_party", unknownAt(known, noneEnabled, reads));
      expect(findings).toEqual([]);
      expect(reads).not.toContainEqual(thirdParty("workos"));
    }),
  );

  it.effect("third_party reads the first unknown flag when the known ones do not settle it", () =>
    Effect.gen(function* () {
      const reads: Array<Segments> = [];
      const known = [["auth", "enabled"], thirdParty("firebase")];
      const findings = yield* run("auth.third_party", unknownAt(known, base, reads));
      expect(findings).toEqual([]);
      expect(reads).toContainEqual(thirdParty("auth0"));
    }),
  );

  const smsGate = (provider: string): Segments => ["auth", "sms", provider, "enabled"];
  const twilioThenVonage = untrackedCliConfigView({
    config: decodeConfig({
      project_id: "test",
      ...auth({
        sms: {
          twilio: { enabled: true, account_sid: "a", message_service_sid: "m", auth_token: "t" },
          vonage: { enabled: true },
        },
      }),
    }),
    workdir: WORKDIR,
  });

  it.effect("sms checks only the first enabled provider, never a later enabled one", () =>
    Effect.gen(function* () {
      for (const id of ["auth.sms.provider", "auth.sms.table"]) {
        expect(yield* run(id, twilioThenVonage)).toEqual([]);
      }
    }),
  );

  it.effect("sms reports a missing credential on the first enabled provider only", () =>
    Effect.gen(function* () {
      const decoded = decodeCliConfigWithoutTableRules({
        project_id: "test",
        ...auth({
          sms: {
            twilio: { enabled: true, account_sid: "a", message_service_sid: "m" },
            vonage: { enabled: true },
          },
        }),
      });
      if (decoded._tag !== "Success") throw new Error("fixture does not decode");
      const view = untrackedCliConfigView({ config: decoded.value, workdir: WORKDIR });
      for (const id of ["auth.sms.provider", "auth.sms.table"]) {
        const findings = yield* run(id, view);
        expect(findings.map((finding) => finding.path.join("."))).toEqual([
          "auth.sms.twilio.auth_token",
        ]);
      }
    }),
  );

  it.effect("sms settles on a known enabled provider without reading later flags", () =>
    Effect.gen(function* () {
      const reads: Array<Segments> = [];
      const known = [["auth", "enabled"], smsGate("twilio")];
      const findings = yield* run("auth.sms.provider", unknownAt(known, twilioThenVonage, reads));
      expect(findings).toEqual([]);
      expect(reads).not.toContainEqual(smsGate("twilio_verify"));
    }),
  );

  it.effect("sms reads the first unknown flag when no known provider settles it", () =>
    Effect.gen(function* () {
      const reads: Array<Segments> = [];
      const known = [["auth", "enabled"], smsGate("twilio")];
      const disabledTwilio = untrackedCliConfigView({
        config: decodeConfig({ project_id: "test", ...auth({}) }),
        workdir: WORKDIR,
      });
      yield* run("auth.sms.provider", unknownAt(known, disabledTwilio, reads));
      expect(reads).toContainEqual(smsGate("twilio_verify"));
    }),
  );

  it.effect("smtp port 0 is rejected by the CLI unit while the schema rule accepts it", () =>
    Effect.gen(function* () {
      const smtp = { host: "h", port: 0, user: "u", pass: "p", admin_email: "a@b.c" };
      const view = untrackedCliConfigView({
        config: decodeConfig({ project_id: "test", ...auth({}) }),
        document: { auth: { email: { smtp } } },
        workdir: WORKDIR,
      });
      const findings = yield* run("auth.email.smtp.port", view);
      expect(findings.map((finding) => finding.message)).toEqual([
        "Missing required field in config: auth.email.smtp.port",
      ]);
      expect(cliConfigSmtpIssues({ enabled: true, ...smtp })).toEqual([]);
    }),
  );

  it.effect("remotes without a project_id never collide", () =>
    Effect.gen(function* () {
      const document = { remotes: { a: { api: { port: 1 } }, b: { api: { port: 2 } } } };
      const view = untrackedCliConfigView({ config: twoProviders, document, workdir: WORKDIR });
      expect(yield* run("remotes.project_id.duplicates", view)).toEqual([]);
    }),
  );

  it.effect("remote project ids defer to the first unknown id", () =>
    Effect.gen(function* () {
      const document = { remotes: { a: { project_id: "same" }, b: { project_id: "same" } } };
      const view = untrackedCliConfigView({ config: twoProviders, document, workdir: WORKDIR });
      const settled = yield* run("remotes.project_id.duplicates", view);
      expect(settled.map((finding) => finding.message)).toEqual([
        "duplicate project_id for [remotes.b] and [remotes.a]",
      ]);
      const reads: Array<Segments> = [];
      const deferred = yield* run(
        "remotes.project_id.duplicates",
        unknownAt([["remotes", "a", "project_id"]], view, reads),
      );
      expect(deferred).toEqual([]);
      expect(reads).toContainEqual(["remotes", "b", "project_id"]);
    }),
  );
});

describe("listAuthExternalProviderNames", () => {
  it("never throws on an unresolved env reference", () => {
    const config = decodeConfig({ project_id: "test" });
    const names = listAuthExternalProviderNames(
      { external: { my_oidc: { enabled: "env(X)" } } },
      config.auth.external,
    );
    expect(names).toEqual(["my_oidc", "apple"]);
  });

  it("still throws from resolveAuthExternalProviders on a non-boolean literal", () => {
    const config = decodeConfig({ project_id: "test" });
    expect(() =>
      resolveAuthExternalProviders(
        { external: { my_oidc: { enabled: "maybe" } } },
        config.auth.external,
      ),
    ).toThrow('Invalid config for auth.external.my_oidc.enabled: "maybe" is not a valid boolean');
  });
});

describe("switches that hold an unusable value", () => {
  const deferred = (id: string, document: Doc, overrides: Record<string, unknown>) =>
    Effect.gen(function* () {
      const calls: Array<Segments> = [];
      const inner = untrackedCliConfigView({
        config: decodeConfig({ project_id: "test", ...overrides }),
        document,
        workdir: WORKDIR,
      });
      const io = yield* makeCliConfigUnitIo("local");
      const findings = yield* unitById(id).run(
        { ...inner, defer: (path) => void calls.push(path) },
        io,
        id === "auth.external.required" ? "my_oidc" : undefined,
      );
      return { calls, findings };
    }).pipe(Effect.provide(BunServices.layer));

  it.effect("defer the webauthn check instead of counting a bad passkey flag as off", () =>
    Effect.gen(function* () {
      const { calls, findings } = yield* deferred(
        "auth.webauthn",
        { auth: { passkey: { enabled: "maybe" } } },
        auth({}),
      );

      expect(findings).toEqual([]);
      expect(calls).toEqual([["auth", "passkey", "enabled"]]);
    }),
  );

  it.effect("defer the provider requirements instead of counting a bad flag as off", () =>
    Effect.gen(function* () {
      const { calls, findings } = yield* deferred(
        "auth.external.required",
        { auth: { external: { my_oidc: { enabled: "maybe" } } } },
        auth({}),
      );

      expect(findings).toEqual([]);
      expect(calls).toEqual([["auth", "external", "my_oidc", "enabled"]]);
    }),
  );
});
