package utils

import (
	"os"
	"strings"

	"github.com/supabase/cli/pkg/config"
)

// PgDeltaNpmRegistryOption returns an EdgeRuntimeOption that points the
// edge-runtime container at a user-controlled npm registry when
// PGDELTA_NPM_REGISTRY is set. It applies three coordinated overrides:
//
//  1. Writes a project-local `.npmrc` with a `@supabase`-scoped registry
//     line. Deno honors `.npmrc` for scoped registries when discovered in
//     the cwd or parents (Deno >= 1.39), so this keeps every non-`@supabase`
//     npm specifier on npmjs.
//  2. Forwards the canonical `NPM_CONFIG_REGISTRY` env var into the
//     container. This is the universal npm/Deno escape hatch — it routes
//     every `npm:` specifier through the chosen registry regardless of
//     whether the host runtime reads `.npmrc`. Verdaccio's `npmjs` uplink
//     proxies any non-`@supabase` packages back to npmjs, so widening the
//     scope is safe and protects us against edge-runtime image variants
//     that ignore `.npmrc`.
//  3. Forwards `PGDELTA_NPM_REGISTRY` itself into the container.
//
// Returns nil when the env var is unset or whitespace-only, which makes it
// safe to pass unconditionally to RunEdgeRuntimeScript (nil options are
// ignored).
func PgDeltaNpmRegistryOption() EdgeRuntimeOption {
	registry := strings.TrimSpace(os.Getenv(config.PgDeltaNpmRegistryEnv))
	if registry == "" {
		return nil
	}
	npmrc := WithExtraFile(".npmrc", "@supabase:registry="+registry+"\n")
	envFwd := WithExtraEnv(
		config.PgDeltaNpmRegistryEnv+"="+registry,
		"NPM_CONFIG_REGISTRY="+registry,
	)
	return func(o *edgeRuntimeOptions) {
		npmrc(o)
		envFwd(o)
	}
}
