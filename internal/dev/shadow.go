package dev

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"sort"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

// ShadowState manages a persistent shadow database for fast diffing
type ShadowState struct {
	ContainerID    string
	BaselineRoles  []string // Roles after migrations, before declared schemas
	TemplateReady  bool
	MigrationsHash string // Invalidate template if migrations change
}

// shadowContainerName returns the name for the shadow container
func shadowContainerName() string {
	return "supabase_db_" + utils.Config.ProjectId + "_shadow"
}

// EnsureShadowReady prepares the shadow database for diffing
// Returns the shadow database config for connecting
func (s *ShadowState) EnsureShadowReady(ctx context.Context, fsys afero.Fs) (pgconn.Config, error) {
	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "contrib_regression",
	}

	// Check if container exists and is healthy
	healthy, err := s.isContainerHealthy(ctx)
	if err != nil {
		return shadowConfig, err
	}

	if !healthy {
		// Cold start: create container, apply migrations, create template
		timingLog.Printf("Shadow container not ready, performing cold start...")
		if err := s.coldStart(ctx, fsys); err != nil {
			return shadowConfig, err
		}
		return shadowConfig, nil
	}

	// Check if migrations changed (invalidates template)
	currentHash, err := s.hashMigrations(fsys)
	if err != nil {
		return shadowConfig, err
	}

	if currentHash != s.MigrationsHash {
		timingLog.Printf("Migrations changed, rebuilding template...")
		if err := s.rebuildTemplate(ctx, fsys); err != nil {
			return shadowConfig, err
		}
		return shadowConfig, nil
	}

	// Fast path: reset from template
	timingLog.Printf("Using fast path: reset from template")
	if err := s.resetFromTemplate(ctx); err != nil {
		return shadowConfig, err
	}

	return shadowConfig, nil
}

// isContainerHealthy checks if the shadow container exists and is healthy
func (s *ShadowState) isContainerHealthy(ctx context.Context) (bool, error) {
	if s.ContainerID == "" {
		// Try to find existing container by name
		containers, err := utils.Docker.ContainerList(ctx, container.ListOptions{All: true})
		if err != nil {
			return false, errors.Errorf("failed to list containers: %w", err)
		}

		name := "/" + shadowContainerName()
		for _, c := range containers {
			for _, n := range c.Names {
				if n == name {
					s.ContainerID = c.ID
					break
				}
			}
		}

		if s.ContainerID == "" {
			return false, nil
		}
	}

	// Check if container is running and healthy
	inspect, err := utils.Docker.ContainerInspect(ctx, s.ContainerID)
	if err != nil {
		// Container doesn't exist anymore
		s.ContainerID = ""
		s.TemplateReady = false
		return false, nil
	}

	if !inspect.State.Running {
		// Container exists but not running, start it
		if err := utils.Docker.ContainerStart(ctx, s.ContainerID, container.StartOptions{}); err != nil {
			return false, errors.Errorf("failed to start shadow container: %w", err)
		}
		// Wait for healthy
		if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, s.ContainerID); err != nil {
			return false, errors.Errorf("shadow container unhealthy: %w", err)
		}
	}

	return s.TemplateReady, nil
}

// coldStart creates container and builds initial template
func (s *ShadowState) coldStart(ctx context.Context, fsys afero.Fs) error {
	// 1. Remove any existing shadow container
	if s.ContainerID != "" {
		_ = utils.Docker.ContainerRemove(ctx, s.ContainerID, container.RemoveOptions{Force: true})
	}

	// 2. Create and start shadow container with a proper name
	name := shadowContainerName()
	containerID, err := diff.CreateShadowDatabaseWithName(ctx, utils.Config.Db.ShadowPort, name, false)
	if err != nil {
		return errors.Errorf("failed to create shadow container: %w", err)
	}
	s.ContainerID = containerID
	timingLog.Printf("Created shadow container: %s (%s)", name, containerID[:12])

	// 3. Wait for healthy
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, s.ContainerID); err != nil {
		return errors.Errorf("shadow container unhealthy: %w", err)
	}
	timingLog.Printf("Shadow container started")

	// 4. Apply migrations
	if err := diff.MigrateShadowDatabase(ctx, s.ContainerID, fsys); err != nil {
		return errors.Errorf("failed to migrate shadow: %w", err)
	}
	timingLog.Printf("Migrations applied to shadow")

	// 5. Snapshot baseline roles
	baselineRoles, err := s.queryRoles(ctx)
	if err != nil {
		return errors.Errorf("failed to query baseline roles: %w", err)
	}
	s.BaselineRoles = baselineRoles
	timingLog.Printf("Captured %d baseline roles", len(baselineRoles))

	// 6. Create template from current state
	if err := s.createTemplate(ctx); err != nil {
		return errors.Errorf("failed to create template: %w", err)
	}

	// 7. Store migrations hash
	hash, err := s.hashMigrations(fsys)
	if err != nil {
		return err
	}
	s.MigrationsHash = hash
	s.TemplateReady = true

	return nil
}

// rebuildTemplate rebuilds the template after migrations change
func (s *ShadowState) rebuildTemplate(ctx context.Context, fsys afero.Fs) error {
	// Connect and drop existing template
	conn, err := s.connectPostgres(ctx)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	// Drop template if exists
	_, _ = conn.Exec(ctx, "DROP DATABASE IF EXISTS shadow_template")
	_, _ = conn.Exec(ctx, "DROP DATABASE IF EXISTS contrib_regression")

	// Recreate contrib_regression and apply migrations
	_, err = conn.Exec(ctx, "CREATE DATABASE contrib_regression")
	if err != nil {
		return errors.Errorf("failed to create contrib_regression: %w", err)
	}
	conn.Close(ctx)

	// Apply migrations
	if err := diff.MigrateShadowDatabase(ctx, s.ContainerID, fsys); err != nil {
		return errors.Errorf("failed to migrate shadow: %w", err)
	}

	// Snapshot baseline roles
	baselineRoles, err := s.queryRoles(ctx)
	if err != nil {
		return err
	}
	s.BaselineRoles = baselineRoles

	// Create new template
	if err := s.createTemplate(ctx); err != nil {
		return err
	}

	// Update hash
	hash, err := s.hashMigrations(fsys)
	if err != nil {
		return err
	}
	s.MigrationsHash = hash
	s.TemplateReady = true

	return nil
}

// resetFromTemplate quickly resets the database state
func (s *ShadowState) resetFromTemplate(ctx context.Context) error {
	conn, err := s.connectPostgres(ctx)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	// 1. Clean cluster-wide objects created by declared schemas
	currentRoles, err := s.queryRolesWithConn(ctx, conn)
	if err != nil {
		return err
	}

	for _, role := range currentRoles {
		if !contains(s.BaselineRoles, role) {
			timingLog.Printf("Dropping role created by declared schema: %s", role)
			_, _ = conn.Exec(ctx, fmt.Sprintf("DROP ROLE IF EXISTS %q", role))
		}
	}

	// 2. Terminate connections to contrib_regression
	_, _ = conn.Exec(ctx, `
		SELECT pg_terminate_backend(pid)
		FROM pg_stat_activity
		WHERE datname = 'contrib_regression' AND pid <> pg_backend_pid()
	`)

	// 3. Reset database from template
	_, err = conn.Exec(ctx, "DROP DATABASE IF EXISTS contrib_regression")
	if err != nil {
		return errors.Errorf("failed to drop contrib_regression: %w", err)
	}

	_, err = conn.Exec(ctx, "CREATE DATABASE contrib_regression TEMPLATE shadow_template")
	if err != nil {
		return errors.Errorf("failed to create from template: %w", err)
	}

	timingLog.Printf("Database reset from template")
	return nil
}

// createTemplate creates the shadow_template database from current state
func (s *ShadowState) createTemplate(ctx context.Context) error {
	conn, err := s.connectPostgres(ctx)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)

	// Terminate connections to contrib_regression before using as template
	_, _ = conn.Exec(ctx, `
		SELECT pg_terminate_backend(pid)
		FROM pg_stat_activity
		WHERE datname = 'contrib_regression' AND pid <> pg_backend_pid()
	`)

	// Create template
	_, err = conn.Exec(ctx, "CREATE DATABASE shadow_template TEMPLATE contrib_regression")
	if err != nil {
		return errors.Errorf("failed to create template: %w", err)
	}

	timingLog.Printf("Template database created")
	return nil
}

// connectPostgres connects to the shadow's postgres database (not contrib_regression)
func (s *ShadowState) connectPostgres(ctx context.Context) (*pgx.Conn, error) {
	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	return utils.ConnectLocalPostgres(ctx, config)
}

// queryRoles returns all non-system roles
func (s *ShadowState) queryRoles(ctx context.Context) ([]string, error) {
	conn, err := s.connectPostgres(ctx)
	if err != nil {
		return nil, err
	}
	defer conn.Close(ctx)
	return s.queryRolesWithConn(ctx, conn)
}

// queryRolesWithConn returns all non-system roles using existing connection
func (s *ShadowState) queryRolesWithConn(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	rows, err := conn.Query(ctx, `
		SELECT rolname FROM pg_roles
		WHERE rolname NOT LIKE 'pg_%'
		ORDER BY rolname
	`)
	if err != nil {
		return nil, errors.Errorf("failed to query roles: %w", err)
	}
	defer rows.Close()

	var roles []string
	for rows.Next() {
		var role string
		if err := rows.Scan(&role); err != nil {
			return nil, err
		}
		roles = append(roles, role)
	}
	return roles, rows.Err()
}

// hashMigrations computes a hash of all migration files
func (s *ShadowState) hashMigrations(fsys afero.Fs) (string, error) {
	h := sha256.New()

	migrationsDir := filepath.Join(utils.SupabaseDirPath, "migrations")
	files, err := afero.ReadDir(fsys, migrationsDir)
	if err != nil {
		// No migrations directory is valid
		return hex.EncodeToString(h.Sum(nil)), nil
	}

	// Sort files by name for consistent ordering
	sort.Slice(files, func(i, j int) bool {
		return files[i].Name() < files[j].Name()
	})

	for _, f := range files {
		if f.IsDir() {
			continue
		}
		content, err := afero.ReadFile(fsys, filepath.Join(migrationsDir, f.Name()))
		if err != nil {
			return "", errors.Errorf("failed to read migration %s: %w", f.Name(), err)
		}
		h.Write([]byte(f.Name()))
		h.Write(content)
	}

	// Also include seed files that affect shadow state
	seedDir := filepath.Join(utils.SupabaseDirPath, "seed")
	seedFiles, _ := afero.ReadDir(fsys, seedDir)
	for _, f := range seedFiles {
		if f.IsDir() {
			continue
		}
		content, _ := afero.ReadFile(fsys, filepath.Join(seedDir, f.Name()))
		h.Write([]byte(f.Name()))
		h.Write(content)
	}

	return hex.EncodeToString(h.Sum(nil)), nil
}

// Cleanup removes the shadow container
func (s *ShadowState) Cleanup(ctx context.Context) {
	// Use a fresh context with timeout for cleanup - the original context
	// may be cancelled (e.g., from Ctrl+C) which would cause Docker API calls to fail
	cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	// If we have the container ID in memory, use it
	if s.ContainerID != "" {
		timingLog.Printf("Cleaning up shadow container: %s", s.ContainerID)
		if err := utils.Docker.ContainerRemove(cleanupCtx, s.ContainerID, container.RemoveOptions{Force: true}); err != nil {
			timingLog.Printf("Failed to remove shadow container: %v", err)
		} else {
			timingLog.Printf("Shadow container removed successfully")
		}
		s.ContainerID = ""
		s.TemplateReady = false
		return
	}

	// Otherwise, look up the container by name
	name := shadowContainerName()
	containers, err := utils.Docker.ContainerList(cleanupCtx, container.ListOptions{All: true})
	if err != nil {
		timingLog.Printf("Failed to list containers for cleanup: %v", err)
		return
	}

	expectedName := "/" + name
	for _, c := range containers {
		for _, n := range c.Names {
			if n == expectedName {
				timingLog.Printf("Found shadow container by name, removing: %s", c.ID)
				if err := utils.Docker.ContainerRemove(cleanupCtx, c.ID, container.RemoveOptions{Force: true}); err != nil {
					timingLog.Printf("Failed to remove shadow container: %v", err)
				} else {
					timingLog.Printf("Shadow container removed successfully")
				}
				s.TemplateReady = false
				return
			}
		}
	}
}

// ApplyDeclaredSchemas applies declared schema files to the shadow database
func (s *ShadowState) ApplyDeclaredSchemas(ctx context.Context, schemas []string, fsys afero.Fs) error {
	if len(schemas) == 0 {
		return nil
	}

	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "contrib_regression",
	}

	conn, err := utils.ConnectLocalPostgres(ctx, config)
	if err != nil {
		return errors.Errorf("failed to connect to shadow: %w", err)
	}
	defer conn.Close(ctx)

	if err := migration.SeedGlobals(ctx, schemas, conn, afero.NewIOFS(fsys)); err != nil {
		return errors.Errorf("failed to apply declared schemas: %w", err)
	}

	return nil
}

// contains checks if a slice contains a string
func contains(slice []string, item string) bool {
	for _, s := range slice {
		if s == item {
			return true
		}
	}
	return false
}
