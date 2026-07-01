// Model selection for the release-notes generator.
//
// OpenCode identifies a model by a single `provider/model` string (e.g.
// `anthropic/claude-haiku-4-5`, `openai/gpt-5-mini`), resolved against the
// models.dev registry. Given the matching provider credential in the
// environment (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, …), OpenCode auto-detects
// the provider and runs the model — so making release-notes generation
// provider-agnostic is just a matter of picking that string. Both keys can be
// present at once; the string alone decides which provider runs.
//
// Resolution order (first match wins):
//   1. `--model "provider/model"` flag.
//   2. `RELEASE_NOTES_MODEL` env (same `provider/model` form).
//   3. Default: `anthropic/claude-haiku-4-5` (preserves prior behavior).

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

/** Validate that a model id is a non-empty `provider/model` string. */
function assertModel(value: string): string {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const provider = slash === -1 ? "" : trimmed.slice(0, slash).trim();
  const model = slash === -1 ? "" : trimmed.slice(slash + 1).trim();
  if (!provider || !model) {
    throw new Error(
      `Invalid model "${value}": expected "provider/model" (e.g. "openai/gpt-5-mini").`,
    );
  }
  return trimmed;
}

/**
 * Resolve the `provider/model` string to run against from the CLI flag and
 * environment. Pure: reads only its arguments, never `process.env` directly.
 */
export function resolveModel(opts: { model?: string | undefined }, env: NodeJS.ProcessEnv): string {
  if (opts.model !== undefined && opts.model !== "") {
    return assertModel(opts.model);
  }
  const fromEnv = env.RELEASE_NOTES_MODEL;
  if (fromEnv !== undefined && fromEnv !== "") {
    return assertModel(fromEnv);
  }
  return DEFAULT_MODEL;
}
