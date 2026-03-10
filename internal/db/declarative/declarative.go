package declarative

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/pgdelta"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
	"github.com/supabase/cli/pkg/parser"
)

const (
	// pgDeltaTempDir namespaces pg-delta artifacts under .temp to make ownership
	// and cleanup intent explicit.
	pgDeltaTempDir = "pgdelta"
	// baselineCatalogPath caches the catalog of an empty shadow database.
	//
	// It is used as the "source" baseline when generating declarative files from
	// a real database target.
	baselineCatalogPath = "catalog-baseline.json"
	// migrationsCatalogName stores catalogs keyed by migration-content hash so
	// cache reuse is deterministic and invalidates automatically on migration edits.
	migrationsCatalogName = "catalog-migrations-%s.json"
	// noCacheCatalogPath is a throwaway snapshot path used when --no-cache is set.
	noCacheCatalogPath = "catalog-nocache.json"
)

var (
	// schemaPathsPattern locates existing schema_paths in config so declarative
	// writes can replace stale values rather than appending duplicates.
	schemaPathsPattern = regexp.MustCompile(`(?s)\nschema_paths = \[(.*?)\]\n`)
	// dropStatementRegexp flags potentially destructive statements for UX warnings
	// when generating migration output from declarative sources.
	dropStatementRegexp = regexp.MustCompile(`(?i)drop\s+`)
)

// Generate exports a live database schema into files under supabase/declarative.
//
// The workflow uses pg-delta catalogs so output can be deterministic and filtered
// by schema, then optionally prompts before replacing existing files.
func Generate(ctx context.Context, schema []string, config pgconn.Config, overwrite bool, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	sourceRef, err := getBaselineCatalogRef(ctx, noCache, fsys, options...)
	if err != nil {
		return err
	}
	output, err := diff.DeclarativeExportPgDeltaRef(ctx, sourceRef, utils.ToPostgresURL(config), schema, options...)
	if err != nil {
		return err
	}
	if !overwrite {
		ok, err := confirmOverwrite(ctx, fsys)
		if err != nil {
			return err
		}
		if !ok {
			fmt.Fprintln(os.Stderr, "Skipped writing declarative schema.")
			return nil
		}
	}
	if err := WriteDeclarativeSchemas(output, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Declarative schema written to "+utils.Bold(utils.DeclarativeDir))
	return nil
}

// SyncFromMigrations renders declarative files from local migration history.
//
// This gives teams a one-way conversion path from ordered migrations to
// declarative files without touching a remote database.
func SyncFromMigrations(ctx context.Context, schema []string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	targetRef, err := getMigrationsCatalogRef(ctx, noCache, fsys, options...)
	if err != nil {
		return err
	}
	output, err := diff.DeclarativeExportPgDeltaRef(ctx, "", targetRef, schema, options...)
	if err != nil {
		return err
	}
	if err := WriteDeclarativeSchemas(output, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Declarative schema synced from migrations.")
	return nil
}

// SyncToMigrations diffs local declarative files against migration state and
// writes the delta as a new migration file.
//
// This closes the loop so declarative-first edits can still flow back into the
// migration-based deployment pipeline.
func SyncToMigrations(ctx context.Context, schema []string, file string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if exists, err := afero.DirExists(fsys, utils.DeclarativeDir); err != nil {
		return err
	} else if !exists {
		return errors.Errorf("No declarative schema directory found. Run %s first.", utils.Aqua("supabase db declarative generate"))
	}
	sourceRef, err := getMigrationsCatalogRef(ctx, noCache, fsys, options...)
	if err != nil {
		return err
	}
	targetRef, err := getDeclarativeCatalogRef(ctx, fsys, options...)
	if err != nil {
		return err
	}
	out, err := diff.DiffPgDeltaRef(ctx, sourceRef, targetRef, schema, options...)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(file)) == 0 {
		file = "declarative_sync"
	}
	if err := diff.SaveDiff(out, file, fsys); err != nil {
		return err
	}
	drops := findDropStatements(out)
	if len(drops) > 0 {
		fmt.Fprintln(os.Stderr, "Found drop statements in schema diff. Please double check if these are expected:")
		fmt.Fprintln(os.Stderr, utils.Yellow(strings.Join(drops, "\n")))
	}
	return nil
}

// confirmOverwrite asks before replacing existing declarative files.
//
// This guard exists because declarative export rewrites the entire directory.
func confirmOverwrite(ctx context.Context, fsys afero.Fs) (bool, error) {
	exists, err := afero.DirExists(fsys, utils.DeclarativeDir)
	if err != nil || !exists {
		return true, err
	}
	files, err := afero.ReadDir(fsys, utils.DeclarativeDir)
	if err != nil {
		return false, err
	}
	if len(files) == 0 {
		return true, nil
	}
	msg := "Overwrite declarative schema? Existing files may be deleted."
	return utils.NewConsole().PromptYesNo(ctx, msg, false)
}

// WriteDeclarativeSchemas materializes pg-delta declarative output on disk and
// updates schema_paths so downstream commands read from declarative files.
func WriteDeclarativeSchemas(output diff.DeclarativeOutput, fsys afero.Fs) error {
	if err := fsys.RemoveAll(utils.DeclarativeDir); err != nil {
		return errors.Errorf("failed to clean declarative schema directory: %w", err)
	}
	if err := utils.MkdirIfNotExistFS(fsys, utils.DeclarativeDir); err != nil {
		return err
	}
	for _, file := range output.Files {
		relPath := filepath.FromSlash(filepath.Clean(file.Path))
		if strings.HasPrefix(relPath, "..") {
			return errors.Errorf("unsafe declarative export path: %s", file.Path)
		}
		targetPath := filepath.Join(utils.DeclarativeDir, relPath)
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(targetPath)); err != nil {
			return err
		}
		if err := utils.WriteFile(targetPath, []byte(file.SQL), fsys); err != nil {
			return err
		}
	}
	utils.Config.Db.Migrations.SchemaPaths = []string{
		filepath.Join(utils.DeclarativeDir),
	}
	return updateDeclarativeSchemaPathsConfig(fsys)
}

// updateDeclarativeSchemaPathsConfig ensures config.toml points to declarative
// SQL files after generate/sync operations.
//
// This makes declarative output the active source of truth for commands that
// read schema paths from config.
func updateDeclarativeSchemaPathsConfig(fsys afero.Fs) error {
	// Remove the `supabase` prefix from the declarative directory
	declarativeDir := strings.TrimPrefix(utils.DeclarativeDir, "supabase/")
	lines := []string{
		"\nschema_paths = [",
		fmt.Sprintf(`  "%s",`, declarativeDir),
		"]\n",
	}
	schemaPaths := strings.Join(lines, "\n")
	data, err := afero.ReadFile(fsys, utils.ConfigPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return errors.Errorf("failed to read config: %w", err)
	}
	if newConfig := schemaPathsPattern.ReplaceAllLiteral(data, []byte(schemaPaths)); bytesContain(newConfig, []byte(schemaPaths)) {
		return utils.WriteFile(utils.ConfigPath, newConfig, fsys)
	}
	f, err := fsys.OpenFile(utils.ConfigPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open config: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString("\n[db.migrations]"); err != nil {
		return errors.Errorf("failed to write header: %w", err)
	}
	if _, err := f.WriteString(schemaPaths); err != nil {
		return errors.Errorf("failed to write config: %w", err)
	}
	return nil
}

// getBaselineCatalogRef returns a catalog reference for an empty shadow database.
//
// Caching this baseline avoids repeatedly recreating equivalent snapshots.
func getBaselineCatalogRef(ctx context.Context, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	cachePath := filepath.Join(pgDeltaTempPath(), baselineCatalogPath)
	if !noCache {
		if ok, err := afero.Exists(fsys, cachePath); err == nil && ok {
			return cachePath, nil
		}
	}
	shadow, config, err := createShadow(ctx)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	snapshot, err := diff.ExportCatalogPgDelta(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return "", err
	}
	if noCache {
		return writeTempCatalog(fsys, noCacheCatalogPath, snapshot)
	}
	if err := ensureTempDir(fsys); err != nil {
		return "", err
	}
	if err := utils.WriteFile(cachePath, []byte(snapshot), fsys); err != nil {
		return "", err
	}
	return cachePath, nil
}

// getMigrationsCatalogRef returns a catalog reference representing local
// migrations applied to a shadow database.
//
// A migration-content hash keys the cache so it is reused only when local
// migration state is unchanged.
func getMigrationsCatalogRef(ctx context.Context, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	hash, err := hashMigrations(fsys)
	if err != nil {
		return "", err
	}
	cachePath := filepath.Join(pgDeltaTempPath(), fmt.Sprintf(migrationsCatalogName, hash))
	if !noCache {
		if ok, err := afero.Exists(fsys, cachePath); err == nil && ok {
			return cachePath, nil
		}
	}
	shadow, config, err := createShadow(ctx)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	if err := diff.MigrateShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	snapshot, err := diff.ExportCatalogPgDelta(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return "", err
	}
	if noCache {
		return writeTempCatalog(fsys, noCacheCatalogPath, snapshot)
	}
	if err := ensureTempDir(fsys); err != nil {
		return "", err
	}
	if err := cleanupOldMigrationCatalogs(fsys, hash); err != nil {
		return "", err
	}
	if err := utils.WriteFile(cachePath, []byte(snapshot), fsys); err != nil {
		return "", err
	}
	return cachePath, nil
}

// getDeclarativeCatalogRef applies local declarative files to a shadow database
// and exports the resulting catalog for diffing.
func getDeclarativeCatalogRef(ctx context.Context, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	shadow, config, err := createShadow(ctx)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	if err := pgdelta.ApplyDeclarative(ctx, config, fsys); err != nil {
		return "", err
	}
	snapshot, err := diff.ExportCatalogPgDelta(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return "", err
	}
	return writeTempCatalog(fsys, "catalog-declarative.json", snapshot)
}

// createShadow provisions and health-checks the temporary Postgres container
// used by declarative conversion and diff operations.
func createShadow(ctx context.Context) (string, pgconn.Config, error) {
	fmt.Fprintln(os.Stderr, "Creating shadow database...")
	shadow, err := diff.CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return "", pgconn.Config{}, err
	}
	if err := start.WaitForHealthyService(ctx, utils.Config.Db.HealthTimeout, shadow); err != nil {
		utils.DockerRemove(shadow)
		return "", pgconn.Config{}, err
	}
	config := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	return shadow, config, nil
}

// hashMigrations computes a stable content hash for local migration files.
//
// The hash includes file paths and contents so cache invalidation captures both
// renames and SQL edits.
func hashMigrations(fsys afero.Fs) (string, error) {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return "", err
	}
	h := sha256.New()
	for _, fp := range migrations {
		contents, err := afero.ReadFile(fsys, fp)
		if err != nil {
			return "", err
		}
		if _, err := h.Write([]byte(fp)); err != nil {
			return "", err
		}
		if _, err := h.Write(contents); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// cleanupOldMigrationCatalogs removes stale migration-catalog cache entries so
// temp storage does not grow indefinitely across repeated sync operations.
func cleanupOldMigrationCatalogs(fsys afero.Fs, keepHash string) error {
	if err := ensureTempDir(fsys); err != nil {
		return err
	}
	tempDir := pgDeltaTempPath()
	entries, err := afero.ReadDir(fsys, tempDir)
	if err != nil {
		return err
	}
	keep := fmt.Sprintf(migrationsCatalogName, keepHash)
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, "catalog-migrations-") && name != keep {
			if err := fsys.Remove(filepath.Join(tempDir, name)); err != nil {
				return err
			}
		}
	}
	return nil
}

// writeTempCatalog writes a catalog snapshot under utils.TempDir and returns
// the file path so callers can pass it to pg-delta as a source/target reference.
func writeTempCatalog(fsys afero.Fs, name, snapshot string) (string, error) {
	if err := ensureTempDir(fsys); err != nil {
		return "", err
	}
	path := filepath.Join(pgDeltaTempPath(), name)
	if err := utils.WriteFile(path, []byte(snapshot), fsys); err != nil {
		return "", err
	}
	return path, nil
}

// ensureTempDir creates the shared temp directory used by declarative catalog
// caches and ephemeral snapshots.
func ensureTempDir(fsys afero.Fs) error {
	return utils.MkdirIfNotExistFS(fsys, pgDeltaTempPath())
}

func pgDeltaTempPath() string {
	return filepath.Join(utils.TempDir, pgDeltaTempDir)
}

// findDropStatements extracts DROP statements for safety warnings shown when
// generating migration output from declarative diffs.
func findDropStatements(out string) []string {
	lines, err := parser.SplitAndTrim(strings.NewReader(out))
	if err != nil {
		return nil
	}
	var drops []string
	for _, line := range lines {
		if dropStatementRegexp.MatchString(line) {
			drops = append(drops, line)
		}
	}
	return drops
}

// bytesContain avoids pulling in bytes package for one containment check while
// keeping config replacement logic readable.
func bytesContain(data, needle []byte) bool {
	return strings.Contains(string(data), string(needle))
}
