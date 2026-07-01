// Provider selection for the release-notes generator.
//
// OpenCode identifies a model by a `providerID/modelID` pair (e.g.
// `anthropic/claude-haiku-4-5`, `openai/gpt-5-mini`), resolved against the
// models.dev registry. Making release-notes generation provider-agnostic is
// therefore just a matter of picking that pair: the agent's tools and the
// prompt stay identical regardless of which LLM runs the loop.
//
// Resolution order (first match wins):
//   1. `--model "provider/model"`     — pin an exact model.
//   2. `--provider <shorthand>`       — a provider's default model.
//   3. `RELEASE_NOTES_MODEL` env      — `provider/model`, same form as (1).
//   4. Default: `anthropic/claude-haiku-4-5` (preserves prior behavior).

export interface ModelRef {
  /** OpenCode provider id, e.g. "anthropic" | "openai". */
  providerID: string;
  /** OpenCode model id within that provider, e.g. "claude-haiku-4-5". */
  modelID: string;
}

/** Default model per provider shorthand. */
const PROVIDER_DEFAULTS: Record<string, ModelRef> = {
  anthropic: { providerID: "anthropic", modelID: "claude-haiku-4-5" },
  openai: { providerID: "openai", modelID: "gpt-5-mini" },
};

/** Shorthand aliases accepted by `--provider`. */
const PROVIDER_ALIASES: Record<string, string> = {
  anthropic: "anthropic",
  claude: "anthropic",
  openai: "openai",
  codex: "openai",
};

const DEFAULT_MODEL = "anthropic/claude-haiku-4-5";

/** Parse a `provider/model` string into a ModelRef. Throws on malformed input. */
function parseModelRef(value: string): ModelRef {
  const trimmed = value.trim();
  const slash = trimmed.indexOf("/");
  const providerID = slash === -1 ? "" : trimmed.slice(0, slash).trim();
  const modelID = slash === -1 ? "" : trimmed.slice(slash + 1).trim();
  if (!providerID || !modelID) {
    throw new Error(
      `Invalid --model "${value}": expected "provider/model" (e.g. "openai/gpt-5-mini").`,
    );
  }
  return { providerID, modelID };
}

/** Resolve the provider shorthand to its default model. Throws on unknown value. */
function resolveProviderShorthand(value: string): ModelRef {
  const key = value.trim().toLowerCase();
  const provider = PROVIDER_ALIASES[key];
  const model = provider === undefined ? undefined : PROVIDER_DEFAULTS[provider];
  if (model === undefined) {
    const valid = Object.keys(PROVIDER_ALIASES).join(", ");
    throw new Error(`Unknown --provider "${value}". Valid values: ${valid}.`);
  }
  return model;
}

/**
 * Resolve the model to run against from CLI flags and environment.
 * Pure: reads only its arguments, never `process.env` directly.
 */
export function resolveModel(
  opts: { model?: string | undefined; provider?: string | undefined },
  env: NodeJS.ProcessEnv,
): ModelRef {
  if (opts.model !== undefined && opts.model !== "") {
    return parseModelRef(opts.model);
  }
  if (opts.provider !== undefined && opts.provider !== "") {
    return resolveProviderShorthand(opts.provider);
  }
  const fromEnv = env.RELEASE_NOTES_MODEL;
  if (fromEnv !== undefined && fromEnv !== "") {
    return parseModelRef(fromEnv);
  }
  return parseModelRef(DEFAULT_MODEL);
}
