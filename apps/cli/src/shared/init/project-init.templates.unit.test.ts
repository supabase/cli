import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path, Predicate } from "effect";
import { CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL } from "@supabase/config";
import {
  applyConfigEdits,
  findUnknownCliConfigKeys,
  loadCliConfig,
  parseJsonc,
  type ConfigEdit,
} from "@supabase/config/internal";
import { convertCliConfigJsoncToToml } from "@supabase/config/convert";
import * as SmolToml from "smol-toml";
import { orioledbVersions, postgresMajor } from "@supabase/stack/internal/artifacts";
import { cliConfigDocumentOnlyPaths } from "../../config/cli-config-keys.ts";
import { postgresVersionCompare } from "../../command-internal/db-bootstrap/postgres.service.ts";
import {
  INIT_GITIGNORE_TEMPLATE,
  INTELLIJ_DENO_TEMPLATE,
  VSCODE_EXTENSIONS_TEMPLATE,
  VSCODE_SCHEMA_TRUST_TEMPLATE,
  VSCODE_SETTINGS_TEMPLATE,
  renderCliConfigTemplate,
} from "./project-init.templates.ts";

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

const renderTomlTemplate = (projectId: string, useOrioledb: boolean, experimentalStack = false) =>
  convertCliConfigJsoncToToml(renderCliConfigTemplate(projectId, useOrioledb, experimentalStack))
    .text;

// Vendored copies of the init-template scaffold files. Dotted file
// names are de-dotted so git/tooling don't interpret the fixtures themselves.
const readVendoredTemplate = Effect.fnUntraced(function* (name: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const contents = yield* fs.readFileString(
    path.join(import.meta.dirname, "testdata/templates", name),
  );
  return normalizeNewlines(contents);
});

// The config.toml scaffold renders through text/template, so
// an action wrapping a backtick raw string — {{ `{{ .Code }}` }} in the
// source — is rendered to the literal string it quotes: `{{ .Code }}` in the
// ejected file. This is the only text/template construct emulated here; the
// "models every template action" test below fails loudly if that ever changes.
function resolveTemplateEscapes(template: string): string {
  return template.replace(/\{\{\s*`([^`]*)`\s*\}\}/g, "$1");
}

// Emulates what the scaffold writes to disk for a fresh `supabase init` project.
const renderExpectedInitOutput = readVendoredTemplate("config.toml").pipe(
  Effect.map((template) =>
    resolveTemplateEscapes(template)
      .replace("{{ .ProjectId }}", "demo-project")
      // The version is catalog data, checked by the pinned-version test below.
      .replace(
        "{{ .Db.OrioleDBVersion }}",
        /^\s*"orioledb_version": "(.*)",$/m.exec(
          renderCliConfigTemplate("demo-project", true),
        )?.[1] ?? "",
      )
      // supabase init always opts new projects into pg-delta; the template
      // renders this from a flag only set on the init path.
      .replace("{{ .Experimental.PgDeltaInitEnabled }}", "true"),
  ),
);

// The vendored scaffold still describes `auto_expose_new_tables` as unset-means-
// revoked and deprecated; the native template documents unset-means-exposed
// instead, since platform projects never stopped auto-exposing new entities.
const SCAFFOLD_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs. When unset, new entities are NOT auto-exposed, matching the new cloud
# default. Set to \`true\` to keep the legacy behaviour of auto-exposing new entities; this is
# deprecated and the field is removed on 2026-10-30 once the always-revoked behaviour is permanent.
# auto_expose_new_tables = true`;

const NATIVE_AUTO_EXPOSE_COMMENT = `# without explicit GRANTs, matching the cloud default. Set to \`false\` to require explicit GRANTs
# instead. Left unset, a fresh project falls back to \`true\`.
# auto_expose_new_tables = true`;

/* Only the native template documents Ethereum web3, cites SIWS without EIP-4361 and fixes
   the `max_rows` comment typo; the vendored scaffold is left as shipped. */
const NATIVE_WEB3_ETHEREUM_EXAMPLE = `
# Allow Ethereum wallet holders to sign in to your project via the Sign in with Ethereum (SIWE, EIP-4361) standard.
# [auth.web3.ethereum]
# enabled = true
`;

// The vendored scaffold describes the per-provider `enable_signup` keys as signup switches; the
// native template spells them `enabled`, says they turn the provider off and points to `[auth]
// enable_signup` for signups.
const SCAFFOLD_SIGNUP_COMMENT = `# Allow/disallow new user signups to your project.
enable_signup = true`;

const NATIVE_SIGNUP_COMMENT = `# Allow/disallow new user signups to your project. Existing users can still sign in.
enable_signup = true`;

const SCAFFOLD_EMAIL_SIGNUP_COMMENT = `# Allow/disallow new user signups via email to your project.
enable_signup = true`;

const NATIVE_EMAIL_SIGNUP_COMMENT = `# Allow/disallow the email provider. When false, users can't sign up or sign in with email.
# To block new signups only, set enable_signup = false under [auth] instead.
enabled = true`;

const SCAFFOLD_SMS_SIGNUP_COMMENT = `# Allow/disallow new user signups via SMS to your project.
enable_signup = false`;

const NATIVE_SMS_SIGNUP_COMMENT = `# Allow/disallow the phone provider. When false, users can't sign up or sign in with SMS.
# To block new signups only, set enable_signup = false under [auth] instead.
enabled = false`;

/* Only the native template documents `require_current_password`. */
const NATIVE_REQUIRE_CURRENT_PASSWORD = `secure_password_change = false
# If enabled, users will need to provide their current password to change their password, unless
# they signed in with a one-time password, magic link, or recovery link.
# require_current_password = true`;

/* Only the native template documents `db_pool`. */
const NATIVE_DB_POOL = `max_rows = 1000
# The maximum number of connections in the local PostgREST database pool. Left unset, the default
# pool size is unchanged.
# db_pool = 10`;

const renderExpectedNativeEject = renderExpectedInitOutput.pipe(
  Effect.map((eject) =>
    eject
      .replace(
        '# content_path = "./templates/password_changed_notification.html"',
        '# content_path = "./supabase/templates/password_changed_notification.html"',
      )
      .replace(SCAFFOLD_AUTO_EXPOSE_COMMENT, NATIVE_AUTO_EXPOSE_COMMENT)
      .replace(SCAFFOLD_SIGNUP_COMMENT, NATIVE_SIGNUP_COMMENT)
      .replace(SCAFFOLD_EMAIL_SIGNUP_COMMENT, NATIVE_EMAIL_SIGNUP_COMMENT)
      .replace(SCAFFOLD_SMS_SIGNUP_COMMENT, NATIVE_SMS_SIGNUP_COMMENT)
      .replace("secure_password_change = false", NATIVE_REQUIRE_CURRENT_PASSWORD)
      .replace("max_rows = 1000", NATIVE_DB_POOL)
      .replace("rows returns from", "rows returned from")
      .replace("(SIWS, EIP-4361)", "(SIWS)")
      .replace(
        "[auth.web3.solana]\nenabled = false\n",
        `[auth.web3.solana]\nenabled = false\n${NATIVE_WEB3_ETHEREUM_EXAMPLE}`,
      ),
  ),
);

describe("project init templates", () => {
  it("renders JSONC that parses and starts with the schema line", () => {
    const rendered = renderCliConfigTemplate("demo", false);

    expect(rendered.startsWith(`{\n  "$schema": "${CLI_CONFIG_SCHEMA_URL}",\n`)).toBe(true);
    expect(parseJsonc(rendered)).toMatchObject({
      $schema: CLI_CONFIG_SCHEMA_URL,
      project_id: "demo",
      db: { orioledb_version: "" },
    });
  });

  it("sets db.orioledb_version when orioledb is requested", () => {
    const parsed = parseJsonc(renderCliConfigTemplate("demo", true)) as {
      db: { orioledb_version: string };
    };

    expect(parsed.db.orioledb_version).not.toBe("");
  });

  it.effect("renders every line of the native scaffold, with the native content_path base", () =>
    Effect.gen(function* () {
      // JSONC nesting reorders commented sibling blocks and adds parent-only headers, so
      // compare the non-blank lines as a multiset rather than byte for byte.
      const parentOnlyHeaders = new Set(["[auth.external]", "[auth.web3]", "[auth.third_party]"]);
      const lines = (text: string) =>
        normalizeNewlines(text)
          .split("\n")
          .filter((line) => line !== "" && !parentOnlyHeaders.has(line))
          .toSorted();

      expect(lines(renderTomlTemplate("demo-project", true))).toEqual(
        lines(yield* renderExpectedNativeEject),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("models every template action in the scaffold, so it cannot silently drift", () =>
    Effect.gen(function* () {
      // Anything beyond the GoTrue OTP placeholder means the template gained
      // a construct this suite doesn't emulate; update `resolveTemplateEscapes`
      // to match before shipping.
      const unresolvedActions = (yield* renderExpectedInitOutput).match(/\{\{[^}]*\}\}/g) ?? [];
      expect(new Set(unresolvedActions)).toEqual(new Set(["{{ .Code }}"]));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it("renders the SMS and MFA phone OTP templates as GoTrue templates, not raw template escapes", () => {
    const rendered = renderTomlTemplate("demo-project", false);
    const otpTemplateLines = rendered.split("\n").filter((line) => line.startsWith("template = "));
    expect(otpTemplateLines).toEqual([
      'template = "Your code is {{ .Code }}"',
      'template = "Your code is {{ .Code }}"',
    ]);
  });

  it("pins init's OrioleDB version to the newest OrioleDB 17 build the catalog publishes", () => {
    const pinned = orioledbVersions().filter((version) => postgresMajor(version) === "17");
    for (const experimentalStack of [false, true]) {
      const rendered = renderCliConfigTemplate("demo-project", true, experimentalStack);
      const version = /^\s*"orioledb_version": "(.+)",$/m.exec(rendered)?.[1] ?? "";
      expect(pinned).toContain(version);
      for (const other of pinned)
        expect(postgresVersionCompare(version, other)).toBeGreaterThanOrEqual(0);
    }
  });

  it.effect("renders a config that loads with provider switches declared and no deprecation", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "supabase-init-template-" });
      yield* fs.makeDirectory(path.join(cwd, "supabase"));
      yield* fs.writeFileString(
        path.join(cwd, "supabase", "config.toml"),
        renderTomlTemplate("demo-project", false),
      );
      const loaded = yield* loadCliConfig(cwd, { cliCompat: true });

      expect(loaded?.config.auth.email.enable_signup).toBe(true);
      expect(loaded?.config.auth.sms.enable_signup).toBe(false);
      expect(loaded?.document).toHaveProperty("auth.email.enable_signup", true);
      expect(loaded?.document).toHaveProperty("auth.sms.enable_signup", false);
      expect(loaded?.deprecatedPaths).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );

  it("renders a config with no keys the schema does not recognize", () => {
    for (const experimentalStack of [false, true]) {
      for (const useOrioledb of [false, true]) {
        const rendered = renderCliConfigTemplate("demo-project", useOrioledb, experimentalStack);
        expect(findUnknownCliConfigKeys(parseJsonc(rendered))).toEqual([]);
      }
    }
  });

  it("renders optional commented-out sections that are all recognized once uncommented", () => {
    const uncommentable = /^# (\[[\w.-]+\]|[\w.-]+ = .+)$/;
    const isDocumentOnly = (key: ReadonlyArray<string>) => {
      const dotted = key.join(".");
      return [...cliConfigDocumentOnlyPaths].some(
        (known) =>
          known === dotted || known.startsWith(`${dotted}.`) || dotted.startsWith(`${known}.`),
      );
    };
    for (const experimentalStack of [false, true]) {
      const rendered = renderTomlTemplate("demo-project", false, experimentalStack);
      const uncommented = rendered
        .split("\n")
        .map((line) => uncommentable.exec(line)?.[1] ?? line)
        .join("\n");

      expect(uncommented).toContain("[auth.passkey]");
      expect(uncommented).toContain("[auth.webauthn]");
      expect(
        findUnknownCliConfigKeys(SmolToml.parse(uncommented))
          .map(({ path }) => path)
          .filter((key) => !isDocumentOnly(key)),
      ).toEqual([]);
    }
  });

  it("enables pg-delta by default in the generated config", () => {
    const parsed = parseJsonc(renderCliConfigTemplate("demo-project", false)) as {
      experimental: { pgdelta: { enabled: boolean }; stack?: { enabled: boolean } };
    };

    expect(parsed.experimental.pgdelta.enabled).toBe(true);
    expect(parsed.experimental.stack).toBeUndefined();
  });

  it("opts the experimental stack template into stack enabled without default listener ports", () => {
    const rendered = renderCliConfigTemplate("demo-project", false, true);
    const parsed = parseJsonc(rendered) as {
      api: Record<string, unknown>;
      db: Record<string, unknown> & { pooler: Record<string, unknown> };
      studio: Record<string, unknown>;
      local_smtp: Record<string, unknown>;
      edge_runtime: Record<string, unknown>;
      analytics: Record<string, unknown>;
      experimental: Record<string, unknown> & { pgdelta: { enabled: boolean } };
    };

    expect(rendered).toMatch(
      /"experimental": \{\n    "stack": \{\n      \/\/ Use the new local stack backend for start, stop, and status, and for --local targets of db, migration, test db, gen types, inspect, and pull.\n      "enabled": true,\n    \},\n/,
    );
    expect(parsed.experimental.stack).toEqual({ enabled: true });
    expect(parsed.experimental.pgdelta.enabled).toBe(true);
    expect(rendered).toContain('// "smtp_port": 54325');
    expect(parsed.api).not.toHaveProperty("port");
    expect(parsed.db).not.toHaveProperty("port");
    expect(parsed.db).not.toHaveProperty("shadow_port");
    expect(parsed.db.pooler).not.toHaveProperty("port");
    expect(parsed.studio).not.toHaveProperty("port");
    expect(parsed.local_smtp).not.toHaveProperty("port");
    expect(parsed.edge_runtime).not.toHaveProperty("inspector_port");
    expect(parsed.analytics).not.toHaveProperty("port");
  });

  it("comments out the secrets and S3 settings in the experimental stack template", () => {
    const rendered = renderCliConfigTemplate("demo-project", false, true);
    const parsed = parseJsonc(rendered) as {
      studio: Record<string, unknown>;
      experimental: Record<string, unknown>;
    };

    for (const key of ["s3_host", "s3_region", "s3_access_key", "s3_secret_key"]) {
      expect(parsed.experimental).not.toHaveProperty(key);
      expect(rendered).toContain(`// "${key}": `);
    }
    expect(parsed.studio).not.toHaveProperty("openai_api_key");
    expect(rendered).toContain('// "openai_api_key": ');
  });

  it.effect("matches the .gitignore scaffold", () =>
    Effect.gen(function* () {
      expect(INIT_GITIGNORE_TEMPLATE).toBe(yield* readVendoredTemplate("gitignore"));
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the VS Code extensions scaffold", () =>
    Effect.gen(function* () {
      expect(VSCODE_EXTENSIONS_TEMPLATE).toBe(
        yield* readVendoredTemplate("vscode-extensions.json.golden"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.effect("matches the VS Code settings scaffold", () =>
    Effect.gen(function* () {
      expect(VSCODE_SETTINGS_TEMPLATE).toBe(
        yield* readVendoredTemplate("vscode-settings.json.golden"),
      );
    }).pipe(Effect.provide(BunServices.layer)),
  );

  it.each([
    ["settings", VSCODE_SETTINGS_TEMPLATE],
    ["schema trust", VSCODE_SCHEMA_TRUST_TEMPLATE],
  ])("trusts the hosted schema URLs in the VS Code %s template", (_name, template) => {
    const settings: unknown = JSON.parse(template);
    const trustedDomains = Predicate.isObject(settings)
      ? settings["json.schemaDownload.trustedDomains"]
      : undefined;
    const trusted = Predicate.isObject(trustedDomains)
      ? Object.entries(trustedDomains)
          .filter(([, enabled]) => enabled === true)
          .map(([prefix]) => prefix)
      : [];

    for (const url of [CLI_CONFIG_SCHEMA_URL, PROJECT_CONFIG_SCHEMA_URL]) {
      expect(trusted.some((prefix) => url.startsWith(prefix))).toBe(true);
    }
  });

  it.effect("matches the IntelliJ scaffold", () =>
    Effect.gen(function* () {
      expect(INTELLIJ_DENO_TEMPLATE).toBe(yield* readVendoredTemplate("idea-deno.xml"));
    }).pipe(Effect.provide(BunServices.layer)),
  );
});

// `applyConfigEdits` must edit the scaffold exactly as intended and nothing
// else; line-level diffing proves that, rather than trusting the editor's
// own report of what it touched.

interface DiffOp {
  readonly kind: "equal" | "removed" | "added";
  readonly line: string;
}

function computeLcsLengths(
  a: ReadonlyArray<string>,
  b: ReadonlyArray<string>,
): Array<Array<number>> {
  const dp: Array<Array<number>> = Array.from({ length: a.length + 1 }, () =>
    Array.from({ length: b.length + 1 }, () => 0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const diag = dp[i + 1]?.[j + 1] ?? 0;
      const down = dp[i + 1]?.[j] ?? 0;
      const right = dp[i]?.[j + 1] ?? 0;
      const row = dp[i];
      if (row !== undefined) {
        row[j] = a[i] === b[j] ? diag + 1 : Math.max(down, right);
      }
    }
  }
  return dp;
}

/** Line-level Myers-style diff (LCS-backed): every line of `a` and `b` is classified as
 * `equal`, `removed` (only in `a`), or `added` (only in `b`), in document order. */
function diffLines(a: ReadonlyArray<string>, b: ReadonlyArray<string>): ReadonlyArray<DiffOp> {
  const dp = computeLcsLengths(a, b);
  const ops: Array<DiffOp> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const lineA = a[i];
    const lineB = b[j];
    if (lineA !== undefined && lineB !== undefined && lineA === lineB) {
      ops.push({ kind: "equal", line: lineA });
      i++;
      j++;
      continue;
    }
    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;
    if (down >= right) {
      ops.push({ kind: "removed", line: lineA ?? "" });
      i++;
    } else {
      ops.push({ kind: "added", line: lineB ?? "" });
      j++;
    }
  }
  while (i < a.length) {
    ops.push({ kind: "removed", line: a[i] ?? "" });
    i++;
  }
  while (j < b.length) {
    ops.push({ kind: "added", line: b[j] ?? "" });
    j++;
  }
  return ops;
}

describe("config pull surgical editor round trip over the rendered scaffold", () => {
  it("applies a replace, an insert into an existing table, and a new [remotes.staging] block, touching only those lines", () => {
    const source = renderTomlTemplate("demo", false);
    const edits: ReadonlyArray<ConfigEdit> = [
      // Replace: an already-declared scalar.
      { path: ["api", "max_rows"], value: 500 },
      // Insert: a new key into an existing table ([realtime] only declares `enabled`; the
      // header's own example is commented out, so this isn't already declared).
      { path: ["realtime", "max_header_length"], value: 8192 },
      // Insert: a brand new [remotes.staging] block, created at EOF.
      { path: ["remotes", "staging", "project_id"], value: "bbbbbbbbbbbbbbbbbbbb" },
    ];

    const outcome = applyConfigEdits(source, "toml", edits);
    if (outcome.kind !== "applied") {
      throw new Error(
        `expected the edits to apply, got a refusal: ${JSON.stringify(outcome.refusal)}`,
      );
    }

    const ops = diffLines(source.split("\n"), outcome.text.split("\n"));
    // Blank lines are excluded: the block insertion's trailing blank can align
    // with the file's pre-existing final blank via LCS. The tail assertions
    // below pin blank-line placement byte-for-byte instead.
    const changed = ops.filter((op) => op.kind !== "equal" && op.line !== "");

    expect(changed).toEqual([
      { kind: "removed", line: "max_rows = 1000" },
      { kind: "added", line: "max_rows = 500" },
      { kind: "added", line: "max_header_length = 8192" },
      { kind: "added", line: "[remotes.staging]" },
      { kind: "added", line: 'project_id = "bbbbbbbbbbbbbbbbbbbb"' },
    ]);
    expect(
      outcome.text.endsWith('\n\n[remotes.staging]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n'),
    ).toBe(true);
    expect(
      outcome.text.endsWith('\n\n\n[remotes.staging]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n'),
    ).toBe(false);
    expect(outcome.applied).toEqual([
      { path: ["api", "max_rows"], action: "replaced", createdTables: [] },
      { path: ["realtime", "max_header_length"], action: "inserted", createdTables: [] },
      {
        path: ["remotes", "staging", "project_id"],
        action: "inserted",
        createdTables: [["remotes", "staging"]],
      },
    ]);
  });
});
