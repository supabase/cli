package cmd

import (
	"testing"

	"github.com/spf13/viper"
	"github.com/stretchr/testify/assert"
)

func TestShouldUseDeclarativePgDeltaPull(t *testing.T) {
	t.Run("diff-engine pg-delta keeps the migration-file workflow", func(t *testing.T) {
		usePgDelta = false
		t.Cleanup(func() { usePgDelta = false })
		assert.False(t, shouldUseDeclarativePgDeltaPull(true))
	})

	t.Run("no flag and no config means not declarative", func(t *testing.T) {
		usePgDelta = false
		t.Cleanup(func() { usePgDelta = false })
		assert.False(t, shouldUseDeclarativePgDeltaPull(false))
	})

	t.Run("experimental config enables declarative", func(t *testing.T) {
		usePgDelta = false
		viper.Set("EXPERIMENTAL_PG_DELTA", true)
		t.Cleanup(func() {
			usePgDelta = false
			viper.Set("EXPERIMENTAL_PG_DELTA", false)
		})
		assert.True(t, shouldUseDeclarativePgDeltaPull(false))
	})

	t.Run("use-pg-delta flag forces declarative", func(t *testing.T) {
		usePgDelta = true
		t.Cleanup(func() { usePgDelta = false })
		assert.True(t, shouldUseDeclarativePgDeltaPull(false))
	})
}
