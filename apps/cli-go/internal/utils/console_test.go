package utils

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/testing/fstest"
)

func TestPromptYesNo(t *testing.T) {
	t.Run("defaults on closed stdin", func(t *testing.T) {
		c := NewConsole()
		c.IsTTY = false
		// Run test
		val, err := c.PromptYesNo(context.Background(), "test", false)
		// Check error
		assert.NoError(t, err)
		assert.False(t, val)
	})

	t.Run("parses piped stdin", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, "y"))
		c := NewConsole()
		// Run test
		val, err := c.PromptYesNo(context.Background(), "test", false)
		// Check error
		assert.NoError(t, err)
		assert.True(t, val)
	})
}

func TestPromptText(t *testing.T) {
	t.Run("defaults on timeout", func(t *testing.T) {
		t.Cleanup(fstest.MockStdin(t, ""))
		c := NewConsole()
		// Run test
		val, err := c.PromptText(context.Background(), "test")
		// Check error
		assert.NoError(t, err)
		assert.Empty(t, val)
	})

	t.Run("throws error on cancel", func(t *testing.T) {
		c := NewConsole()
		// Setup cancelled context
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		// Run test
		val, err := c.PromptText(ctx, "test")
		// Check error
		assert.ErrorIs(t, err, context.Canceled)
		assert.Empty(t, val)
	})
}
