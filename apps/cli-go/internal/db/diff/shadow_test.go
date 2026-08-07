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
	utils.Config.Db.Password = "secret"
	utils.Config.Db.HealthTimeout = 7 * time.Second

	ports := []int{6543, 7654}
	var createdPorts []uint16
	var waitedContainers []string
	var migratedPort uint16
	var setupPort uint16
	var removedContainers []string
	dependencies := pgDeltaNextShadowDependencies{
		freePort: func() (int, error) {
			port := ports[0]
			ports = ports[1:]
			return port, nil
		},
		create: func(_ context.Context, port uint16) (string, error) {
			createdPorts = append(createdPorts, port)
			if port == 6543 {
				return "migrations-container", nil
			}
			return "declarative-container", nil
		},
		wait: func(_ context.Context, timeout time.Duration, containers ...string) error {
			assert.Equal(t, 7*time.Second, timeout)
			require.Len(t, containers, 1)
			waitedContainers = append(waitedContainers, containers[0])
			return nil
		},
		migrate: func(_ context.Context, container string, _ afero.Fs, options ...func(*pgx.ConnConfig)) error {
			assert.Equal(t, "migrations-container", container)
			config := &pgx.ConnConfig{}
			for _, option := range options {
				option(config)
			}
			migratedPort = config.Port
			return nil
		},
		setup: func(_ context.Context, container string, _ afero.Fs, options ...func(*pgx.ConnConfig)) error {
			assert.Equal(t, "declarative-container", container)
			config := &pgx.ConnConfig{}
			for _, option := range options {
				option(config)
			}
			setupPort = config.Port
			return nil
		},
		remove: func(container string) { removedContainers = append(removedContainers, container) },
	}

	result, err := preparePgDeltaNextShadow(context.Background(), afero.NewMemMapFs(), dependencies)

	require.NoError(t, err)
	assert.Equal(t, []uint16{6543, 7654}, createdPorts)
	assert.Equal(t, []string{"migrations-container", "declarative-container"}, waitedContainers)
	assert.Equal(t, uint16(6543), migratedPort)
	assert.Equal(t, uint16(7654), setupPort)
	assert.Empty(t, removedContainers)
	assert.Equal(t, "migrations-container", result.Migrations.Container)
	assert.Equal(t, "declarative-container", result.Declarative.Container)
	assert.Equal(t, pgDeltaNextShadowConfig(6543), result.Migrations.Config)
	assert.Equal(t, pgDeltaNextShadowConfig(7654), result.Declarative.Config)
	assert.Equal(t, "postgres", result.Migrations.Config.Database)
	assert.Equal(t, "postgres", result.Declarative.Config.Database)
}

func TestPreparePgDeltaNextShadowRemovesEveryCreatedContainerOnFailure(t *testing.T) {
	wantErr := errors.New("provisioning failed")
	tests := []struct {
		name        string
		failAt      string
		firstID     string
		secondID    string
		wantRemoved []string
	}{
		{name: "first port", failAt: "first-port"},
		{name: "first create without id", failAt: "first-create"},
		{name: "first create with id", failAt: "first-create", firstID: "migrations", wantRemoved: []string{"migrations"}},
		{name: "first health", failAt: "first-health", firstID: "migrations", wantRemoved: []string{"migrations"}},
		{name: "migrations", failAt: "migrate", firstID: "migrations", wantRemoved: []string{"migrations"}},
		{name: "second port", failAt: "second-port", firstID: "migrations", wantRemoved: []string{"migrations"}},
		{name: "second create without id", failAt: "second-create", firstID: "migrations", wantRemoved: []string{"migrations"}},
		{name: "second create with id", failAt: "second-create", firstID: "migrations", secondID: "declarative", wantRemoved: []string{"migrations", "declarative"}},
		{name: "second health", failAt: "second-health", firstID: "migrations", secondID: "declarative", wantRemoved: []string{"migrations", "declarative"}},
		{name: "declarative setup", failAt: "setup", firstID: "migrations", secondID: "declarative", wantRemoved: []string{"migrations", "declarative"}},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			portCalls := 0
			createCalls := 0
			var removed []string
			dependencies := pgDeltaNextShadowDependencies{
				freePort: func() (int, error) {
					portCalls++
					if (portCalls == 1 && tt.failAt == "first-port") || (portCalls == 2 && tt.failAt == "second-port") {
						return 0, wantErr
					}
					return 6000 + portCalls, nil
				},
				create: func(context.Context, uint16) (string, error) {
					createCalls++
					if createCalls == 1 {
						if tt.failAt == "first-create" {
							return tt.firstID, wantErr
						}
						return tt.firstID, nil
					}
					if tt.failAt == "second-create" {
						return tt.secondID, wantErr
					}
					return tt.secondID, nil
				},
				wait: func(_ context.Context, _ time.Duration, containers ...string) error {
					if (containers[0] == tt.firstID && tt.failAt == "first-health") || (containers[0] == tt.secondID && tt.failAt == "second-health") {
						return wantErr
					}
					return nil
				},
				migrate: func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error {
					if tt.failAt == "migrate" {
						return wantErr
					}
					return nil
				},
				setup: func(context.Context, string, afero.Fs, ...func(*pgx.ConnConfig)) error {
					if tt.failAt == "setup" {
						return wantErr
					}
					return nil
				},
				remove: func(container string) { removed = append(removed, container) },
			}

			result, err := preparePgDeltaNextShadow(context.Background(), afero.NewMemMapFs(), dependencies)

			assert.ErrorIs(t, err, wantErr)
			assert.Empty(t, result)
			assert.Equal(t, tt.wantRemoved, removed)
		})
	}
}

func TestAllocatePgDeltaNextPort(t *testing.T) {
	t.Run("retries a duplicate port", func(t *testing.T) {
		ports := []int{6543, 6544}
		port, err := allocatePgDeltaNextPort(func() (int, error) {
			result := ports[0]
			ports = ports[1:]
			return result, nil
		}, 6543)

		require.NoError(t, err)
		assert.Equal(t, uint16(6544), port)
	})

	for _, port := range []int{-1, 0, 65536} {
		t.Run("rejects invalid port", func(t *testing.T) {
			_, err := allocatePgDeltaNextPort(func() (int, error) { return port, nil }, 0)
			assert.ErrorContains(t, err, "outside the valid range")
		})
	}
}
