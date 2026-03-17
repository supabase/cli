package cmd

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/supabase/cli/internal/utils"
)

func mockFsys() afero.Fs {
	return afero.NewMemMapFs()
}

func mockFsysWithDeclarative() afero.Fs {
	fsys := afero.NewMemMapFs()
	path := filepath.Join(utils.GetDeclarativeDir(), "schemas", "public", "tables", "users.sql")
	_ = afero.WriteFile(fsys, path, []byte("create table users(id bigint);"), 0644)
	return fsys
}

func mockFsysWithMigrations() afero.Fs {
	fsys := afero.NewMemMapFs()
	path := filepath.Join(utils.MigrationsDir, "20240101000000_init.sql")
	_ = afero.WriteFile(fsys, path, []byte("create table a();"), 0644)
	return fsys
}

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

func TestHasDeclarativeFiles(t *testing.T) {
	t.Run("returns false when dir does not exist", func(t *testing.T) {
		assert.False(t, hasDeclarativeFiles(mockFsys()))
	})

	t.Run("returns false when dir is empty", func(t *testing.T) {
		fsys := mockFsys()
		fsys.MkdirAll(utils.GetDeclarativeDir(), 0755)
		assert.False(t, hasDeclarativeFiles(fsys))
	})

	t.Run("returns true when dir has files", func(t *testing.T) {
		fsys := mockFsysWithDeclarative()
		assert.True(t, hasDeclarativeFiles(fsys))
	})
}

func TestHasMigrationFiles(t *testing.T) {
	t.Run("returns false when no migrations", func(t *testing.T) {
		assert.False(t, hasMigrationFiles(mockFsys()))
	})

	t.Run("returns true when migrations exist", func(t *testing.T) {
		fsys := mockFsysWithMigrations()
		assert.True(t, hasMigrationFiles(fsys))
	})
}
