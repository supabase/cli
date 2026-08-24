import { fileURLToPath } from "node:url";
import { BunServices } from "@effect/platform-bun";
import { describe, expect, it } from "@effect/vitest";
import { Effect, FileSystem, Path } from "effect";

import {
  type LegacyCompletionShell,
  legacyGenerateCompletionScript,
} from "./legacy-completion-scripts.ts";

const fixturesDir = fileURLToPath(new URL("./__fixtures__", import.meta.url));

function readFixture(shell: LegacyCompletionShell, variant: "desc" | "nodesc") {
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.readFileString(path.join(fixturesDir, `${shell}.${variant}.txt`));
  }).pipe(Effect.provide(BunServices.layer));
}

describe("legacyGenerateCompletionScript", () => {
  describe("bash", () => {
    it("contains the bash completion V2 header", () => {
      const script = legacyGenerateCompletionScript("bash", { noDescriptions: false });
      expect(script).toContain("# bash completion V2 for supabase");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = legacyGenerateCompletionScript("bash", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = legacyGenerateCompletionScript("bash", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = legacyGenerateCompletionScript("bash", { noDescriptions: false });
      const noDescriptions = legacyGenerateCompletionScript("bash", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("zsh", () => {
    it("contains the #compdef header and the trailing compdef invocation", () => {
      const script = legacyGenerateCompletionScript("zsh", { noDescriptions: false });
      expect(script).toContain("#compdef supabase");
      expect(script).toContain("compdef _supabase supabase");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = legacyGenerateCompletionScript("zsh", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = legacyGenerateCompletionScript("zsh", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = legacyGenerateCompletionScript("zsh", { noDescriptions: false });
      const noDescriptions = legacyGenerateCompletionScript("zsh", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("fish", () => {
    it("contains the fish completion header and disables activeHelp via SUPABASE_ACTIVE_HELP=0", () => {
      const script = legacyGenerateCompletionScript("fish", { noDescriptions: false });
      expect(script).toContain("# fish completion for supabase");
      expect(script).toContain("SUPABASE_ACTIVE_HELP=0");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = legacyGenerateCompletionScript("fish", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = legacyGenerateCompletionScript("fish", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = legacyGenerateCompletionScript("fish", { noDescriptions: false });
      const noDescriptions = legacyGenerateCompletionScript("fish", { noDescriptions: true });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  describe("powershell", () => {
    it("registers the argument completer for the supabase command", () => {
      const script = legacyGenerateCompletionScript("powershell", { noDescriptions: false });
      expect(script).toContain("Register-ArgumentCompleter -CommandName 'supabase'");
    });

    it("calls back into __complete by default and never mentions __completeNoDesc", () => {
      const script = legacyGenerateCompletionScript("powershell", { noDescriptions: false });
      expect(script).toContain("__complete");
      expect(script).not.toContain("__completeNoDesc");
    });

    it("calls back into __completeNoDesc when noDescriptions is true", () => {
      const script = legacyGenerateCompletionScript("powershell", { noDescriptions: true });
      expect(script).toContain("__completeNoDesc");
    });

    it("differs from the with-descriptions variant only by the __complete/__completeNoDesc token", () => {
      const withDescriptions = legacyGenerateCompletionScript("powershell", {
        noDescriptions: false,
      });
      const noDescriptions = legacyGenerateCompletionScript("powershell", {
        noDescriptions: true,
      });
      expect(noDescriptions.replaceAll("__completeNoDesc", "__complete")).toBe(withDescriptions);
    });
  });

  // The substring/self-consistency checks above prove structural facts, but
  // "byte-for-byte transcription of cobra v1.10.2" is the module's entire
  // contract, and every one of the hundreds of hand-escaped `${…}`/backtick/
  // `$'\t'` sequences in the four templates is otherwise unguarded — a
  // well-intentioned "cleanup" of an escape could ship silently. These
  // fixtures are the literal stdout of a real `apps/cli-go` binary (pinned to
  // `spf13/cobra v1.10.2`, same version as `go.mod`) running
  // `supabase completion <shell> [--no-descriptions]`, captured once and
  // checked in — see `apps/cli/src/legacy/commands/completion/__fixtures__/`.
  // Regenerate them (and re-verify byte equality by hand) only if cobra is
  // ever upgraded.
  describe("byte-exact parity with real cobra v1.10.2 output", () => {
    const shells: ReadonlyArray<LegacyCompletionShell> = ["bash", "zsh", "fish", "powershell"];

    for (const shell of shells) {
      it.effect(
        `matches the real cobra ${shell} completion script byte-for-byte (with descriptions)`,
        () =>
          Effect.gen(function* () {
            const generated = legacyGenerateCompletionScript(shell, { noDescriptions: false });
            expect(generated).toBe(yield* readFixture(shell, "desc"));
          }),
      );

      it.effect(
        `matches the real cobra ${shell} completion script byte-for-byte (--no-descriptions)`,
        () =>
          Effect.gen(function* () {
            const generated = legacyGenerateCompletionScript(shell, { noDescriptions: true });
            expect(generated).toBe(yield* readFixture(shell, "nodesc"));
          }),
      );
    }
  });
});
