import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { BunServices } from "@effect/platform-bun";
import { Effect, FileSystem } from "effect";

import { type CompletionShell, generateCompletionScript } from "./completion-scripts.ts";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

const readFixture = (shell: CompletionShell, variant: "desc" | "nodesc") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.readFileString(`${fixturesDir}/${shell}.${variant}.txt`);
  }).pipe(Effect.provide(BunServices.layer));

describe("generateCompletionScript", () => {
  describe("bash", () => {
    it("contains the bash completion V2 header", () => {
      const script = generateCompletionScript("bash", { noDescriptions: false });
      expect(script).toContain("# bash completion V2 for supabase");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = generateCompletionScript("bash", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = generateCompletionScript("bash", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = generateCompletionScript("bash", { noDescriptions: false });
      const noDescriptions = generateCompletionScript("bash", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("zsh", () => {
    it("contains the #compdef header and the trailing compdef invocation", () => {
      const script = generateCompletionScript("zsh", { noDescriptions: false });
      expect(script).toContain("#compdef supabase");
      expect(script).toContain("compdef _supabase supabase");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = generateCompletionScript("zsh", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = generateCompletionScript("zsh", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = generateCompletionScript("zsh", { noDescriptions: false });
      const noDescriptions = generateCompletionScript("zsh", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("fish", () => {
    it("contains the fish completion header and disables activeHelp via SUPABASE_ACTIVE_HELP=0", () => {
      const script = generateCompletionScript("fish", { noDescriptions: false });
      expect(script).toContain("# fish completion for supabase");
      expect(script).toContain("SUPABASE_ACTIVE_HELP=0");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = generateCompletionScript("fish", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = generateCompletionScript("fish", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = generateCompletionScript("fish", { noDescriptions: false });
      const noDescriptions = generateCompletionScript("fish", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("powershell", () => {
    it("registers the argument completer for the supabase command", () => {
      const script = generateCompletionScript("powershell", { noDescriptions: false });
      expect(script).toContain("Register-ArgumentCompleter -CommandName 'supabase'");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = generateCompletionScript("powershell", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = generateCompletionScript("powershell", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = generateCompletionScript("powershell", {
        noDescriptions: false,
      });
      const noDescriptions = generateCompletionScript("powershell", {
        noDescriptions: true,
      });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  // Fixtures are the literal stdout of a pinned cobra v1.10.2 binary running
  // `supabase completion <shell> [--no-descriptions]`, captured once and checked in.
  // Regenerate them only if cobra is upgraded.
  describe("byte-exact parity with real cobra v1.10.2 output", () => {
    const shells: ReadonlyArray<CompletionShell> = ["bash", "zsh", "fish", "powershell"];

    for (const shell of shells) {
      it.live(
        `matches the real cobra ${shell} completion script byte-for-byte (with descriptions)`,
        () =>
          Effect.gen(function* () {
            const generated = generateCompletionScript(shell, { noDescriptions: false });
            expect(generated).toBe(yield* readFixture(shell, "desc"));
          }),
      );

      it.live(
        `matches the real cobra ${shell} completion script byte-for-byte (--no-descriptions)`,
        () =>
          Effect.gen(function* () {
            const generated = generateCompletionScript(shell, { noDescriptions: true });
            expect(generated).toBe(yield* readFixture(shell, "nodesc"));
          }),
      );
    }
  });
});
