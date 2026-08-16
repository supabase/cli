import { describe, expect, test } from "vitest";
import { BunServices } from "@effect/platform-bun";
import { mkdtempSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Exit, FileSystem, Path } from "effect";
import {
  addRemote,
  appendRemoteBlockToml,
  listRemotes,
  listRemotesFromDocument,
  removeRemote,
  removeRemoteBlockToml,
  validateRemoteName,
  validateRemoteRef,
} from "./remotes.ts";

function makeTempProject(): string {
  return mkdtempSync(join(tmpdir(), "supabase-remotes-"));
}

function runConfigEffect<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<A> {
  return Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)));
}

function runConfigExit<A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
): Promise<Exit.Exit<A, E>> {
  return Effect.runPromiseExit(effect.pipe(Effect.provide(BunServices.layer)));
}

const REF_A = "abcdefghijklmnopqrst";
const REF_B = "zzzzzzzzzzzzzzzzzzzz";

describe("appendRemoteBlockToml / removeRemoteBlockToml", () => {
  test("append is byte-preserving before the appended block", () => {
    const original = '# a comment\nproject_id = "local"\n';
    const appended = appendRemoteBlockToml(original, "staging", REF_A);
    expect(appended.startsWith(original)).toBe(true);
    expect(appended).toContain('[remotes.staging]\nproject_id = "abcdefghijklmnopqrst"\n');
  });

  test("append + remove round-trips back to the original content", () => {
    const original = '# a comment\nproject_id = "local"\n';
    const appended = appendRemoteBlockToml(original, "staging", REF_A);
    const removed = removeRemoteBlockToml(appended, "staging");
    expect(removed).toBe(original);
  });

  test("remove stops at the next table header, leaving sibling remotes intact", () => {
    const content =
      '[remotes.staging]\nproject_id = "abcdefghijklmnopqrst"\n\n[remotes.prod]\nproject_id = "zzzzzzzzzzzzzzzzzzzz"\n';
    const removed = removeRemoteBlockToml(content, "staging");
    expect(removed).toContain('[remotes.prod]\nproject_id = "zzzzzzzzzzzzzzzzzzzz"');
    expect(removed).not.toContain("[remotes.staging]");
  });
});

describe("validateRemoteName / validateRemoteRef", () => {
  test("accepts a bare-key-compatible name", async () => {
    await expect(Effect.runPromise(validateRemoteName("staging-2"))).resolves.toBeUndefined();
  });

  test("rejects a dotted name", async () => {
    const exit = await Effect.runPromiseExit(validateRemoteName("staging.prod"));
    expect(exit._tag).toBe("Failure");
  });

  test("rejects a ref that isn't 20 lowercase letters", async () => {
    const exit = await Effect.runPromiseExit(validateRemoteRef("not-a-ref"));
    expect(exit._tag).toBe("Failure");
  });
});

describe("listRemotesFromDocument", () => {
  test("reads every [remotes.*] entry's project_id", () => {
    const entries = listRemotesFromDocument({
      remotes: { staging: { project_id: REF_A }, prod: { project_id: REF_B } },
    });
    expect(entries).toEqual([
      { name: "staging", projectRef: REF_A },
      { name: "prod", projectRef: REF_B },
    ]);
  });

  test("returns empty for a document with no remotes", () => {
    expect(listRemotesFromDocument({})).toEqual([]);
    expect(listRemotesFromDocument(undefined)).toEqual([]);
  });
});

describe("addRemote / removeRemote / listRemotes (TOML project)", () => {
  test("add, list, then remove a remote end to end", async () => {
    const cwd = makeTempProject();
    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        '# top comment\nproject_id = "local"\n',
      );

      const added = await runConfigEffect(addRemote({ cwd, name: "staging", projectRef: REF_A }));
      expect(added?.wrote).toBe(true);

      const raw = await readFile(join(cwd, "supabase", "config.toml"), "utf8");
      expect(raw.startsWith('# top comment\nproject_id = "local"\n')).toBe(true);

      const listed = await runConfigEffect(listRemotes(cwd));
      expect(listed).toEqual([{ name: "staging", projectRef: REF_A }]);

      // Idempotent re-add with the identical ref.
      const readded = await runConfigEffect(addRemote({ cwd, name: "staging", projectRef: REF_A }));
      expect(readded?.wrote).toBe(false);

      // Conflicting re-add with a different ref fails, no write.
      const conflictExit = await runConfigExit(
        addRemote({ cwd, name: "staging", projectRef: REF_B }),
      );
      expect(Exit.isFailure(conflictExit)).toBe(true);
      if (Exit.isFailure(conflictExit)) {
        expect(String(conflictExit.cause)).toContain("already exists with a different project_id");
      }

      const removed = await runConfigEffect(removeRemote({ cwd, name: "staging" }));
      expect(removed).not.toBeNull();
      const afterRemove = await readFile(join(cwd, "supabase", "config.toml"), "utf8");
      expect(afterRemove).toBe('# top comment\nproject_id = "local"\n');

      const emptyList = await runConfigEffect(listRemotes(cwd));
      expect(emptyList).toEqual([]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("refuses to remove a block with extra keys", async () => {
    const cwd = makeTempProject();
    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.toml"),
        `[remotes.staging]\nproject_id = "${REF_A}"\n\n[remotes.staging.auth]\nenabled = true\n`,
      );

      const exit = await runConfigExit(removeRemote({ cwd, name: "staging" }));
      expect(Exit.isFailure(exit)).toBe(true);

      const raw = await readFile(join(cwd, "supabase", "config.toml"), "utf8");
      expect(raw).toContain("[remotes.staging]");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("returns null when no config file exists", async () => {
    const cwd = makeTempProject();
    try {
      const listed = await runConfigEffect(listRemotes(cwd));
      expect(listed).toBeNull();
      const added = await runConfigEffect(addRemote({ cwd, name: "staging", projectRef: REF_A }));
      expect(added).toBeNull();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("addRemote / removeRemote (JSON project)", () => {
  test("structural insert then delete, preserving unrelated keys", async () => {
    const cwd = makeTempProject();
    try {
      await mkdir(join(cwd, "supabase"), { recursive: true });
      await writeFile(
        join(cwd, "supabase", "config.json"),
        `${JSON.stringify({ project_id: "local", db: { major_version: 16 } }, null, 2)}\n`,
      );

      await runConfigEffect(addRemote({ cwd, name: "staging", projectRef: REF_A }));
      const afterAdd = JSON.parse(await readFile(join(cwd, "supabase", "config.json"), "utf8"));
      expect(afterAdd).toEqual({
        project_id: "local",
        db: { major_version: 16 },
        remotes: { staging: { project_id: REF_A } },
      });

      await runConfigEffect(removeRemote({ cwd, name: "staging" }));
      const afterRemove = JSON.parse(await readFile(join(cwd, "supabase", "config.json"), "utf8"));
      expect(afterRemove).toEqual({ project_id: "local", db: { major_version: 16 } });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
