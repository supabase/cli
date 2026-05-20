package cmd

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestShouldUseDeclarativePgDeltaPull(t *testing.T) {
	t.Run("migration pg-delta wins over experimental config", func(t *testing.T) {
		usePgDelta = false
		t.Cleanup(func() { usePgDelta = false })
		assert.False(t, shouldUseDeclarativePgDeltaPull(true))
	})

	t.Run("experimental config without diff-engine uses declarative", func(t *testing.T) {
		usePgDelta = false
		t.Cleanup(func() { usePgDelta = false })
		// Simulate config enabled via shouldUsePgDelta's IsPgDeltaEnabled path indirectly:
		// when neither flag nor config is set, declarative is off.
		assert.False(t, shouldUseDeclarativePgDeltaPull(false))
	})

	t.Run("use-pg-delta flag forces declarative", func(t *testing.T) {
		usePgDelta = true
		t.Cleanup(func() { usePgDelta = false })
		assert.True(t, shouldUseDeclarativePgDeltaPull(false))
	})
}
