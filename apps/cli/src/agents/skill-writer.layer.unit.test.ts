import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import { afterEach, beforeEach } from "vitest";
import { Effect, FileSystem, Layer, Path } from "effect";
import { SkillWriter } from "./skill-writer.service.ts";
import { skillWriterLayer } from "./skill-writer.layer.ts";

let testDir: string;

beforeEach(() => {
  testDir = nodePath.join(
    tmpdir(),
    `skillwriter-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

describe("SkillWriter", () => {
  describe("default implementation", () => {
    it.live("writes a single skill file with correct frontmatter", () =>
      Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles(testDir, [
          { skillName: "my-skill", skillDescription: "A test skill", content: "Hello world" },
        ]);

        const filePath = nodePath.join(testDir, "my-skill", "SKILL.md");
        expect(existsSync(filePath)).toBe(true);

        const content = readFileSync(filePath, "utf-8");
        expect(content).toBe(`---
name: my-skill
description: A test skill
---

Hello world`);
      }),
    );

    it.live("writes multiple skill files", () =>
      Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles(testDir, [
          { skillName: "skill-a", skillDescription: "First", content: "Content A" },
          { skillName: "skill-b", skillDescription: "Second", content: "Content B" },
        ]);

        expect(existsSync(nodePath.join(testDir, "skill-a", "SKILL.md"))).toBe(true);
        expect(existsSync(nodePath.join(testDir, "skill-b", "SKILL.md"))).toBe(true);

        expect(readFileSync(nodePath.join(testDir, "skill-a", "SKILL.md"), "utf-8")).toContain(
          "name: skill-a",
        );
        expect(readFileSync(nodePath.join(testDir, "skill-b", "SKILL.md"), "utf-8")).toContain(
          "name: skill-b",
        );
      }),
    );

    it.live("handles empty entries array", () =>
      Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles(testDir, []);
        expect(readdirSync(testDir)).toHaveLength(0);
      }),
    );

    it.live("creates nested directories", () =>
      Effect.gen(function* () {
        const sw = yield* SkillWriter;
        const nestedDir = nodePath.join(testDir, "deep", "nested");
        yield* sw.writeSkillFiles(nestedDir, [
          { skillName: "nested-skill", skillDescription: "Nested", content: "Deep content" },
        ]);

        const filePath = nodePath.join(nestedDir, "nested-skill", "SKILL.md");
        expect(existsSync(filePath)).toBe(true);
      }),
    );
  });

  describe("skillWriterLayer", () => {
    function mockFileSystem() {
      const files = new Map<string, string>();
      const dirs = new Set<string>();
      return {
        layer: Layer.succeed(FileSystem.FileSystem, {
          makeDirectory: (path: string) =>
            Effect.sync(() => {
              dirs.add(path);
            }),
          writeFileString: (path: string, content: string) =>
            Effect.sync(() => {
              files.set(path, content);
            }),
        } as unknown as FileSystem.FileSystem),
        get files() {
          return files;
        },
        get dirs() {
          return dirs;
        },
      };
    }

    function mockPath() {
      return Layer.succeed(Path.Path, {
        join: (...segments: ReadonlyArray<string>) => segments.join("/"),
      } as unknown as Path.Path);
    }

    it.live("writes skill files using Effect FileSystem", () => {
      const fs = mockFileSystem();
      const layer = skillWriterLayer.pipe(Layer.provide(Layer.merge(fs.layer, mockPath())));

      return Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles("/out", [
          { skillName: "my-skill", skillDescription: "A test skill", content: "Hello world" },
        ]);

        expect(fs.dirs.has("/out/my-skill")).toBe(true);
        expect(fs.files.has("/out/my-skill/SKILL.md")).toBe(true);

        const content = fs.files.get("/out/my-skill/SKILL.md")!;
        expect(content).toBe(`---
name: my-skill
description: A test skill
---

Hello world`);
      }).pipe(Effect.provide(layer));
    });

    it.live("writes multiple skill files using Effect FileSystem", () => {
      const fs = mockFileSystem();
      const layer = skillWriterLayer.pipe(Layer.provide(Layer.merge(fs.layer, mockPath())));

      return Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles("/out", [
          { skillName: "skill-a", skillDescription: "First", content: "A" },
          { skillName: "skill-b", skillDescription: "Second", content: "B" },
        ]);

        expect(fs.dirs.size).toBe(2);
        expect(fs.files.size).toBe(2);
        expect(fs.files.has("/out/skill-a/SKILL.md")).toBe(true);
        expect(fs.files.has("/out/skill-b/SKILL.md")).toBe(true);
      }).pipe(Effect.provide(layer));
    });

    it.live("handles empty entries using Effect FileSystem", () => {
      const fs = mockFileSystem();
      const layer = skillWriterLayer.pipe(Layer.provide(Layer.merge(fs.layer, mockPath())));

      return Effect.gen(function* () {
        const sw = yield* SkillWriter;
        yield* sw.writeSkillFiles("/out", []);

        expect(fs.dirs.size).toBe(0);
        expect(fs.files.size).toBe(0);
      }).pipe(Effect.provide(layer));
    });
  });
});
