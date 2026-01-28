package dev

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"regexp"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/network"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/parser"
)

// DiffResult contains the outcome of a schema diff
type DiffResult struct {
	SQL      string
	HasDrops bool
	Drops    []string
}

// https://github.com/djrobstep/migra/blob/master/migra/statements.py#L6
var dropStatementPattern = regexp.MustCompile(`(?i)drop\s+`)

// shadowState holds the persistent shadow database state
var shadowState = &ShadowState{}

// DiffAndApply computes the diff between declared schemas and local DB, then applies changes.
// Returns true if any changes were applied (marking the session as dirty).
func DiffAndApply(ctx context.Context, fsys afero.Fs, w io.Writer) (bool, error) {
	totalStart := time.Now()

	// Step 1: Ensure shadow database is ready (uses template for fast reset)
	fmt.Fprintln(w, "Preparing shadow database...")
	stepStart := time.Now()
	shadowConfig, err := shadowState.EnsureShadowReady(ctx, fsys)
	if err != nil {
		return false, errors.Errorf("failed to prepare shadow database: %w", err)
	}
	timingLog.Printf("Shadow DB ready: %dms", time.Since(stepStart).Milliseconds())

	// Step 2: Apply declared schemas to shadow
	declared, err := loadSchemaFiles(fsys)
	if err != nil {
		return false, err
	}

	if len(declared) > 0 {
		fmt.Fprintln(w, "Applying declared schemas to shadow...")
		stepStart = time.Now()
		if err := shadowState.ApplyDeclaredSchemas(ctx, declared, fsys); err != nil {
			return false, err
		}
		timingLog.Printf("Schemas applied to shadow: %dms", time.Since(stepStart).Milliseconds())
	}

	// Step 3: Diff local DB (current state) vs shadow (desired state) using pg-delta
	localConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}

	fmt.Fprintln(w, "Computing diff with pg-delta...")
	stepStart = time.Now()
	// source = local DB (current state), target = shadow DB (desired state)
	result, err := computeDiffPgDelta(ctx, localConfig, shadowConfig)
	if err != nil {
		return false, errors.Errorf("failed to compute diff: %w", err)
	}
	timingLog.Printf("pg-delta diff: %dms", time.Since(stepStart).Milliseconds())

	// Log the computed diff SQL in debug mode
	if result.SQL != "" {
		sqlLog.Printf("pg-delta computed diff:\n%s", result.SQL)
	}

	if result.SQL == "" {
		fmt.Fprintf(w, "%s No schema changes detected\n", utils.Green("✓"))
		timingLog.Printf("Total: %dms", time.Since(totalStart).Milliseconds())
		return false, nil
	}

	// Step 4: Show warnings for DROP statements
	if result.HasDrops {
		fmt.Fprintf(w, "%s Found DROP statements:\n", utils.Yellow("Warning:"))
		for _, drop := range result.Drops {
			fmt.Fprintf(w, "    %s\n", utils.Yellow(drop))
		}
	}

	// Step 5: Apply changes to local database
	fmt.Fprintln(w, "Applying changes to local database...")
	stepStart = time.Now()
	if err := applyDiff(ctx, localConfig, result.SQL); err != nil {
		return false, errors.Errorf("failed to apply changes: %w", err)
	}
	timingLog.Printf("Applied to local DB: %dms", time.Since(stepStart).Milliseconds())

	fmt.Fprintf(w, "%s Schema changes applied successfully\n", utils.Green("✓"))
	showAppliedStatements(w, result.SQL)

	timingLog.Printf("Total: %dms", time.Since(totalStart).Milliseconds())
	return true, nil
}

// CleanupShadow removes the persistent shadow container
func CleanupShadow(ctx context.Context) {
	shadowState.Cleanup(ctx)
}

// InvalidateShadowTemplate marks the shadow template as needing rebuild
// Call this when migrations change so the shadow rebuilds with new migrations
func InvalidateShadowTemplate() {
	shadowState.TemplateReady = false
	shadowState.MigrationsHash = ""
	timingLog.Printf("Shadow template invalidated - will rebuild on next diff")
}

const (
	// Bun image for running pg-delta CLI
	bunImage = "oven/bun:canary-alpine"
	// Volume name for caching Bun packages
	bunCacheVolume = "supabase_bun_cache"
	// pg-delta package version
	pgDeltaPackage = "@supabase/pg-delta@1.0.0-alpha.2"
)

// computeDiffPgDelta uses pg-delta (via Bun container) to compute the difference
// source = current state (local DB), target = desired state (shadow DB)
//
// pg-delta exit codes:
//   - 0: No changes detected (stdout: "No changes detected.")
//   - 2: Changes detected (stdout: SQL statements)
//   - other: Error
func computeDiffPgDelta(ctx context.Context, source, target pgconn.Config) (*DiffResult, error) {
	sourceURL := utils.ToPostgresURL(source)
	targetURL := utils.ToPostgresURL(target)

	// Build the pg-delta CLI command
	cmd := []string{
		"x", pgDeltaPackage, "plan",
		"--source", sourceURL,
		"--target", targetURL,
		"--integration", "supabase",
		"--format", "sql",
		"--role", "postgres",
	}

	var stdout, stderr bytes.Buffer
	err := utils.DockerRunOnceWithConfig(
		ctx,
		container.Config{
			Image: bunImage,
			Cmd:   cmd,
			Env:   []string{"BUN_INSTALL_CACHE_DIR=/bun-cache"},
		},
		container.HostConfig{
			Binds:       []string{bunCacheVolume + ":/bun-cache:rw"},
			NetworkMode: network.NetworkHost,
		},
		network.NetworkingConfig{},
		"",
		&stdout,
		&stderr,
	)

	// Trim whitespace from output
	output := strings.TrimSpace(stdout.String())

	// Handle pg-delta exit codes:
	// - Exit 0: No changes (output may be "No changes detected." or similar)
	// - Exit 2: Changes detected (output contains SQL)
	// - Other exits: Real errors
	if err != nil {
		// Check if it's exit code 2 (changes detected) - this is expected
		if strings.Contains(err.Error(), "exit 2") {
			// Exit 2 means changes were detected, stdout has the SQL
			drops := findDropStatements(output)
			return &DiffResult{
				SQL:      output,
				HasDrops: len(drops) > 0,
				Drops:    drops,
			}, nil
		}
		// Any other error is a real failure
		return nil, errors.Errorf("pg-delta failed: %w\n%s", err, stderr.String())
	}

	// Exit 0: No changes detected
	// Check for "No changes" message or empty output
	if output == "" || strings.Contains(strings.ToLower(output), "no changes") {
		return &DiffResult{
			SQL:      "",
			HasDrops: false,
			Drops:    nil,
		}, nil
	}

	// Exit 0 but has SQL output - treat as changes (shouldn't normally happen)
	drops := findDropStatements(output)
	return &DiffResult{
		SQL:      output,
		HasDrops: len(drops) > 0,
		Drops:    drops,
	}, nil
}

// findDropStatements extracts DROP statements from SQL
func findDropStatements(sql string) []string {
	lines, err := parser.SplitAndTrim(strings.NewReader(sql))
	if err != nil {
		return nil
	}
	var drops []string
	for _, line := range lines {
		if dropStatementPattern.MatchString(line) {
			drops = append(drops, line)
		}
	}
	return drops
}

// applyDiff executes the diff SQL on the target database without recording in migration history
func applyDiff(ctx context.Context, config pgconn.Config, sql string) error {
	conn, err := utils.ConnectLocalPostgres(ctx, config)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	// Parse the SQL into statements
	m, err := migration.NewMigrationFromReader(strings.NewReader(sql))
	if err != nil {
		return errors.Errorf("failed to parse diff SQL: %w", err)
	}

	// Skip inserting to migration history (no version = no history entry)
	m.Version = ""

	// Execute the statements
	return m.ExecBatch(ctx, conn)
}

// showAppliedStatements prints the applied SQL statements
func showAppliedStatements(w io.Writer, sql string) {
	lines, err := parser.SplitAndTrim(strings.NewReader(sql))
	if err != nil {
		return
	}

	fmt.Fprintln(w, "Applied:")
	for _, line := range lines {
		// Skip empty lines and comments
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || strings.HasPrefix(trimmed, "--") {
			continue
		}
		fmt.Fprintf(w, "    %s\n", line)
	}
}
