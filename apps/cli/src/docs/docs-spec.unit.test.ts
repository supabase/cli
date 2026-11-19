import { BunServices } from "@effect/platform-bun";
import { beforeAll, describe, expect, it } from "@effect/vitest";
import { Config, Effect, FileSystem, Path } from "effect";
import { FlagDocumentation } from "../command-internal/flag-documentation.ts";
import { Command, Flag } from "effect/cli";

import { ExperimentalFlag } from "../command-internal/global-flags.ts";
import { hostedRemoteFlag, remoteFlag } from "../../tests/helpers/remote-flag-fixture.ts";

import { rootCommand } from "../cli/root.ts";
import { readDocsContent, type DocsContent } from "./docs-spec.content.ts";
import {
  buildDocsSpec,
  docsFlagDoc,
  docsOverlayPath,
  docsStripOverlayHeading,
  stringifyDocsSpec,
} from "./docs-spec.ts";
import type { DocsCommand } from "./docs-spec.ts";

interface BuiltSpecFixture {
  readonly content: DocsContent;
  readonly spec: ReturnType<typeof buildDocsSpec>;
  readonly byId: ReadonlyMap<string, DocsCommand>;
}

let builtSpecCache: BuiltSpecFixture | undefined;
let docsContentCache: DocsContent | undefined;

const loadDocsContent = Effect.gen(function* () {
  if (docsContentCache === undefined) {
    const path = yield* Path.Path;
    docsContentCache = yield* readDocsContent(path.resolve(import.meta.dirname, "../../docs"));
  }
  return docsContentCache;
}).pipe(Effect.provide(BunServices.layer));

/** Lazily built once, so runs filtered to the pure helpers skip the tree walk and disk reads. */
function builtSpec(): BuiltSpecFixture {
  if (builtSpecCache === undefined) {
    const content = docsContentCache;
    if (content === undefined) throw new Error("builtSpec() needs loadDocsContent to run first");
    const spec = buildDocsSpec({
      root: rootCommand,
      version: "1.2.3",
      overlays: content.overlays,
    });
    builtSpecCache = {
      content,
      spec,
      byId: new Map(spec.commands.map((command) => [command.id, command])),
    };
  }
  return builtSpecCache;
}

describe("docsOverlayPath", () => {
  it("maps shallow command paths one directory per word", () => {
    expect(docsOverlayPath(["supabase", "link"])).toBe("supabase/link.md");
    expect(docsOverlayPath(["supabase", "db", "push"])).toBe("supabase/db/push.md");
  });

  it("flattens paths deeper than three words into a dash-joined tail", () => {
    expect(docsOverlayPath(["supabase", "inspect", "db", "bloat"])).toBe(
      "supabase/inspect/db-bloat.md",
    );
    expect(docsOverlayPath(["supabase", "db", "schema", "declarative", "sync"])).toBe(
      "supabase/db/schema-declarative-sync.md",
    );
  });
});

describe("docsStripOverlayHeading", () => {
  it("drops a leading heading line but keeps its newline", () => {
    expect(docsStripOverlayHeading("## supabase-link\n\nBody text.\n")).toBe("\n\nBody text.\n");
  });

  it("returns empty for a heading-only file", () => {
    expect(docsStripOverlayHeading("## supabase-link")).toBe("");
  });

  it("keeps content that does not start with a heading", () => {
    expect(docsStripOverlayHeading("Creates a resource.\nMore.\n")).toBe(
      "Creates a resource.\nMore.\n",
    );
  });
});

describe("docsFlagDoc", () => {
  it.each([
    [Flag.String("value").pipe(Flag.withDefault("custom")), "custom"],
    [Flag.Int("value").pipe(Flag.withDefault(42)), "42"],
    [Flag.String("value").pipe(Flag.withDefault("inner"), Flag.withDefault("outer")), "inner"],
    [
      Flag.String("value").pipe(
        Flag.withDefault("inner"),
        Flag.withDefault(Effect.die("must not execute")),
      ),
      "inner",
    ],
    [Flag.Boolean("value").pipe(Flag.withDefault(true)), "true"],
    [Flag.String("value").pipe(Flag.atLeast(0), Flag.withDefault(["public"])), '["public"]'],
    [
      Flag.String("value").pipe(
        Flag.withDefault("30m"),
        Flag.map((value) => value.length),
      ),
      "30m",
    ],
  ])("derives literal defaults without parsing: %s", (flag, expected) => {
    expect(docsFlagDoc(["supabase", "fixture"], flag)?.default_value).toBe(expected);
    expect(docsFlagDoc(["supabase", "fixture"], flag)?.required).toBeUndefined();
  });

  it("keeps per-occurrence defaults out of collection documentation", () => {
    const flag = Flag.String("value").pipe(Flag.withDefault("first"), Flag.atLeast(2));
    expect(docsFlagDoc(["supabase", "fixture"], flag)).toMatchObject({
      required: true,
      default_value: "[]",
    });
  });

  it("does not run effectful defaults or config lookups to build docs", () => {
    const flags = [
      Flag.String("value").pipe(
        Flag.withDefault(Effect.die("must not execute")),
        Flag.withDefault("outer"),
      ),
      Flag.String("value").pipe(Flag.withFallbackConfig(Config.String("DOCS_SECRET"))),
    ];
    for (const flag of flags) {
      expect(docsFlagDoc(["supabase", "fixture"], flag)).toMatchObject({ default_value: "" });
      expect(docsFlagDoc(["supabase", "fixture"], flag)?.required).toBeUndefined();
    }
  });

  it.each([
    [Flag.String("value"), true],
    [Flag.Boolean("value"), undefined],
    [Flag.Boolean("value").pipe(Flag.atLeast(2)), true],
    [Flag.Boolean("value").pipe(Flag.annotate(FlagDocumentation, { required: true })), true],
    [Flag.String("value").pipe(Flag.optional), undefined],
    [Flag.String("value").pipe(Flag.atLeast(0)), undefined],
    [Flag.String("value").pipe(Flag.atLeast(2)), true],
    [Flag.String("value").pipe(Flag.withDefault("first"), Flag.atLeast(2)), true],
  ])("derives required badges from flag cardinality: %s", (flag, required) => {
    expect(docsFlagDoc(["supabase", "fixture"], flag)?.required).toBe(required);
  });

  it("reads website exceptions from flag-local annotations", () => {
    const flag = Flag.Literals("value", ["a", "b"]).pipe(
      Flag.optional,
      Flag.annotate(FlagDocumentation, { defaultValue: "a", required: true, choices: ["a"] }),
    );
    expect(docsFlagDoc(["supabase", "fixture"], flag)).toMatchObject({
      default_value: "a",
      required: true,
      accepted_values: [{ id: "a", name: "a", type: "[ a ]" }],
    });
    expect(docsFlagDoc(["supabase", "fixture"], flag.pipe(Flag.withHidden))).toBeUndefined();
  });

  it("renders --remote with the value hint its declaration carries", () => {
    const doc = docsFlagDoc(["supabase", "db", "push"], remoteFlag);

    expect(doc?.name).toBe("--remote[=<ref|branch|url>]");
    expect(doc?.id).toBe("remote");
  });

  it("renders the narrower hint of a hosted command's --remote", () => {
    expect(docsFlagDoc(["supabase", "functions", "deploy"], hostedRemoteFlag)?.name).toBe(
      "--remote[=<ref|branch>]",
    );
  });
});

describe("buildDocsSpec", () => {
  beforeAll(() => Effect.runPromise(Effect.asVoid(loadDocsContent)));

  it("never publishes an unlisted command subtree", () => {
    // Walks the tree rather than matching a `supabase-experimental*` prefix, so it also
    // catches any other unlisted subtree, present or future.
    const { spec } = builtSpec();
    const emitted = new Set(spec.commands.map((command) => command.id));

    const hidden: Array<string> = [];
    const walk = (command: unknown, prefix: ReadonlyArray<string>, unlisted: boolean): void => {
      const node = command as {
        readonly name: string;
        readonly unlisted?: boolean;
        readonly subcommands?: ReadonlyArray<{ readonly commands?: ReadonlyArray<unknown> }>;
      };
      const here = prefix.length === 0 && node.name === "supabase" ? [] : [...prefix, node.name];
      // Unlisted is inherited: hiding a parent hides everything beneath it.
      const hiddenHere = unlisted || node.unlisted === true;
      if (hiddenHere && here.length > 0) {
        hidden.push(`supabase-${here.join("-")}`);
      }
      for (const group of node.subcommands ?? []) {
        for (const child of group.commands ?? []) {
          walk(child, here, hiddenHere);
        }
      }
    };
    walk(rootCommand, [], false);

    // Guards the guard: if the walk found nothing, the assertion below is vacuous.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((id) => emitted.has(id))).toEqual([]);
  });

  it("emits the clispec envelope with the requested version", () => {
    const { spec } = builtSpec();
    expect(spec.clispec).toBe("001");
    expect(spec.info.id).toBe("cli");
    expect(spec.info.version).toBe("1.2.3");
  });

  it("excludes gated Compute and Stack commands from the default docs spec", () => {
    const { spec } = builtSpec();
    const computeCommands = spec.commands.filter((command) =>
      command.id.startsWith("supabase-compute"),
    );
    expect(computeCommands).toEqual([]);
    const stackCommands = spec.commands.filter((command) =>
      command.id.startsWith("supabase-stack"),
    );
    expect(stackCommands).toEqual([]);
  });

  it("keeps every load-bearing per-command field shape", () => {
    const { spec } = builtSpec();
    for (const command of spec.commands) {
      expect(command.id).toBe(command.title.replaceAll(" ", "-"));
      expect(Array.isArray(command.tags)).toBe(true);
      expect(Array.isArray(command.links)).toBe(true);
      expect(Array.isArray(command.subcommands)).toBe(true);
      expect(Array.isArray(command.flags)).toBe(true);
      for (const flag of command.flags) {
        expect(typeof flag.default_value).toBe("string");
        expect(flag.name.includes(`--${flag.id}`)).toBe(true);
      }
    }
  });

  it("excludes deprecated commands from the spec and from subcommand lists", () => {
    const { byId } = builtSpec();
    for (const excluded of [
      "supabase-inspect-db-cache-hit",
      "supabase-inspect-db-index-sizes",
      "supabase-inspect-db-index-usage",
      "supabase-inspect-db-role-configs",
      "supabase-inspect-db-role-connections",
      "supabase-inspect-db-seq-scans",
      "supabase-inspect-db-table-record-counts",
      "supabase-inspect-db-table-sizes",
      "supabase-inspect-db-unused-indexes",
    ]) {
      expect(byId.has(excluded)).toBe(false);
    }
    expect(byId.get("supabase-gen")?.subcommands).not.toContain("supabase-gen-keys");
    expect(byId.get("supabase-inspect-db")?.subcommands).not.toContain(
      "supabase-inspect-db-cache-hit",
    );
  });

  it("includes the TS-only completion and issue families", () => {
    const { byId } = builtSpec();
    expect(byId.get("supabase-completion")?.subcommands).toContain("supabase-completion-zsh");
    expect(byId.get("supabase-issue")?.subcommands).toContain("supabase-issue-bug");
  });

  it("includes the top-level whoami command in the Management API reference", () => {
    const whoami = builtSpec().byId.get("supabase-whoami");
    expect(whoami).toBeDefined();
    expect(whoami?.usage).toBe("supabase whoami [flags]");
    expect(whoami?.subcommands).toEqual([]);
    expect(whoami?.description).toBe("Show information about the currently logged-in user.");
  });

  it("lists the stack selector a leaf registers as its own global flag", () => {
    const { byId } = builtSpec();
    for (const id of ["supabase-db-reset", "supabase-migration-up", "supabase-gen-types"]) {
      const flagIds = byId.get(id)?.flags.map((flag) => flag.id) ?? [];
      expect(flagIds, id).toContain("stack");
    }
  });

  it("renders link with its overlay description and flag display names", () => {
    const { byId, content } = builtSpec();
    const link = byId.get("supabase-link");
    expect(link).toBeDefined();
    expect(link?.usage).toBe("supabase link [ref-or-branch] [flags]");
    expect(link?.flags.map((flag) => flag.id)).toEqual(["project-ref", "skip-pooler"]);
    expect(link?.description).toBe(
      docsStripOverlayHeading(content.overlays.get("supabase/link.md") ?? ""),
    );
    expect(content.overlays.has("supabase/db/diff.md")).toBe(true);
    expect(byId.get("supabase-db-diff")?.description).toBe(
      docsStripOverlayHeading(content.overlays.get("supabase/db/diff.md") ?? ""),
    );
  });

  it("injects the required --experimental flag into experimental leaves only", () => {
    const { byId } = builtSpec();
    const requiredCommands = [
      "network-bans-get",
      "network-bans-remove",
      "network-restrictions-get",
      "network-restrictions-update",
      "postgres-config-delete",
      "postgres-config-get",
      "postgres-config-update",
      "ssl-enforcement-get",
      "ssl-enforcement-update",
      "storage-cp",
      "storage-ls",
      "storage-mv",
      "storage-rm",
      "vanity-subdomains-activate",
      "vanity-subdomains-check-availability",
      "vanity-subdomains-delete",
      "vanity-subdomains-get",
    ];
    for (const command of requiredCommands) {
      expect(
        byId.get(`supabase-${command}`)?.flags.find((flag) => flag.id === "experimental"),
      ).toMatchObject({ required: true, default_value: "false" });
    }
    const experimental = byId
      .get("supabase-storage-ls")
      ?.flags.find((flag) => flag.id === "experimental");
    expect(experimental).toMatchObject({ required: true, default_value: "false" });
    expect(Object.keys(experimental ?? {})).toEqual([
      "id",
      "name",
      "description",
      "required",
      "default_value",
    ]);
    expect(byId.get("supabase-db-push")?.flags.some((flag) => flag.id === "experimental")).toBe(
      false,
    );
    for (const leaf of ["generate", "sync"]) {
      const experimental = byId
        .get(`supabase-db-schema-declarative-${leaf}`)
        ?.flags.find((flag) => flag.id === "experimental");
      expect(experimental).toMatchObject({ default_value: "false" });
      expect(experimental?.required).toBeUndefined();
    }
    expect(
      byId.get("supabase-projects-create")?.flags.some((flag) => flag.id === "experimental"),
    ).toBe(false);
  });

  it("emits enum flags with accepted_values and defaults", () => {
    const { byId } = builtSpec();
    const algorithm = byId
      .get("supabase-gen-signing-key")
      ?.flags.find((flag) => flag.id === "algorithm");
    expect(algorithm?.name).toBe("--algorithm <[ ES256 | RS256 ]>");
    expect(algorithm?.default_value).toBe("ES256");
    expect(algorithm?.accepted_values?.map((value) => value.id)).toEqual(["ES256", "RS256"]);
  });

  it("marks required flags with a required badge", () => {
    const { byId } = builtSpec();
    const status = byId
      .get("supabase-migration-repair")
      ?.flags.find((flag) => flag.id === "status");
    expect(status?.required).toBe(true);
  });

  it("renders flag display types from the Effect tree, matching --help", () => {
    const { byId } = builtSpec();
    const jobs = byId.get("supabase-functions-deploy")?.flags.find((flag) => flag.id === "jobs");
    expect(jobs?.name).toBe("-j, --jobs <int>");
    const validFor = byId
      .get("supabase-gen-bearer-jwt")
      ?.flags.find((flag) => flag.id === "valid-for");
    expect(validFor?.name).toBe("--valid-for <string>");
  });

  it("keeps flags off group commands but always as an array", () => {
    const { byId } = builtSpec();
    const db = byId.get("supabase-db");
    expect(db?.flags).toEqual([]);
    expect(db?.usage).toBeUndefined();
    expect(db?.subcommands).toContain("supabase-db-push");
  });

  it("publishes command examples without sample responses", () => {
    const { byId, spec } = builtSpec();
    expect(byId.get("supabase-snippets-list")?.examples).toEqual([
      {
        id: "example-1",
        name: "List all SQL snippets",
        code: "supabase snippets list",
      },
      {
        id: "example-2",
        name: "List snippets for a specific project",
        code: "supabase snippets list --remote=<ref>",
      },
    ]);
    for (const command of spec.commands) {
      const ids = command.examples?.map((example) => example.id) ?? [];
      expect(new Set(ids).size).toBe(ids.length);
      for (const example of command.examples ?? []) {
        expect(example.id.trim()).not.toBe("");
        expect(example.name.trim()).not.toBe("");
        expect(example.code.trim()).not.toBe("");
        expect(example).not.toHaveProperty("response");
      }
    }
  });

  it("documents db query's output formats via the injected flag", () => {
    const { byId } = builtSpec();
    const output = byId.get("supabase-db-query")?.flags.find((flag) => flag.id === "output");
    expect(output?.name).toBe("-o, --output <[ json | table | csv ]>");
    expect(output?.default_value).toBe("json");
    expect(output?.accepted_values?.map((value) => value.id)).toEqual(["json", "table", "csv"]);
  });

  it.each(["supabase-logs", "supabase-logs-sources"])(
    "keeps legacy output off the native logs %s page",
    (id) => {
      const command = builtSpec().byId.get(id);
      expect(command).toBeDefined();
      expect(command?.flags.some((flag) => flag.id === "output")).toBe(false);
    },
  );

  it("documents the executable logs root alongside its source catalog", () => {
    const { byId } = builtSpec();
    const logs = byId.get("supabase-logs");
    expect(logs?.usage).toBe("supabase logs [subcommand] [flags]");
    expect(logs?.flags.map((flag) => flag.id)).toEqual(
      expect.arrayContaining(["sql", "file", "limit", "since", "from", "to", "service"]),
    );
    expect(byId.has("supabase-logs-sources")).toBe(true);
    expect(byId.has("supabase-logs-query")).toBe(false);
    expect(byId.has("supabase-logs-tail")).toBe(false);
  });

  it("quotes YAML 1.1 boolean-like scalars in the serialized spec", () => {
    const { spec } = builtSpec();
    const yaml = stringifyDocsSpec(spec);
    expect(yaml).toContain('id: "yes"');
    expect(yaml).not.toMatch(/^\s+- id: yes$/m);
  });

  it("exposes the root global flags including the TS-only --output-format", () => {
    const { spec } = builtSpec();
    const rootFlagIds = spec.flags.map((flag) => flag.id);
    expect(rootFlagIds).toContain("help");
    expect(rootFlagIds).toContain("experimental");
    expect(rootFlagIds).toContain("output-format");
    const output = spec.flags.find((flag) => flag.id === "output");
    expect(output?.default_value).toBe("pretty");
    expect(output?.accepted_values?.map((value) => value.id)).toEqual([
      "env",
      "pretty",
      "json",
      "toml",
      "yaml",
    ]);
    expect(spec.flags.find((flag) => flag.id === "output-format")?.default_value).toBe("text");
  });
});

describe("review fixes stay fixed", () => {
  it("does not publish the removed --include-raw-output on any domains page", () => {
    const { spec, byId } = builtSpec();
    for (const command of spec.commands) {
      expect(
        command.flags.some((flag) => flag.id === "include-raw-output"),
        `${command.id} publishes include-raw-output`,
      ).toBe(false);
    }
    expect(byId.get("supabase-domains-get")?.flags.map((flag) => flag.id)).toContain("remote");
  });

  it("renders required variadic usage from the override table", () => {
    const { byId } = builtSpec();
    expect(byId.get("supabase-storage-rm")?.usage).toBe("supabase storage rm <file> ... [flags]");
    expect(byId.get("supabase-secrets-set")?.usage).toBe(
      "supabase secrets set <NAME=VALUE> ... [flags]",
    );
  });

  it("normalizes tabs to four spaces in descriptions", () => {
    const { spec } = builtSpec();
    for (const command of spec.commands) {
      expect(command.description.includes("\t"), `${command.id} description has a tab`).toBe(false);
      for (const flag of command.flags) {
        expect(flag.description.includes("\t"), `${command.id} --${flag.id} has a tab`).toBe(false);
      }
    }
    expect(byIdDescription("supabase-completion-bash")).toContain("    source <(");
  });

  it("serializes without YAML anchors or aliases", () => {
    const { spec } = builtSpec();
    const yaml = stringifyDocsSpec(spec);
    expect(yaml).not.toMatch(/&a\d+/);
    expect(yaml).not.toMatch(/\*a\d+/);
  });

  beforeAll(() => Effect.runPromise(Effect.asVoid(loadDocsContent)));
});

function byIdDescription(id: string): string {
  const command = builtSpec().byId.get(id);
  if (command === undefined) throw new Error(`no command ${id}`);
  return command.description;
}

describe("build guards fail loudly", () => {
  const emptyInput = { version: "0", overlays: new Map<string, string>() };

  it.each([
    { command: " ", description: "Run link" },
    { command: "supabase link", description: " " },
  ])("rejects empty example fields: %j", (example) => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([Command.make("link").pipe(Command.withExamples([example]))]),
      Command.withGlobalFlags([ExperimentalFlag]),
    );
    expect(() => buildDocsSpec({ root, ...emptyInput })).toThrow(
      '"supabase-link" example-1 must have nonempty name and code',
    );
  });

  it("throws when the root declares no --experimental global flag", () => {
    const root = Command.make("supabase").pipe(Command.withSubcommands([Command.make("link")]));
    expect(() => buildDocsSpec({ root, ...emptyInput })).toThrow(/no --experimental global flag/);
  });

  it("throws listing stale static-table entries for a shrunken tree", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([Command.make("link")]),
      Command.withGlobalFlags([ExperimentalFlag]),
    );
    expect(() => buildDocsSpec({ root, ...emptyInput })).toThrow(
      /stale static-table entries[^]*DOCS_EXTRA_FLAGS/,
    );
  });

  it("throws when a declared flag shadows an extra-flags table entry", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([
        Command.make("db").pipe(
          Command.withSubcommands([Command.make("query", { output: Flag.String("output") })]),
        ),
      ]),
      Command.withGlobalFlags([ExperimentalFlag]),
    );
    expect(() => buildDocsSpec({ root, ...emptyInput })).toThrow(
      /DOCS_EXTRA_FLAGS entry "supabase-db-query" is shadowed by declared flag\(s\) --output/,
    );
  });

  it.effect("throws for orphaned overlays", () =>
    Effect.gen(function* () {
      const content = yield* loadDocsContent;
      const overlays = new Map(content.overlays);
      overlays.set("supabase/not-a-real-command.md", "## x\n\nBody.\n");
      expect(() => buildDocsSpec({ root: rootCommand, version: "0", overlays })).toThrow(
        /content inputs match no command[^]*overlay: "supabase\/not-a-real-command\.md"/,
      );
    }),
  );
});

describe("readDocsContent walk", () => {
  it.effect("does not walk symlinked directories or link loops", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "docs-spec-test-" });
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "docs-spec-test-" });
      yield* fs.makeDirectory(path.join(dir, "supabase"), { recursive: true });
      yield* fs.writeFileString(path.join(dir, "supabase", "link.md"), "## supabase-link\n");
      yield* fs.writeFileString(path.join(outside, "outside.md"), "## outside\n");
      yield* fs.symlink(outside, path.join(dir, "supabase", "linked"));
      yield* fs.symlink("..", path.join(dir, "supabase", "up"));
      const content = yield* readDocsContent(dir);
      expect([...content.overlays.keys()]).toEqual(["supabase/link.md"]);
    }).pipe(Effect.scoped, Effect.provide(BunServices.layer)),
  );
});
