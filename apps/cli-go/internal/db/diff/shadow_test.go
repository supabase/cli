package diff

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

func TestPreparePgDeltaNextShadow(t *testing.T) {
	originalConfig := utils.Config
	t.Cleanup(func() { utils.Config = originalConfig })
	utils.Config.Hostname = "shadow-host"
	utils.Config.Db.ShadowPort = 6543
	utils.Config.Db.Password = "secret"
	utils.Config.Db.HealthTimeout = 7 * time.Second

	var waitedContainer string
	var migratedContainer string
	var scratchCreated bool
	var removedContainer string
	dependencies := pgDeltaNextShadowDependencies{
		create: func(_ context.Context, port uint16) (string, error) {
			assert.Equal(t, uint16(6543), port)
			return "shadow-container", nil
		},
		wait: func(_ context.Context, timeout time.Duration, containers ...string) error {
			assert.Equal(t, 7*time.Second, timeout)
			require.Len(t, containers, 1)
			waitedContainer = containers[0]
			return nil
		},
		migrate: func(_ context.Context, container string, _ afero.Fs, _ ...func(*pgx.ConnConfig)) error {
			migratedContainer = container
			return nil
		},
		createScratch: func(_ context.Context, _ ...func(*pgx.ConnConfig)) error {
			scratchCreated = true
			return nil
		},
		remove: func(container string) { removedContainer = container },
	}

	result, err := preparePgDeltaNextShadow(context.Background(), afero.NewMemMapFs(), dependencies)

	require.NoError(t, err)
	assert.Equal(t, "shadow-container", result.Container)
	assert.Equal(t, "shadow-container", waitedContainer)
	assert.Equal(t, "shadow-container", migratedContainer)
	assert.True(t, scratchCreated)
	assert.Empty(t, removedContainer)
	assert.Equal(t, "shadow-host", result.Migrated.Host)
	assert.Equal(t, uint16(6543), result.Migrated.Port)
	assert.Equal(t, "postgres", result.Migrated.User)
	assert.Equal(t, "secret", result.Migrated.Password)
	assert.Equal(t, "postgres", result.Migrated.Database)
	assert.Equal(t, result.Migrated.Host, result.Scratch.Host)
	assert.Equal(t, result.Migrated.Port, result.Scratch.Port)
	assert.Equal(t, result.Migrated.User, result.Scratch.User)
	assert.Equal(t, result.Migrated.Password, result.Scratch.Password)
	assert.Equal(t, "pgdelta_declarative", result.Scratch.Database)
}

func TestPreparePgDeltaNextShadowRemovesContainerAfterFailure(t *testing.T) {
	originalConfig := utils.Config
	t.Cleanup(func() { utils.Config = originalConfig })
	wantErr := errors.New("migration failed")
	var removedContainer string
	dependencies := pgDeltaNextShadowDependencies{
		create: func(context.Context, uint16) (string, error) {
			return "failed-shadow", nil
		},
		wait: func(context.Context, time.Duration, ...string) error { return nil },
		migrate: func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error {
			return wantErr
		},
		createScratch: func(context.Context, ...func(*pgx.ConnConfig)) error { return nil },
		remove:        func(container string) { removedContainer = container },
	}

	result, err := preparePgDeltaNextShadow(context.Background(), afero.NewMemMapFs(), dependencies)

	assert.ErrorIs(t, err, wantErr)
	assert.Empty(t, result.Container)
	assert.Equal(t, "failed-shadow", removedContainer)
}

func TestPreparePgDeltaNextShadowRemovesContainerAfterScratchFailure(t *testing.T) {
	originalConfig := utils.Config
	t.Cleanup(func() { utils.Config = originalConfig })
	wantErr := errors.New("scratch creation failed")
	var removedContainer string
	dependencies := pgDeltaNextShadowDependencies{
		create: func(context.Context, uint16) (string, error) {
			return "failed-scratch-shadow", nil
		},
		wait: func(context.Context, time.Duration, ...string) error { return nil },
		migrate: func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error {
			return nil
		},
		createScratch: func(context.Context, ...func(*pgx.ConnConfig)) error { return wantErr },
		remove:        func(container string) { removedContainer = container },
	}

	result, err := preparePgDeltaNextShadow(context.Background(), afero.NewMemMapFs(), dependencies)

	assert.ErrorIs(t, err, wantErr)
	assert.Empty(t, result.Container)
	assert.Equal(t, "failed-scratch-shadow", removedContainer)
}
