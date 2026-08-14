package cmd

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolvePullDiffEngine(t *testing.T) {
	t.Run("defaults to pg-delta when enabled in config", func(t *testing.T) {
		assert.True(t, resolvePullDiffEngine(false, "migra", true))
	})

	t.Run("defaults to migra when pg-delta is not active", func(t *testing.T) {
		assert.False(t, resolvePullDiffEngine(false, "migra", false))
	})

	t.Run("explicit --diff-engine migra overrides config default", func(t *testing.T) {
		assert.False(t, resolvePullDiffEngine(true, "migra", true))
	})

	t.Run("explicit --diff-engine pg-delta wins when config disabled", func(t *testing.T) {
		assert.True(t, resolvePullDiffEngine(true, "pg-delta", false))
	})
}

func TestResolveDiffEngine(t *testing.T) {
	t.Run("uses pg-delta when enabled in config and no engine flag set", func(t *testing.T) {
		assert.True(t, resolveDiffEngine(false, false, false, true))
	})

	t.Run("uses migra when pg-delta is not active", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, false, false, false))
	})

	t.Run("explicit --use-migra clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(true, false, false, true))
	})

	t.Run("explicit --use-pg-schema clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, false, true, true))
	})

	t.Run("explicit --use-pgadmin clears config-driven pg-delta", func(t *testing.T) {
		assert.False(t, resolveDiffEngine(false, true, false, true))
	})
}
