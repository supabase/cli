package utils

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/config"
)

func TestPgDeltaNpmRegistryOption(t *testing.T) {
	t.Run("returns nil when PGDELTA_NPM_REGISTRY is unset", func(t *testing.T) {
		t.Setenv(config.PgDeltaNpmRegistryEnv, "")
		assert.Nil(t, PgDeltaNpmRegistryOption())
	})

	t.Run("writes a scoped .npmrc and forwards both PGDELTA_NPM_REGISTRY and NPM_CONFIG_REGISTRY when set", func(t *testing.T) {
		t.Setenv(config.PgDeltaNpmRegistryEnv, "http://host.docker.internal:4873")
		opt := PgDeltaNpmRegistryOption()
		require.NotNil(t, opt)

		state := &edgeRuntimeOptions{}
		opt(state)
		require.Len(t, state.extraFiles, 1)
		assert.Equal(t, ".npmrc", state.extraFiles[0].name)
		assert.Equal(t,
			"@supabase:registry=http://host.docker.internal:4873\n",
			state.extraFiles[0].content,
		)
		// NPM_CONFIG_REGISTRY is the universal escape hatch for runtimes
		// that ignore .npmrc (e.g. some supabase/edge-runtime variants);
		// PGDELTA_NPM_REGISTRY is forwarded so scripts can read the configured
		// registry URL when needed.
		assert.Equal(t,
			[]string{
				"PGDELTA_NPM_REGISTRY=http://host.docker.internal:4873",
				"NPM_CONFIG_REGISTRY=http://host.docker.internal:4873",
			},
			state.extraEnv,
		)
	})

	t.Run("trims surrounding whitespace from the registry URL", func(t *testing.T) {
		t.Setenv(config.PgDeltaNpmRegistryEnv, "  http://localhost:4873  ")
		opt := PgDeltaNpmRegistryOption()
		require.NotNil(t, opt)

		state := &edgeRuntimeOptions{}
		opt(state)
		require.Len(t, state.extraFiles, 1)
		assert.Equal(t,
			"@supabase:registry=http://localhost:4873\n",
			state.extraFiles[0].content,
		)
		assert.Equal(t,
			[]string{
				"PGDELTA_NPM_REGISTRY=http://localhost:4873",
				"NPM_CONFIG_REGISTRY=http://localhost:4873",
			},
			state.extraEnv,
		)
	})
}
