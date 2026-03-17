package cmd

import (
	"context"
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
)

func TestResolveDeclarativeMigrationName(t *testing.T) {
	t.Run("prefers explicit name", func(t *testing.T) {
		name := resolveDeclarativeMigrationName("custom_name", "fallback_file")

		assert.Equal(t, "custom_name", name)
	})

	t.Run("falls back to file flag", func(t *testing.T) {
		name := resolveDeclarativeMigrationName("", "fallback_file")

		assert.Equal(t, "fallback_file", name)
	})
}

func TestEnsureLocalDatabaseStarted(t *testing.T) {
	t.Run("skips startup when not using local target", func(t *testing.T) {
		started := false
		err := ensureLocalDatabaseStarted(context.Background(), false, func() error {
			return nil
		}, func(context.Context) error {
			started = true
			return nil
		})

		assert.NoError(t, err)
		assert.False(t, started)
	})

	t.Run("starts database when local target is not running", func(t *testing.T) {
		started := false
		err := ensureLocalDatabaseStarted(context.Background(), true, func() error {
			return utils.ErrNotRunning
		}, func(context.Context) error {
			started = true
			return nil
		})

		assert.NoError(t, err)
		assert.True(t, started)
	})

	t.Run("returns status check error", func(t *testing.T) {
		expected := errors.New("boom")
		err := ensureLocalDatabaseStarted(context.Background(), true, func() error {
			return expected
		}, func(context.Context) error {
			return nil
		})

		assert.ErrorIs(t, err, expected)
	})

	t.Run("returns startup error", func(t *testing.T) {
		expected := errors.New("start failed")
		err := ensureLocalDatabaseStarted(context.Background(), true, func() error {
			return utils.ErrNotRunning
		}, func(context.Context) error {
			return expected
		})

		assert.ErrorIs(t, err, expected)
	})
}
