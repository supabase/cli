package push

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/parser"
)

// DriftResult contains drift detection outcome
type DriftResult struct {
	HasDrift bool
	DiffSQL  string
	Drops    []string // DROP statements found
}

// DriftAction represents user's choice when drift is detected
type DriftAction int

const (
	DriftActionCreateMigration DriftAction = iota
	DriftActionContinue
	DriftActionCancel
)

// https://github.com/djrobstep/migra/blob/master/migra/statements.py#L6
var dropStatementPattern = regexp.MustCompile(`(?i)drop\s+`)

// CheckLocalDrift compares local database state against what migrations would produce.
// It creates a shadow database, applies all migrations, then diffs local DB against shadow.
// Returns the diff SQL (empty if no drift).
func CheckLocalDrift(ctx context.Context, fsys afero.Fs) (*DriftResult, error) {
	fmt.Fprintln(os.Stderr, "Checking for uncommitted schema changes...")

	// 1. Create shadow database
	shadow, err := diff.CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return nil, errors.Errorf("failed to create shadow database: %w", err)
	}
	defer utils.DockerRemove(shadow)

	// 2. Wait for shadow to be healthy
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		return nil, errors.Errorf("shadow database unhealthy: %w", err)
	}

	// 3. Apply migrations to shadow (this is the "expected" state)
	if err := diff.MigrateShadowDatabase(ctx, shadow, fsys); err != nil {
		return nil, errors.Errorf("failed to migrate shadow: %w", err)
	}

	// 4. Configure connections
	localConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.Port,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}

	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}

	// 5. Diff: shadow (source/expected) vs local (target/actual)
	// This gives us SQL to transform shadow -> local
	// i.e., the changes that exist in local but not in migrations
	diffSQL, err := diff.DiffPgDelta(ctx, shadowConfig, localConfig, nil)
	if err != nil {
		return nil, errors.Errorf("failed to compute drift: %w", err)
	}

	result := &DriftResult{
		HasDrift: strings.TrimSpace(diffSQL) != "",
		DiffSQL:  diffSQL,
	}

	if result.HasDrift {
		result.Drops = findDropStatements(diffSQL)
	}

	return result, nil
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

// FormatDriftWarning formats the warning message for display
func FormatDriftWarning(result *DriftResult) string {
	var sb strings.Builder

	sb.WriteString("\n")
	sb.WriteString(utils.Yellow("Warning:") + " Local database has uncommitted schema changes!\n\n")
	sb.WriteString("The following changes exist in your local database but NOT in your migration files:\n\n")

	// Format the SQL with indentation
	for _, line := range strings.Split(strings.TrimSpace(result.DiffSQL), "\n") {
		if strings.TrimSpace(line) != "" {
			sb.WriteString("  " + line + "\n")
		}
	}

	sb.WriteString("\n")
	sb.WriteString("These changes will NOT be applied to the remote database.\n")

	return sb.String()
}

// PromptDriftAction asks user what to do about detected drift
func PromptDriftAction(ctx context.Context) (DriftAction, error) {
	items := []utils.PromptItem{
		{Summary: "Create a migration with these changes", Index: int(DriftActionCreateMigration)},
		{Summary: "Continue pushing without these changes", Index: int(DriftActionContinue)},
		{Summary: "Cancel", Index: int(DriftActionCancel)},
	}

	choice, err := utils.PromptChoice(ctx, "What would you like to do?", items, tea.WithOutput(os.Stderr))
	if err != nil {
		if errors.Is(err, context.Canceled) {
			return DriftActionCancel, nil
		}
		return DriftActionCancel, err
	}

	return DriftAction(choice.Index), nil
}

// CreateMigrationFromDrift creates a migration file using the already-computed SQL.
// Returns the path to the created migration file.
func CreateMigrationFromDrift(ctx context.Context, sql string, fsys afero.Fs) (string, error) {
	// Prompt for migration name
	console := utils.NewConsole()
	name, err := console.PromptText(ctx, "Migration name: ")
	if err != nil {
		return "", errors.Errorf("failed to read migration name: %w", err)
	}

	name = strings.TrimSpace(name)
	if name == "" {
		return "", errors.New("migration name cannot be empty")
	}

	// Sanitize the name (replace spaces with underscores, remove special chars)
	name = sanitizeMigrationName(name)

	// Generate the migration path
	path := new.GetMigrationPath(utils.GetCurrentTimestamp(), name)

	// Ensure migrations directory exists
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return "", errors.Errorf("failed to create migrations directory: %w", err)
	}

	// Write the migration file
	if err := utils.WriteFile(path, []byte(sql), fsys); err != nil {
		return "", errors.Errorf("failed to write migration file: %w", err)
	}

	return path, nil
}

// sanitizeMigrationName cleans up a migration name for use in a filename
func sanitizeMigrationName(name string) string {
	// Replace spaces with underscores
	name = strings.ReplaceAll(name, " ", "_")
	// Remove any characters that aren't alphanumeric or underscores
	var result strings.Builder
	for _, r := range name {
		if (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z') || (r >= '0' && r <= '9') || r == '_' {
			result.WriteRune(r)
		}
	}
	return result.String()
}
