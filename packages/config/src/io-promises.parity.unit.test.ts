import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, test, vi } from "vitest";
import * as effectIo from "./bun.ts";
import { flattenCliConfigDecodeIssues } from "./cli-config-decode-issues.ts";
import * as promiseIo from "./io-promises.ts";

type Files = Readonly<Record<string, string>>;
type LoadOptions = Parameters<typeof promiseIo.loadCliConfig>[1];

const roots: Array<string> = [];

afterAll(() => Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))));
afterEach(() => vi.unstubAllEnvs());

async function project(files: Files): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "supabase-config-parity-"));
  roots.push(root);
  for (const [name, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), text);
  }
  return root;
}

async function bothProjects(files: Files): Promise<readonly [effect: string, plain: string]> {
  return [await project(files), await project(files)];
}

const scrub = (value: unknown, root: string): unknown =>
  JSON.parse(JSON.stringify(value ?? null).replaceAll(root, "<root>"));

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: Error & Record<string, unknown> };

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    const value = await run();
    return { ok: true, value };
  } catch (error) {
    if (error instanceof Error) {
      return { ok: false, error: Object.assign(error) };
    }
    throw error;
  }
}

function effectIssuePaths(error: Record<string, unknown>): ReadonlyArray<string> {
  const cause = error["cause"];
  if (typeof cause !== "object" || cause === null || !("issue" in cause)) {
    return [];
  }
  return flattenCliConfigDecodeIssues(cause.issue as never).map((issue) => issue.path.join("."));
}

function errorShape(error: Record<string, unknown>, root: string): unknown {
  const { _tag, path, format, paths, appliedRemote, removedKeys, declaredVersion, schemaRef } =
    error;
  const line = _tag === "CliProjectEnvParseError" ? error["line"] : undefined;
  return scrub(
    { _tag, path, format, paths, appliedRemote, removedKeys, declaredVersion, schemaRef, line },
    root,
  );
}

async function expectSameLoad(
  files: Files,
  options?: LoadOptions,
  expectation: "success" | "failure" | "either" = "either",
): Promise<Outcome> {
  const [effectRoot, plainRoot] = await bothProjects(files);
  const fromEffect = await outcome(() => effectIo.loadCliConfig(effectRoot, options));
  const fromPlain = await outcome(() => promiseIo.loadCliConfig(plainRoot, options));
  if (expectation !== "either") {
    expect(fromEffect.ok, "the Effect loader's outcome").toBe(expectation === "success");
  }
  expect(fromPlain.ok).toBe(fromEffect.ok);
  if (fromEffect.ok && fromPlain.ok) {
    expect(scrub(fromPlain.value, plainRoot)).toEqual(scrub(fromEffect.value, effectRoot));
    const effectConfig = (fromEffect.value as { config?: unknown } | null)?.config;
    const plainConfig = (fromPlain.value as { config?: unknown } | null)?.config;
    expect(JSON.stringify(plainConfig)).toBe(JSON.stringify(effectConfig));
  } else if (!fromEffect.ok && !fromPlain.ok) {
    expect(errorShape(fromPlain.error, plainRoot)).toEqual(
      errorShape(fromEffect.error, effectRoot),
    );
    const plainPaths = (
      fromPlain.error["issues"] as ReadonlyArray<{ path: string }> | undefined
    )?.map((issue) => issue.path);
    for (const path of effectIssuePaths(fromEffect.error)) {
      const anchored = path === "" ? "remotes" : `remotes.${path}`;
      expect(plainPaths?.includes(path) || plainPaths?.includes(anchored)).toBe(true);
    }
  }
  return fromPlain;
}

const config = (name: string, text: string): Files => ({ [`supabase/${name}`]: text });
const toml = (text: string): Files => config("config.toml", text);

describe("loadCliConfig parity with the Effect loader", () => {
  const valid: ReadonlyArray<readonly [string, Files, LoadOptions?]> = [
    ["an empty config.toml", toml("")],
    ["project_id only", toml('project_id = "parity"\n')],
    [
      "a broad toml",
      toml(`project_id = "parity"
[api]
enabled = true
port = 54321
schemas = ["public", "graphql_public"]
[db]
port = 54322
major_version = 17
[db.seed]
enabled = true
sql_paths = ["./seed.sql"]
[storage]
file_size_limit = 5000000
[storage.buckets.avatars]
public = true
file_size_limit = 1024
allowed_mime_types = ["image/png"]
[auth]
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["https://127.0.0.1:3000", "https://example.test"]
[auth.email]
enable_signup = false
[functions.hello]
verify_jwt = false
[edge_runtime.secrets]
FOO = "bar"
[experimental]
`),
    ],
    [
      "a config.jsonc with comments and a $schema",
      config(
        "config.jsonc",
        '{\n  // note\n  "$schema": "https://supabase.com/schemas/config/v1.json",\n  "project_id": "jsonc",\n  "api": { "port": 54329, },\n}\n',
      ),
    ],
    ["a config.json", config("config.json", '{"project_id":"json","db":{"port":54399}}')],
    [
      "json beating toml with ignoredPaths",
      {
        ...config("config.json", '{"project_id":"json"}'),
        ...config("config.toml", 'project_id = "toml"\n'),
      },
    ],
    [
      "tomlOnly skipping config.json",
      {
        ...config("config.json", '{"project_id":"json"}'),
        ...config("config.toml", 'project_id = "toml"\n'),
      },
      { tomlOnly: true },
    ],
    [
      "deprecated enable_signup keys",
      toml(
        "[auth.email]\nenable_signup = false\n[auth.sms]\nenabled = true\n[auth.sms.twilio]\nenabled = false\n",
      ),
    ],
    ["the new enabled key", toml("[auth.email]\nenabled = false\n")],
    ["memory with a lowercase unit", toml('[local.services.auth.container]\nmemory = "512mib"\n')],
    [
      "enabled smtp with every field",
      toml(
        '[auth.email.smtp]\nenabled = true\nhost = "h"\nport = 25\nuser = "u"\npass = "p"\nadmin_email = "a@b.c"\n',
      ),
    ],
    [
      "migration check exclusions with duplicates",
      toml(
        '[db.migrations.checks]\nrls_disabled_in_public = "error"\n[db.migrations.checks.exclude]\nrls_disabled_in_public = ["public.a", "public.a", "public.b"]\n',
      ),
    ],
    [
      "a remote that matches projectRef",
      toml(`project_id = "base"
[api]
port = 54321
[remotes.staging]
project_id = "abcdefghijklmnopqrst"
[remotes.staging.api]
port = 60000
[remotes.staging.db.seed]
enabled = true
`),
      { projectRef: "abcdefghijklmnopqrst" },
    ],
    [
      "a remote that matches nothing",
      toml(
        '[remotes.staging]\nproject_id = "abcdefghijklmnopqrst"\n[remotes.staging.storage]\nfile_size_limit = 9\n',
      ),
      { projectRef: "zzzzzzzzzzzzzzzzzzzz" },
    ],
    [
      "a remote with the default seed behaviour",
      toml('[db.seed]\nenabled = true\n[remotes.prod]\nproject_id = "abcdefghijklmnopqrst"\n'),
      { projectRef: "abcdefghijklmnopqrst" },
    ],
    [
      "remotes blocks that are fully defaulted",
      toml(
        '[remotes.a]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n[remotes.b]\nproject_id = "bbbbbbbbbbbbbbbbbbbb"\n',
      ),
    ],
    ["function records with an invalid slug", toml('[functions."bad name"]\nverify_jwt = false\n')],
    [
      "a remote with an invalid name",
      toml('[remotes."Bad Name"]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n'),
    ],
    ["a bucket with an invalid name", toml('[storage.buckets."bad name!"]\npublic = true\n')],
  ];

  const validCases = valid.map(([name, files, options]) => ({ name, files, options }));

  test.each(validCases)("loads $name identically", async ({ files, options }) => {
    const result = await expectSameLoad(files, options, "success");
    expect(result.ok).toBe(true);
  });

  test("loads the repository's legacy fixture identically", async () => {
    const legacy = await readFile(
      new URL("../testdata/legacy-config.toml", import.meta.url),
      "utf8",
    );
    await expectSameLoad(toml(legacy), undefined, "success");
  });

  const invalid: ReadonlyArray<readonly [string, Files, LoadOptions?]> = [
    ["a toml syntax error", toml("[api\nport = 1\n")],
    ["a jsonc syntax error", config("config.jsonc", '{"api": }')],
    ["a json document that is not a table", config("config.json", "[1, 2]")],
    ["a wrongly typed port", toml('[api]\nport = "not a number"\n')],
    ["an invalid enum value", toml('[db.pooler]\npool_mode = "bogus"\n')],
    ["a removed key", toml("[inbucket]\nenabled = true\n")],
    [
      "a removed key in a remote",
      toml('[remotes.a]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n[remotes.a.inbucket]\nport = 1\n'),
    ],
    ["both json and jsonc", { ...config("config.json", "{}"), ...config("config.jsonc", "{}") }],
    [
      "a schema version from the future",
      config("config.json", '{"$schema":"https://supabase.com/schemas/config/v99.json"}'),
    ],
    [
      "a future schema directive in toml",
      toml("#:schema https://supabase.com/schemas/config/v99.json\n"),
    ],
    ["enabled smtp missing fields", toml("[auth.email.smtp]\nenabled = true\n")],
    [
      "an enabled provider missing secrets",
      toml('[auth.external.github]\nenabled = true\nclient_id = "x"\n'),
    ],
    ["an enabled sms provider missing fields", toml("[auth.sms.twilio]\nenabled = true\n")],
    ["an invalid service version", toml('[local.services.auth]\nversion = "17.6-orioledb"\n')],
    ["an unknown migration check rule", toml('[db.migrations.checks]\nbogus_rule = "error"\n')],
    [
      "an invalid migration check severity",
      toml('[db.migrations.checks]\nrls_disabled_in_public = "loud"\n'),
    ],
    [
      "a bad migration check exclusion",
      toml('[db.migrations.checks.exclude]\nrls_disabled_in_public = ["no_schema"]\n'),
    ],
    ["an invalid memory size", toml('[local.services.auth.container]\nmemory = "banana"\n')],
    ["a memory size below the floor", toml('[local.services.auth.container]\nmemory = "1KiB"\n')],
    ["an invalid cpus value", toml("[local.services.auth.container]\ncpus = 0\n")],
    [
      "a wrongly typed remote value",
      toml('[remotes.a]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n[remotes.a.api]\nport = "x"\n'),
    ],
    ["a remotes table that is not a table", toml('remotes = "nope"\n')],
    [
      "a matched remote that breaks a base rule",
      toml(
        '[remotes.a]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n[remotes.a.auth.email.smtp]\nenabled = true\n',
      ),
      { projectRef: "aaaaaaaaaaaaaaaaaaaa" },
    ],
    ["a malformed project .env", { ...toml(""), "supabase/.env": "this is not a dotenv line\n" }],
  ];

  const invalidCases = invalid.map(([name, files, options]) => ({ name, files, options }));

  test.each(invalidCases)("rejects $name the same way", async ({ files, options }) => {
    const result = await expectSameLoad(files, options, "failure");
    expect(result.ok).toBe(false);
  });

  test("a project without a config loads as null in both", async () => {
    const result = await expectSameLoad({ "unrelated.txt": "" });
    expect(result).toMatchObject({ ok: true, value: null });
  });

  test("search:false does not climb out of cwd", async () => {
    const [effectRoot, plainRoot] = await bothProjects(toml('project_id = "up"\n'));
    await mkdir(join(effectRoot, "nested"));
    await mkdir(join(plainRoot, "nested"));

    const fromEffect = await effectIo.loadCliConfig(join(effectRoot, "nested"), { search: false });
    const fromPlain = await promiseIo.loadCliConfig(join(plainRoot, "nested"), { search: false });

    expect(fromPlain).toBeNull();
    expect(fromEffect).toBeNull();
  });
});

describe("env() interpolation parity", () => {
  const envConfig = `project_id = "env(PARITY_ID)"
[api]
port = "env(PARITY_PORT)"
[studio]
enabled = "env(PARITY_BOOL)"
[auth]
additional_redirect_urls = ["env(PARITY_URL)", "https://literal.test"]
[auth.external.github]
enabled = true
client_id = "env(PARITY_GH_ID)"
secret = "env(PARITY_GH_SECRET)"
[edge_runtime.secrets]
FOO = "env(PARITY_FOO)"
[db.seed]
sql_paths = ["env(PARITY_SEEDS)"]
`;

  test("resolves ambient variables with schema-aware coercion", async () => {
    vi.stubEnv("PARITY_ID", "resolved-id");
    vi.stubEnv("PARITY_PORT", "54331");
    vi.stubEnv("PARITY_BOOL", "false");
    vi.stubEnv("PARITY_URL", "https://from-env.test");
    vi.stubEnv("PARITY_GH_ID", "gh-id");
    vi.stubEnv("PARITY_GH_SECRET", "gh-secret");
    vi.stubEnv("PARITY_FOO", "foo-value");
    vi.stubEnv("PARITY_SEEDS", "./a.sql,./b.sql");

    const result = await expectSameLoad(toml(envConfig), undefined, "either");

    expect(result.ok).toBe(true);
  });

  test("keeps unresolved references and rejects them where the type cannot hold them", async () => {
    await expectSameLoad(toml(envConfig), undefined, "failure");
  });

  test("layers .env and .env.local under the ambient environment", async () => {
    vi.stubEnv("PARITY_ID", "ambient-id");
    const files: Files = {
      ...toml(
        'project_id = "env(PARITY_ID)"\n[api]\nport = "env(PARITY_PORT)"\n[studio]\nenabled = "env(PARITY_BOOL)"\n',
      ),
      "supabase/.env": 'PARITY_ID="dotenv-id"\nPARITY_PORT=54000\nPARITY_BOOL=true\n',
      "supabase/.env.local": "PARITY_PORT=54001\n",
    };

    const result = await expectSameLoad(files, undefined, "success");

    expect(result).toMatchObject({
      ok: true,
      value: { config: { project_id: "ambient-id", api: { port: 54001 } } },
    });
  });

  test("an empty variable keeps the env() literal like an unset one", async () => {
    vi.stubEnv("PARITY_ID", "");

    await expectSameLoad(toml('project_id = "env(PARITY_ID)"\n'), undefined, "success");
  });

  test("a remote's env() reference resolves after the merge", async () => {
    vi.stubEnv("PARITY_REMOTE_PORT", "61000");
    const files = toml(`[remotes.staging]
project_id = "abcdefghijklmnopqrst"
[remotes.staging.api]
port = "env(PARITY_REMOTE_PORT)"
`);

    const result = await expectSameLoad(files, { projectRef: "abcdefghijklmnopqrst" }, "success");

    expect(result).toMatchObject({ ok: true, value: { appliedRemote: "staging" } });
  });

  test("a project_id env() on a remote matches by its raw literal", async () => {
    vi.stubEnv("PARITY_REF", "abcdefghijklmnopqrst");
    const files = toml('[remotes.staging]\nproject_id = "env(PARITY_REF)"\n');

    await expectSameLoad(files, { projectRef: "abcdefghijklmnopqrst" }, "success");
    await expectSameLoad(files, { projectRef: "env(PARITY_REF)" }, "success");
  });

  test("a caller-supplied project environment replaces the dotenv files", async () => {
    const [effectRoot, plainRoot] = await bothProjects({
      ...toml('project_id = "env(PARITY_ID)"\n'),
      "supabase/.env": "PARITY_ID=from-dotenv\n",
    });
    const fromEffect = await effectIo.loadCliProjectEnvironment({ cwd: effectRoot, baseEnv: {} });
    const fromPlain = await promiseIo.loadCliProjectEnvironment({ cwd: plainRoot, baseEnv: {} });
    if (fromEffect === null || fromPlain === null) {
      throw new Error("expected a project environment");
    }
    const supplied = { ...fromEffect, values: { PARITY_ID: "supplied" } };

    const effectLoaded = await effectIo.loadCliConfig(effectRoot, { cliProjectEnv: supplied });
    const plainLoaded = await promiseIo.loadCliConfig(plainRoot, {
      cliProjectEnv: { ...fromPlain, values: { PARITY_ID: "supplied" } },
    });

    expect(plainLoaded?.config).toEqual(effectLoaded?.config);
    expect(plainLoaded?.config["project_id"]).toBe("supplied");
  });
});

describe("project discovery parity", () => {
  test("findCliProjectPaths and findCliProjectRoot agree", async () => {
    const [effectRoot, plainRoot] = await bothProjects({
      ...toml('project_id = "paths"\n'),
      "supabase/.env": "A=1\n",
      "deep/nested/keep": "",
    });

    const fromEffect = await effectIo.findCliProjectPaths(join(effectRoot, "deep", "nested"));
    const fromPlain = await promiseIo.findCliProjectPaths(join(plainRoot, "deep", "nested"));

    expect(scrub(fromPlain, plainRoot)).toEqual(scrub(fromEffect, effectRoot));
    expect(scrub(await promiseIo.findCliProjectRoot(join(plainRoot, "deep")), plainRoot)).toEqual(
      scrub(await effectIo.findCliProjectRoot(join(effectRoot, "deep")), effectRoot),
    );
  });

  test("loadCliProjectEnvironment layers dotenv files under baseEnv and skips .env.local on request", async () => {
    const files: Files = {
      ...toml(""),
      "supabase/.env": "A=env\nB=env\n",
      "supabase/.env.local": "B=local\nC=local\n",
    };
    const [effectRoot, plainRoot] = await bothProjects(files);
    const baseEnv = { C: "ambient" };

    for (const skipEnvLocal of [false, true]) {
      const fromEffect = await effectIo.loadCliProjectEnvironment({
        cwd: effectRoot,
        baseEnv,
        skipEnvLocal,
      });
      const fromPlain = await promiseIo.loadCliProjectEnvironment({
        cwd: plainRoot,
        baseEnv,
        skipEnvLocal,
      });

      expect(scrub(fromPlain, plainRoot)).toEqual(scrub(fromEffect, effectRoot));
    }
  });

  test("loadCliProjectEnvironment reports a malformed dotenv file in both", async () => {
    const [effectRoot, plainRoot] = await bothProjects({ ...toml(""), "supabase/.env": "???\n" });

    const fromEffect = await outcome(() => effectIo.loadCliProjectEnvironment({ cwd: effectRoot }));
    const fromPlain = await outcome(() => promiseIo.loadCliProjectEnvironment({ cwd: plainRoot }));

    expect(fromEffect.ok || fromPlain.ok).toBe(false);
    if (!fromEffect.ok && !fromPlain.ok) {
      expect(errorShape(fromPlain.error, plainRoot)).toEqual(
        errorShape(fromEffect.error, effectRoot),
      );
    }
  });

  test("loadCliProjectEnvironment is null outside a project", async () => {
    const root = await project({ "x.txt": "" });

    expect(await promiseIo.loadCliProjectEnvironment({ cwd: root })).toBeNull();
    expect(await effectIo.loadCliProjectEnvironment({ cwd: root })).toBeNull();
  });
});

describe("loadCliConfigFile parity", () => {
  test("loads a file path directly", async () => {
    const files = toml('project_id = "direct"\n[api]\nport = 54999\n');
    const [effectRoot, plainRoot] = await bothProjects(files);

    const fromEffect = await effectIo.loadCliConfigFile(
      join(effectRoot, "supabase", "config.toml"),
    );
    const fromPlain = await promiseIo.loadCliConfigFile(join(plainRoot, "supabase", "config.toml"));

    expect(scrub(fromPlain, plainRoot)).toEqual(scrub(fromEffect, effectRoot));
  });

  test("rejects a missing file with the platform's not-found error", async () => {
    const root = await project({ "x.txt": "" });
    const missing = join(root, "supabase", "config.toml");

    const fromPlain = await outcome(() => promiseIo.loadCliConfigFile(missing));
    const fromEffect = await outcome(() => effectIo.loadCliConfigFile(missing));

    expect(fromPlain).toMatchObject({ ok: false, error: { code: "ENOENT", path: missing } });
    expect(fromEffect).toMatchObject({
      ok: false,
      error: {
        _tag: "PlatformError",
        reason: { _tag: "NotFound", pathOrDescriptor: missing },
      },
    });
  });

  test("an env() reference outside any project resolves against nothing in both", async () => {
    vi.stubEnv("PARITY_OUTSIDE", "from-ambient");
    const [effectRoot, plainRoot] = await bothProjects({
      "loose/config.toml": 'project_id = "env(PARITY_OUTSIDE)"\n',
    });

    const fromEffect = await effectIo.loadCliConfigFile(join(effectRoot, "loose", "config.toml"));
    const fromPlain = await promiseIo.loadCliConfigFile(join(plainRoot, "loose", "config.toml"));

    expect(fromPlain.config["project_id"]).toBe(fromEffect.config["project_id"]);
    expect(scrub(fromPlain, plainRoot)).toEqual(scrub(fromEffect, effectRoot));
  });

  const canDenyAccess = process.platform !== "win32" && process.getuid?.() !== 0;

  test.skipIf(!canDenyAccess)(
    "an unreadable project .env is an error in both, not an absent file",
    async () => {
      const files: Files = { ...toml(""), "locked/.env": "PARITY_ID=hidden\n" };
      const [effectRoot, plainRoot] = await bothProjects(files);
      for (const root of [effectRoot, plainRoot]) {
        await symlink(join(root, "locked", ".env"), join(root, "supabase", ".env"));
        await chmod(join(root, "locked"), 0o000);
      }

      try {
        const fromEffect = await outcome(() => effectIo.loadCliConfig(effectRoot));
        const fromPlain = await outcome(() => promiseIo.loadCliConfig(plainRoot));

        expect(fromEffect.ok).toBe(false);
        expect(fromPlain).toMatchObject({ ok: false, error: { code: "EACCES" } });
      } finally {
        for (const root of [effectRoot, plainRoot]) {
          await chmod(join(root, "locked"), 0o755);
        }
      }
    },
  );
});

describe("inferFunctionsManifest parity", () => {
  test("merges discovered functions with config overrides", async () => {
    const files: Files = {
      ...toml(
        '[functions.hello]\nverify_jwt = false\nimport_map = "./custom.json"\n[functions.configured]\nenabled = false\n[functions.ghost]\nenabled = true\n',
      ),
      "supabase/functions/hello/index.ts": "",
      "supabase/functions/hello/deno.json": "{}",
      "supabase/functions/world/index.ts": "",
      "supabase/functions/not-a-function/readme.md": "",
      "supabase/functions/bad name/index.ts": "",
      "supabase/functions/configured/index.ts": "",
    };
    const [effectRoot, plainRoot] = await bothProjects(files);

    const fromEffect = await effectIo.inferFunctionsManifest(effectRoot);
    const fromPlain = await promiseIo.inferFunctionsManifest(plainRoot);

    expect(fromPlain).toEqual(fromEffect);
    expect(Object.keys(fromPlain)).toEqual(Object.keys(fromEffect));
  });

  test("infers functions named after Object.prototype members", async () => {
    const files: Files = {
      ...toml("[functions.toString]\nverify_jwt = false\n"),
      "supabase/functions/constructor/index.ts": "",
      "supabase/functions/toString/index.ts": "",
      "supabase/functions/__proto__/index.ts": "",
    };
    const [effectRoot, plainRoot] = await bothProjects(files);

    const fromEffect = await effectIo.inferFunctionsManifest(effectRoot);
    const fromPlain = await promiseIo.inferFunctionsManifest(plainRoot);

    expect(JSON.stringify(fromPlain)).toBe(JSON.stringify(fromEffect));
    expect(Object.keys(fromPlain)).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.hasOwn(fromPlain, "constructor")).toBe(true);
    expect(fromPlain["constructor"]).toMatchObject({
      enabled: true,
      entrypoint: "./functions/constructor/index.ts",
    });
    expect(fromPlain["toString"]).toMatchObject({ verify_jwt: false });
  });

  test("falls back to the empty config when there is no project", async () => {
    const root = await project({ "supabase/functions/solo/index.ts": "" });

    expect(await promiseIo.inferFunctionsManifest(root)).toEqual(
      await effectIo.inferFunctionsManifest(root),
    );
  });
});

describe("saveCliConfig parity", () => {
  type SaveCase = {
    readonly name: string;
    readonly files: Files;
    readonly load: Files;
    readonly options?: { readonly format?: "json" | "toml"; readonly schemaRef?: string };
    readonly edit?: (config: Record<string, unknown>) => Record<string, unknown>;
    readonly given?: Record<string, unknown>;
  };

  const withPort = (config: Record<string, unknown>): Record<string, unknown> => ({
    ...config,
    api: { ...(config["api"] as Record<string, unknown>), port: 55555 },
  });

  const cases: ReadonlyArray<SaveCase> = [
    { name: "a partial config", files: {}, load: toml(""), given: { api: { port: 7 } } },
    {
      name: "a partial remote",
      files: {},
      load: toml(""),
      given: { remotes: { a: { project_id: "aaaaaaaaaaaaaaaaaaaa", api: { port: 7 } } } },
    },
    {
      name: "a remote with unknown keys",
      files: {},
      load: toml(""),
      given: {
        remotes: {
          a: {
            project_id: "aaaaaaaaaaaaaaaaaaaa",
            bogus: 1,
            api: { port: 7, nope: { deep: true } },
          },
        },
      },
    },
    {
      name: "a remote named outside the key pattern",
      files: {},
      load: toml(""),
      given: {
        remotes: {
          "Bad Name": { project_id: "bbbbbbbbbbbbbbbbbbbb" },
          ok: { project_id: "aaaaaaaaaaaaaaaaaaaa" },
        },
      },
    },
    {
      name: "duplicate migration check exclusions",
      files: {},
      load: toml(""),
      given: {
        db: {
          migrations: { checks: { exclude: { rls_disabled_in_public: ["public.a", "public.a"] } } },
        },
      },
    },
    { name: "a fresh json document", files: {}, load: toml(""), edit: withPort },
    {
      name: "a fresh toml document",
      files: {},
      load: toml(""),
      options: { format: "toml" },
      edit: withPort,
    },
    {
      name: "a schemaRef in json",
      files: {},
      load: toml(""),
      options: { schemaRef: "https://supabase.com/schemas/config/v1.json" },
    },
    {
      name: "a schemaRef in toml",
      files: {},
      load: toml(""),
      options: { format: "toml", schemaRef: "https://supabase.com/schemas/config/v1.json" },
    },
    {
      name: "an existing jsonc with comments",
      files: config(
        "config.jsonc",
        '{\n  // keep me\n  "project_id": "old",\n  "api": { "port": 1 } // trailing\n}\n',
      ),
      load: toml('project_id = "old"\n'),
      edit: withPort,
    },
    {
      name: "an existing toml keeps its #:schema directive",
      files: toml('#:schema https://supabase.com/schemas/config/v1.json\nproject_id = "old"\n'),
      load: toml('project_id = "old"\n'),
      options: { format: "toml" },
      edit: withPort,
    },
    {
      name: "an existing toml saved as json leaves its #:schema directive behind",
      files: toml('#:schema https://supabase.com/schemas/config/v1.json\nproject_id = "old"\n'),
      load: toml('project_id = "old"\n'),
      options: { format: "json" },
    },
    {
      name: "switching format removes the sibling file",
      files: toml('project_id = "old"\n'),
      load: toml('project_id = "old"\n'),
      options: { format: "json" },
    },
    {
      name: "an existing $schema supplies the reference",
      files: config(
        "config.json",
        '{"$schema":"https://supabase.com/schemas/config/v1.json","project_id":"old"}',
      ),
      load: toml('project_id = "old"\n'),
    },
    {
      name: "function overrides and remotes",
      files: {},
      load: toml(
        '[functions.hello]\nverify_jwt = false\n[remotes.a]\nproject_id = "aaaaaaaaaaaaaaaaaaaa"\n[remotes.a.api]\nport = 7\n',
      ),
    },
    {
      name: "a legacy signup key",
      files: {},
      load: toml("[auth.email]\nenable_signup = false\n"),
    },
  ];

  async function snapshot(root: string): Promise<Record<string, string>> {
    const dir = join(root, "supabase");
    const names = (await readdir(dir).catch(() => [])).sort((a, b) => a.localeCompare(b));
    return Object.fromEntries(
      await Promise.all(
        names.map(
          async (name) => [name, await readFile(join(dir, name), "utf8").catch(() => "")] as const,
        ),
      ),
    );
  }

  test.each(cases)("writes $name identically", async ({ files, load, options, edit, given }) => {
    const loaderRoot = await project(load);
    const loaded = await effectIo.loadCliConfig(loaderRoot);
    const base = JSON.parse(JSON.stringify(loaded?.config)) as Record<string, unknown>;
    const config = given ?? (edit === undefined ? base : edit(base));
    const [effectRoot, plainRoot] = await bothProjects(files);

    const savedByEffect = await effectIo.saveCliConfig({
      cwd: effectRoot,
      config: config as never,
      ...options,
    });
    const savedByPlain = await promiseIo.saveCliConfig({ cwd: plainRoot, config, ...options });

    expect(await snapshot(plainRoot)).toEqual(await snapshot(effectRoot));
    expect(scrub(savedByPlain, plainRoot)).toEqual(scrub(savedByEffect, effectRoot));
    const reloaded = await promiseIo.loadCliConfig(plainRoot);
    expect(reloaded?.config).toEqual((await effectIo.loadCliConfig(effectRoot))?.config);
  });

  test("refuses to overwrite a config declaring a newer schema, siblings included", async () => {
    const files: Files = {
      ...config("config.toml", 'project_id = "old"\n'),
      ...config("config.json", '{"$schema":"https://supabase.com/schemas/config/v99.json"}'),
    };
    const [effectRoot, plainRoot] = await bothProjects(files);
    const loaded = await effectIo.loadCliConfig(await project(toml("")));
    const document = JSON.parse(JSON.stringify(loaded?.config)) as Record<string, unknown>;

    const fromEffect = await outcome(() =>
      effectIo.saveCliConfig({ cwd: effectRoot, config: document as never, format: "toml" }),
    );
    const fromPlain = await outcome(() =>
      promiseIo.saveCliConfig({ cwd: plainRoot, config: document, format: "toml" }),
    );

    expect(fromEffect.ok).toBe(false);
    expect(fromPlain.ok).toBe(false);
    if (!fromEffect.ok && !fromPlain.ok) {
      expect(errorShape(fromPlain.error, plainRoot)).toEqual(
        errorShape(fromEffect.error, effectRoot),
      );
    }
  });

  const invalidSaves: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["a wrongly typed port", { api: { port: "not a number" } }],
    [
      "an infinite cpus limit",
      { local: { services: { auth: { container: { cpus: Infinity } } } } },
    ],
    [
      "a negative infinite cpus limit",
      { local: { services: { auth: { container: { cpus: -Infinity } } } } },
    ],
    ["a NaN port", { api: { port: NaN } }],
    ["an explicit null remotes", { remotes: null }],
  ];

  test.each(invalidSaves)("rejects %s without writing it, in both", async (_name, invalid) => {
    const existing = config("config.toml", 'project_id = "old"\n');
    const [effectRoot, plainRoot] = await bothProjects(existing);
    const effectBefore = await snapshot(effectRoot);
    const plainBefore = await snapshot(plainRoot);

    const fromEffect = await outcome(() =>
      effectIo.saveCliConfig({ cwd: effectRoot, config: invalid as never }),
    );
    const fromPlain = await outcome(() =>
      promiseIo.saveCliConfig({ cwd: plainRoot, config: invalid }),
    );

    expect(fromEffect.ok).toBe(false);
    expect(fromPlain).toMatchObject({ ok: false, error: { _tag: "CliConfigParseError" } });
    expect(await snapshot(effectRoot)).toEqual(effectBefore);
    expect(await snapshot(plainRoot)).toEqual(plainBefore);
    expect(Object.keys(plainBefore)).toEqual(["config.toml"]);
  });

  const posixOnly = process.platform === "win32";

  test.skipIf(posixOnly)("keeps the existing file mode", async () => {
    const [effectRoot, plainRoot] = await bothProjects(
      config("config.toml", 'project_id = "old"\n'),
    );
    const document = { project_id: "new" };
    for (const root of [effectRoot, plainRoot]) {
      await chmod(join(root, "supabase", "config.toml"), 0o600);
    }

    await effectIo.saveCliConfig({ cwd: effectRoot, config: document as never, format: "toml" });
    await promiseIo.saveCliConfig({ cwd: plainRoot, config: document, format: "toml" });

    const modes = await Promise.all(
      [effectRoot, plainRoot].map(
        async (root) => (await stat(join(root, "supabase", "config.toml"))).mode & 0o777,
      ),
    );
    expect(modes).toEqual([0o600, 0o600]);
  });

  test.skipIf(posixOnly)(
    "keeps group-writable bits that the process umask would strip",
    async () => {
      const plainRoot = await project(config("config.toml", 'project_id = "old"\n'));
      const target = join(plainRoot, "supabase", "config.toml");
      await chmod(target, 0o664);
      const previousUmask = process.umask(0o022);

      try {
        await promiseIo.saveCliConfig({
          cwd: plainRoot,
          config: { project_id: "new" },
          format: "toml",
        });
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(target)).mode & 0o777).toBe(0o664);
    },
  );

  test.skipIf(posixOnly)("carries a private config's mode across a format switch", async () => {
    const plainRoot = await project(config("config.toml", 'project_id = "old"\n'));
    await chmod(join(plainRoot, "supabase", "config.toml"), 0o600);

    const saved = await promiseIo.saveCliConfig({
      cwd: plainRoot,
      config: { project_id: "new" },
      format: "json",
    });

    expect(saved.path).toBe(join(plainRoot, "supabase", "config.json"));
    expect((await stat(saved.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(join(plainRoot, "supabase"))).toEqual(["config.json"]);
  });

  test("refuses to save when json and jsonc both exist", async () => {
    const files: Files = { ...config("config.json", "{}"), ...config("config.jsonc", "{}") };
    const [effectRoot, plainRoot] = await bothProjects(files);
    const document = { project_id: "x" };

    const fromEffect = await outcome(() =>
      effectIo.saveCliConfig({ cwd: effectRoot, config: document as never }),
    );
    const fromPlain = await outcome(() =>
      promiseIo.saveCliConfig({ cwd: plainRoot, config: document }),
    );

    expect(fromEffect.ok).toBe(false);
    expect(fromPlain.ok).toBe(false);
    if (!fromEffect.ok && !fromPlain.ok) {
      expect(errorShape(fromPlain.error, plainRoot)).toEqual(
        errorShape(fromEffect.error, effectRoot),
      );
    }
  });
});

describe("plain error classes", () => {
  test("carry the same tags and messages as the Effect errors", async () => {
    const files = toml("[inbucket]\nenabled = true\n");
    const [effectRoot, plainRoot] = await bothProjects(files);

    const fromEffect = await outcome(() => effectIo.loadCliConfig(effectRoot));
    const fromPlain = await outcome(() => promiseIo.loadCliConfig(plainRoot));

    expect(fromEffect.ok || fromPlain.ok).toBe(false);
    if (!fromEffect.ok && !fromPlain.ok) {
      expect(fromPlain.error).toBeInstanceOf(promiseIo.CliConfigRemovedKeyError);
      expect(fromPlain.error["_tag"]).toBe(fromEffect.error["_tag"]);
      expect(fromPlain.error.message).toBe(fromEffect.error.message);
      expect(fromPlain.error["suggestion"]).toBe(fromEffect.error["suggestion"]);
    }
  });
});
