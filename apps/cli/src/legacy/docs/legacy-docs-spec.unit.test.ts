import path from "node:path";
import { describe, expect, it } from "vitest";

import { legacyRoot } from "../cli/root.ts";
import { legacyReadDocsContent } from "./legacy-docs-spec.content.ts";
import {
  legacyBuildDocsSpec,
  legacyDocsOverlayPath,
  legacyDocsStripOverlayHeading,
  legacyStringifyDocsSpec,
} from "./legacy-docs-spec.ts";
import type { LegacyDocsCommand } from "./legacy-docs-spec.ts";
import { LEGACY_DOCS_EXCLUDED } from "./legacy-docs-spec.tables.ts";

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
    expect(link?.usage).toBe("supabase link [flags]");
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
