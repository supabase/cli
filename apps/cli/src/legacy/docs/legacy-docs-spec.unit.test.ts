import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command, Flag } from "effect/unstable/cli";
import { describe, expect, it } from "vitest";

import { LegacyExperimentalFlag } from "../../shared/legacy/global-flags.ts";

import { legacyRoot } from "../cli/root.ts";
import { legacyReadDocsContent } from "./legacy-docs-spec.content.ts";
import {
  legacyBuildDocsSpec,
  legacyDocsOverlayPath,
  legacyDocsStripOverlayHeading,
  legacyStringifyDocsSpec,
} from "./legacy-docs-spec.ts";
import type { LegacyDocsCommand } from "./legacy-docs-spec.ts";
import { LEGACY_DOCS_EXCLUDED, LEGACY_DOCS_EXPERIMENTAL } from "./legacy-docs-spec.tables.ts";

interface LegacyBuiltSpecFixture {
  readonly content: ReturnType<typeof legacyReadDocsContent>;
  readonly spec: ReturnType<typeof legacyBuildDocsSpec>;
  readonly byId: ReadonlyMap<string, LegacyDocsCommand>;
}

let legacyBuiltSpecCache: LegacyBuiltSpecFixture | undefined;

/** Lazily built once, so runs filtered to the pure helpers skip the tree walk and disk reads. */
function legacyBuiltSpec(): LegacyBuiltSpecFixture {
  if (legacyBuiltSpecCache === undefined) {
    const content = legacyReadDocsContent(path.resolve(import.meta.dirname, "../../../docs"));
    const spec = legacyBuildDocsSpec({
      root: legacyRoot,
      version: "1.2.3",
      overlays: content.overlays,
      examples: content.examples,
    });
    legacyBuiltSpecCache = {
      content,
      spec,
      byId: new Map(spec.commands.map((command) => [command.id, command])),
    };
  }
  return legacyBuiltSpecCache;
}

describe("legacyDocsOverlayPath", () => {
  it("maps shallow command paths one directory per word", () => {
    expect(legacyDocsOverlayPath(["supabase", "link"])).toBe("supabase/link.md");
    expect(legacyDocsOverlayPath(["supabase", "db", "push"])).toBe("supabase/db/push.md");
  });

  it("flattens paths deeper than three words into a dash-joined tail", () => {
    expect(legacyDocsOverlayPath(["supabase", "inspect", "db", "bloat"])).toBe(
      "supabase/inspect/db-bloat.md",
    );
    expect(legacyDocsOverlayPath(["supabase", "db", "schema", "declarative", "sync"])).toBe(
      "supabase/db/schema-declarative-sync.md",
    );
  });
});

describe("legacyDocsStripOverlayHeading", () => {
  it("drops a leading heading line but keeps its newline", () => {
    expect(legacyDocsStripOverlayHeading("## supabase-link\n\nBody text.\n")).toBe(
      "\n\nBody text.\n",
    );
  });

  it("returns empty for a heading-only file", () => {
    expect(legacyDocsStripOverlayHeading("## supabase-link")).toBe("");
  });

  it("keeps content that does not start with a heading", () => {
    expect(legacyDocsStripOverlayHeading("Creates a resource.\nMore.\n")).toBe(
      "Creates a resource.\nMore.\n",
    );
  });
});

describe("legacyBuildDocsSpec", () => {
  it("never publishes an unlisted command subtree", () => {
    // The guarantee is that `Command.unlisted` keeps a family out of the public
    // docs reference. Nothing pinned it, for the `experimental` family or for the
    // older `db test|branch|remote` precedent, so a future refactor could quietly
    // start publishing them.
    //
    // Derived from the tree rather than matching a `supabase-experimental*`
    // prefix, so it covers every unlisted subtree that exists now or later.
    const { spec } = legacyBuiltSpec();
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
    walk(legacyRoot, [], false);

    // Guards the guard: if the walk found nothing, the assertion below is vacuous.
    expect(hidden.length).toBeGreaterThan(0);
    expect(hidden.filter((id) => emitted.has(id))).toEqual([]);
  });

  it("emits the clispec envelope with the requested version", () => {
    const { spec } = legacyBuiltSpec();
    expect(spec.clispec).toBe("001");
    expect(spec.info.id).toBe("cli");
    expect(spec.info.version).toBe("1.2.3");
    expect(spec.info.tags.map((tag) => tag.id)).toEqual([
      "quick-start",
      "local-dev",
      "management-api",
      "other-commands",
    ]);
  });

  it("keeps every load-bearing per-command field shape", () => {
    const { spec } = legacyBuiltSpec();
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

  it("excludes Go-deprecated commands from the spec and from subcommand lists", () => {
    const { byId } = legacyBuiltSpec();
    for (const excluded of LEGACY_DOCS_EXCLUDED) {
      expect(byId.has(excluded)).toBe(false);
    }
    expect(byId.get("supabase-gen")?.subcommands).not.toContain("supabase-gen-keys");
    expect(byId.get("supabase-inspect-db")?.subcommands).not.toContain(
      "supabase-inspect-db-cache-hit",
    );
  });

  it("includes the TS-only completion and issue families", () => {
    const { byId } = legacyBuiltSpec();
    expect(byId.get("supabase-completion")?.subcommands).toContain("supabase-completion-zsh");
    expect(byId.get("supabase-issue")?.tags).toEqual(["other-commands"]);
  });

  it("renders link with its overlay description and flag display names", () => {
    const { byId, content } = legacyBuiltSpec();
    const link = byId.get("supabase-link");
    expect(link).toBeDefined();
    expect(link?.tags).toEqual(["local-dev"]);
    expect(link?.usage).toBe("supabase link [ref-or-branch] [flags]");
    expect(link?.flags.map((flag) => flag.id)).toEqual(["password", "project-ref", "skip-pooler"]);
    expect(link?.flags.find((flag) => flag.id === "password")?.name).toBe(
      "-p, --password <string>",
    );
    expect(link?.description).toBe(
      legacyDocsStripOverlayHeading(content.overlays.get("supabase/link.md") ?? ""),
    );
  });

  it("injects the required --experimental flag into experimental leaves only", () => {
    const { byId } = legacyBuiltSpec();
    const storageLs = byId.get("supabase-storage-ls");
    const experimental = storageLs?.flags.find((flag) => flag.id === "experimental");
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
    const declarativeSync = byId
      .get("supabase-db-schema-declarative-sync")
      ?.flags.find((flag) => flag.id === "experimental");
    expect(declarativeSync).toBeDefined();
    expect(declarativeSync?.required).toBeUndefined();
  });

  it("emits enum flags with accepted_values and defaults", () => {
    const { byId } = legacyBuiltSpec();
    const algorithm = byId
      .get("supabase-gen-signing-key")
      ?.flags.find((flag) => flag.id === "algorithm");
    expect(algorithm?.name).toBe("--algorithm <[ ES256 | RS256 ]>");
    expect(algorithm?.default_value).toBe("ES256");
    expect(algorithm?.accepted_values?.map((value) => value.id)).toEqual(["ES256", "RS256"]);
  });

  it("marks required flags with a required badge", () => {
    const { byId } = legacyBuiltSpec();
    const status = byId
      .get("supabase-migration-repair")
      ?.flags.find((flag) => flag.id === "status");
    expect(status?.required).toBe(true);
  });

  it("renders flag display types from the Effect tree, matching --help", () => {
    const { byId } = legacyBuiltSpec();
    const jobs = byId.get("supabase-functions-deploy")?.flags.find((flag) => flag.id === "jobs");
    expect(jobs?.name).toBe("-j, --jobs <int>");
    const validFor = byId
      .get("supabase-gen-bearer-jwt")
      ?.flags.find((flag) => flag.id === "valid-for");
    expect(validFor?.name).toBe("--valid-for <string>");
  });

  it("keeps flags off group commands but always as an array", () => {
    const { byId } = legacyBuiltSpec();
    const db = byId.get("supabase-db");
    expect(db?.flags).toEqual([]);
    expect(db?.usage).toBeUndefined();
    expect(db?.subcommands).toContain("supabase-db-push");
  });

  it("sources examples from examples.yaml, falling back to Command.withExamples", () => {
    const { byId } = legacyBuiltSpec();
    const initExamples = byId.get("supabase-init")?.examples;
    expect(initExamples?.[0]).toMatchObject({ id: "basic-usage", code: "supabase init" });
    const snippetsExamples = byId.get("supabase-snippets-list")?.examples;
    expect(snippetsExamples?.length).toBeGreaterThan(0);
    expect(snippetsExamples?.[0]?.id).toBe("example-1");
    expect(snippetsExamples?.[0]?.response).toBeUndefined();
  });

  it("documents db query's output formats via the injected flag", () => {
    const { byId } = legacyBuiltSpec();
    const output = byId.get("supabase-db-query")?.flags.find((flag) => flag.id === "output");
    expect(output?.name).toBe("-o, --output <[ json | table | csv ]>");
    expect(output?.default_value).toBe("json");
    expect(output?.accepted_values?.map((value) => value.id)).toEqual(["json", "table", "csv"]);
  });

  it("quotes YAML 1.1 boolean-like scalars in the serialized spec", () => {
    const { spec } = legacyBuiltSpec();
    const yaml = legacyStringifyDocsSpec(spec);
    expect(yaml).toContain('id: "yes"');
    expect(yaml).not.toMatch(/^\s+- id: yes$/m);
  });

  it("exposes the root global flags including the TS-only --output-format", () => {
    const { spec } = legacyBuiltSpec();
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
  it("excludes the deprecated --include-raw-output from every domains page", () => {
    const { spec, byId } = legacyBuiltSpec();
    for (const command of spec.commands) {
      expect(
        command.flags.some((flag) => flag.id === "include-raw-output"),
        `${command.id} publishes include-raw-output`,
      ).toBe(false);
    }
    expect(byId.get("supabase-domains-get")?.flags.map((flag) => flag.id)).toContain("project-ref");
  });

  it("renders required variadic usage from the override table", () => {
    const { byId } = legacyBuiltSpec();
    expect(byId.get("supabase-storage-rm")?.usage).toBe("supabase storage rm <file> ... [flags]");
    expect(byId.get("supabase-secrets-set")?.usage).toBe(
      "supabase secrets set <NAME=VALUE> ... [flags]",
    );
  });

  it("normalizes tabs to four spaces in descriptions", () => {
    const { spec } = legacyBuiltSpec();
    for (const command of spec.commands) {
      expect(command.description.includes("\t"), `${command.id} description has a tab`).toBe(false);
      for (const flag of command.flags) {
        expect(flag.description.includes("\t"), `${command.id} --${flag.id} has a tab`).toBe(false);
      }
    }
    expect(byIdDescription("supabase-completion-bash")).toContain("    source <(");
  });

  it("serializes without YAML anchors or aliases", () => {
    const { spec } = legacyBuiltSpec();
    const yaml = legacyStringifyDocsSpec(spec);
    expect(yaml).not.toMatch(/&a\d+/);
    expect(yaml).not.toMatch(/\*a\d+/);
  });
});

function byIdDescription(id: string): string {
  const command = legacyBuiltSpec().byId.get(id);
  if (command === undefined) throw new Error(`no command ${id}`);
  return command.description;
}

describe("build guards fail loudly", () => {
  const emptyInput = { version: "0", overlays: new Map<string, string>(), examples: {} };

  it("throws when the root declares no --experimental global flag", () => {
    const root = Command.make("supabase").pipe(Command.withSubcommands([Command.make("link")]));
    expect(() => legacyBuildDocsSpec({ root, ...emptyInput })).toThrow(
      /no --experimental global flag/,
    );
  });

  it("throws for a top-level command without a docs section tag", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([Command.make("not-a-real-command")]),
      Command.withGlobalFlags([LegacyExperimentalFlag]),
    );
    expect(() => legacyBuildDocsSpec({ root, ...emptyInput })).toThrow(/no LEGACY_DOCS_TAGS entry/);
  });

  it("throws listing stale static-table entries for a shrunken tree", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([Command.make("link")]),
      Command.withGlobalFlags([LegacyExperimentalFlag]),
    );
    expect(() => legacyBuildDocsSpec({ root, ...emptyInput })).toThrow(
      /stale static-table entries[^]*LEGACY_DOCS_EXPERIMENTAL[^]*LEGACY_DOCS_EXTRA_FLAGS/,
    );
  });

  it("throws when a declared flag shadows an extra-flags table entry", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([
        Command.make("db").pipe(
          Command.withSubcommands([Command.make("query", { output: Flag.string("output") })]),
        ),
      ]),
      Command.withGlobalFlags([LegacyExperimentalFlag]),
    );
    expect(() => legacyBuildDocsSpec({ root, ...emptyInput })).toThrow(
      /LEGACY_DOCS_EXTRA_FLAGS entry "supabase-db-query" is shadowed by declared flag\(s\) --output/,
    );
  });

  it("throws for orphaned overlays and examples keys", () => {
    const root = Command.make("supabase").pipe(
      Command.withSubcommands([Command.make("link")]),
      Command.withGlobalFlags([LegacyExperimentalFlag]),
    );
    const overlays = new Map([["supabase/lonk.md", "## x\n\nBody.\n"]]);
    const build = () =>
      legacyBuildDocsSpec({
        root,
        version: "0",
        overlays,
        examples: { "supabase-lonk": [{ id: "a", code: "x" }] },
      });
    // the stale-table throw fires first on this synthetic tree; assert the
    // content guard directly by checking its message is reachable when the
    // table validation is satisfied — covered via the real-tree fixture below.
    expect(build).toThrow(/stale static-table entries/);
    const { content } = legacyBuiltSpec();
    const badExamples = { ...content.examples, "supabase-not-a-command": [{ id: "a" }] };
    expect(() =>
      legacyBuildDocsSpec({
        root: legacyRoot,
        version: "0",
        overlays: content.overlays,
        examples: badExamples,
      }),
    ).toThrow(/content inputs match no command[^]*supabase-not-a-command/);
    const badOverlays = new Map(content.overlays);
    badOverlays.set("supabase/not-a-real-command.md", "## x\n\nBody.\n");
    expect(() =>
      legacyBuildDocsSpec({
        root: legacyRoot,
        version: "0",
        overlays: badOverlays,
        examples: content.examples,
      }),
    ).toThrow(/content inputs match no command[^]*overlay: "supabase\/not-a-real-command\.md"/);
  });
});

describe("legacyReadDocsContent rejects malformed examples.yaml", () => {
  function withTempDocs(examplesYaml: string): () => void {
    const dir = mkdtempSync(path.join(tmpdir(), "docs-spec-test-"));
    mkdirSync(path.join(dir, "supabase"), { recursive: true });
    mkdirSync(path.join(dir, "templates"), { recursive: true });
    writeFileSync(path.join(dir, "supabase", "link.md"), "## supabase-link\n\nBody.\n");
    writeFileSync(path.join(dir, "templates", "examples.yaml"), examplesYaml);
    return () => {
      try {
        legacyReadDocsContent(dir);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    };
  }

  it("rejects a non-mapping document", () => {
    expect(withTempDocs("- just\n- a list\n")).toThrow(/must be a mapping of doc ids/);
  });

  it("rejects a nested-array entry (mis-indented list)", () => {
    expect(withTempDocs("supabase-link:\n  - - id: oops\n")).toThrow(/must be a mapping/);
  });

  it("rejects unknown fields (typo'd keys)", () => {
    expect(withTempDocs("supabase-link:\n  - titel: typo\n    code: x\n")).toThrow(
      /unknown field "titel"/,
    );
  });

  it("rejects non-string field values", () => {
    expect(withTempDocs("supabase-link:\n  - id: 5\n")).toThrow(/id must be a string/);
  });
});

describe("LEGACY_DOCS_EXPERIMENTAL mirrors the runtime gate", () => {
  it("matches the legacyRequireExperimental call sites exactly", () => {
    const commandsDir = path.resolve(import.meta.dirname, "../commands");
    const gated = new Set<string>();
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const entryPath = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(entryPath);
        else if (entry.name.endsWith(".command.ts")) {
          if (readFileSync(entryPath, "utf8").includes("yield* legacyRequireExperimental")) {
            const relative = path.relative(commandsDir, path.dirname(entryPath));
            gated.add(`supabase-${relative.split(path.sep).join("-")}`);
          }
        }
      }
    };
    walk(commandsDir);
    expect([...gated].sort()).toEqual([...LEGACY_DOCS_EXPERIMENTAL].sort());
  });
});
