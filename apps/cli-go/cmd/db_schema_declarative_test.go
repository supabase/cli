package cmd

import (
	"context"
	"errors"
	"path/filepath"
	"testing"

	"github.com/containerd/errdefs"
	"github.com/docker/docker/api/types/container"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/declarative"
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

func TestResolveDeclarativeSyncShouldApply(t *testing.T) {
	t.Run("no-apply alone returns false without prompting", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			false, true, false, true,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.False(t, got)
	})

	t.Run("no-apply wins over yes", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			false, true, true, false,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.False(t, got)
	})

	t.Run("apply alone returns true without prompting", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			true, false, false, true,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.True(t, got)
	})

	t.Run("TTY without flags prompts", func(t *testing.T) {
		prompted := false
		got, err := resolveDeclarativeSyncShouldApply(
			false, false, false, true,
			func() (bool, error) {
				prompted = true
				return true, nil
			},
		)
		require.NoError(t, err)
		assert.True(t, prompted)
		assert.True(t, got)
	})

	t.Run("non-TTY without flags skips apply", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			false, false, false, false,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.False(t, got)
	})

	t.Run("yes alone on non-TTY applies without prompting", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			false, false, true, false,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.True(t, got)
	})

	t.Run("yes wins over TTY prompt", func(t *testing.T) {
		got, err := resolveDeclarativeSyncShouldApply(
			false, false, true, true,
			func() (bool, error) {
				t.Fatal("prompt should not be called")
				return false, nil
			},
		)
		require.NoError(t, err)
		assert.True(t, got)
	})

	t.Run("prompt error propagates", func(t *testing.T) {
		expected := errors.New("interrupt")
		_, err := resolveDeclarativeSyncShouldApply(
			false, false, false, true,
			func() (bool, error) {
				return false, expected
			},
		)
		assert.ErrorIs(t, err, expected)
	})
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

func TestDockerImageTag(t *testing.T) {
	testCases := map[string]string{
		"public.ecr.aws/supabase/postgres:17.6.1.138": "17.6.1.138",
		"localhost:5000/supabase/postgres:17.6.1.138": "17.6.1.138",
		"supabase/postgres":                           "",
	}
	for image, expected := range testCases {
		t.Run(image, func(t *testing.T) {
			assert.Equal(t, expected, dockerImageTag(image))
		})
	}
}

func TestEnsureLocalPostgresImageCurrent(t *testing.T) {
	originalImage := utils.Config.Db.Image
	originalSuggestion := utils.CmdSuggestion
	t.Cleanup(func() {
		utils.Config.Db.Image = originalImage
		utils.CmdSuggestion = originalSuggestion
	})
	utils.Config.Db.Image = "supabase/postgres:17.6.1.138"
	expectedImage := utils.GetRegistryImageUrl(utils.Config.Db.Image)

	t.Run("passes when no local container exists", func(t *testing.T) {
		utils.CmdSuggestion = ""
		err := ensureLocalPostgresImageCurrent(context.Background(), func(context.Context, string) (container.InspectResponse, error) {
			return container.InspectResponse{}, errdefs.ErrNotFound
		})

		assert.NoError(t, err)
		assert.Empty(t, utils.CmdSuggestion)
	})

	t.Run("passes when local container image matches expected postgres image", func(t *testing.T) {
		utils.CmdSuggestion = ""
		err := ensureLocalPostgresImageCurrent(context.Background(), func(_ context.Context, containerID string) (container.InspectResponse, error) {
			assert.Equal(t, utils.DbId, containerID)
			return container.InspectResponse{Config: &container.Config{Image: expectedImage}}, nil
		})

		assert.NoError(t, err)
		assert.Empty(t, utils.CmdSuggestion)
	})

	t.Run("passes when registry differs but postgres tag matches", func(t *testing.T) {
		utils.CmdSuggestion = ""
		err := ensureLocalPostgresImageCurrent(context.Background(), func(context.Context, string) (container.InspectResponse, error) {
			return container.InspectResponse{Config: &container.Config{Image: "docker.io/supabase/postgres:17.6.1.138"}}, nil
		})

		assert.NoError(t, err)
		assert.Empty(t, utils.CmdSuggestion)
	})

	t.Run("fails when local container image is stale", func(t *testing.T) {
		utils.CmdSuggestion = ""
		err := ensureLocalPostgresImageCurrent(context.Background(), func(context.Context, string) (container.InspectResponse, error) {
			return container.InspectResponse{Config: &container.Config{Image: "public.ecr.aws/supabase/postgres:17.6.1.106"}}, nil
		})

		assert.ErrorContains(t, err, "local Postgres container image is stale")
		assert.ErrorContains(t, err, "17.6.1.106")
		assert.ErrorContains(t, err, "17.6.1.138")
		assert.Contains(t, utils.CmdSuggestion, "supabase stop --all --no-backup")
		assert.Contains(t, utils.CmdSuggestion, "supabase start")
	})
}

func TestHasDeclarativeFiles(t *testing.T) {
	t.Run("returns false when dir does not exist", func(t *testing.T) {
		assert.False(t, hasDeclarativeFiles(mockFsys()))
	})

	t.Run("returns false when dir is empty", func(t *testing.T) {
		fsys := mockFsys()
		require.NoError(t, fsys.MkdirAll(utils.GetDeclarativeDir(), 0755))
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

func TestSaveApplyDebugBundle(t *testing.T) {
	t.Run("saves debug artifacts with expected content", func(t *testing.T) {
		fsys := afero.NewMemMapFs()
		// Write a migration file so it can be copied into the debug bundle
		migrationFile := "20240101000000_init.sql"
		migrationContent := "create table downloads(id bigint);"
		require.NoError(t, afero.WriteFile(fsys, filepath.Join(utils.MigrationsDir, migrationFile), []byte(migrationContent), 0644))

		result := &declarative.SyncResult{
			DiffSQL:   "ALTER TABLE downloads ADD COLUMN viewed_at timestamptz;",
			SourceRef: "",
			TargetRef: "",
		}
		applyErr := errors.New("ERROR: column \"viewed_at\" of relation \"downloads\" already exists (SQLSTATE 42701)")

		debugDir := saveApplyDebugBundle("test-apply-error", result, applyErr, fsys)

		require.NotEmpty(t, debugDir)

		// Verify error file
		errorContent, err := afero.ReadFile(fsys, filepath.Join(debugDir, "error.txt"))
		require.NoError(t, err)
		assert.Contains(t, string(errorContent), "column \"viewed_at\"")

		// Verify migration SQL file
		generatedSQL, err := afero.ReadFile(fsys, filepath.Join(debugDir, "generated-migration.sql"))
		require.NoError(t, err)
		assert.Equal(t, result.DiffSQL, string(generatedSQL))

		// Verify migration file was copied with full content
		copiedMigration, err := afero.ReadFile(fsys, filepath.Join(debugDir, "migrations", migrationFile))
		require.NoError(t, err)
		assert.Equal(t, migrationContent, string(copiedMigration))
	})

	t.Run("returns empty string when save fails", func(t *testing.T) {
		// Use a read-only filesystem to force a save error
		fsys := afero.NewReadOnlyFs(afero.NewMemMapFs())
		result := &declarative.SyncResult{
			DiffSQL: "SELECT 1;",
		}

		debugDir := saveApplyDebugBundle("test-fail", result, errors.New("some error"), fsys)

		assert.Empty(t, debugDir)
	})
}
