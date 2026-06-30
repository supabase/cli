import type { Effect, Option } from "effect";
import { Context } from "effect";

interface LegacyPromptInputShape {
  /**
   * The next line of piped (non-TTY) stdin, or `None` once stdin is empty or
   * exhausted. Mirrors Go's persistent `bufio.Scanner` over `os.Stdin`
   * (`apps/cli-go/internal/utils/console.go:20,50`): each prompt consumes the
   * next line, and an empty/exhausted scan falls back to the prompt's default.
   */
  readonly nextLine: Effect.Effect<Option.Option<string>>;
}

/**
 * Per-command reader for piped stdin. Scoped per command so a command issuing
 * several confirmations (e.g. `config push`, `seed buckets`) answers each prompt
 * from a distinct piped line, exactly as Go's single scanner does.
 */
export class LegacyPromptInput extends Context.Service<LegacyPromptInput, LegacyPromptInputShape>()(
  "supabase/legacy/PromptInput",
) {}
