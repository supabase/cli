package declarative

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/pgcache"
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
	// baselineCatalogName caches the catalog of a shadow database with the Supabase
	// platform baseline (auth/storage/realtime) provisioned but no user migrations
	// applied — equivalent to diff.MigrateShadowDatabase with zero migrations.
	//
	// It is used as the "source" baseline both when generating declarative files
	// from a real database target and when syncing with no local migrations, so it
	// must stay in parity with the declarative target's platform baseline. The "%s"
	// is a key (see baselineCatalogKey) derived from the image plus every setup
	// input that shapes the baseline, so config/roles changes self-invalidate the
	// cache rather than reusing a stale snapshot.
	baselineCatalogName = "catalog-baseline-%s.json"
	// declarativeCatalogName stores catalogs keyed by declarative-content hash.
	declarativeCatalogName = "catalog-%s-declarative-%s-%d.json"
	// Separate no-cache paths prevent overwrite when both catalogs are
	// exported in the same sync invocation (getMigrationsCatalogRef then
	// writeDeclarativeCatalogFromConfig).
	noCacheBaselineCatalogPath    = "catalog-nocache-baseline.json"
	noCacheMigrationsCatalogPath  = "catalog-nocache-migrations.json"
	noCacheDeclarativeCatalogPath = "catalog-nocache-declarative.json"
	catalogRetentionCount         = 2
)

var (
	// schemaPathsPattern locates existing schema_paths in config so declarative
	// writes can replace stale values rather than appending duplicates.
	schemaPathsPattern = regexp.MustCompile(`(?s)\nschema_paths = \[(.*?)\]\n`)
	// dropStatementRegexp flags potentially destructive statements for UX warnings
	// when generating migration output from declarative sources.
	dropStatementRegexp  = regexp.MustCompile(`(?i)drop\s+`)
	catalogPrefixRegexp  = regexp.MustCompile(`[^a-zA-Z0-9._-]+`)
	exportCatalog        = diff.ExportCatalogPgDelta
	applyDeclarative     = pgdelta.ApplyDeclarative
	declarativeExportRef = diff.DeclarativeExportPgDeltaRef
	// diffPgDeltaRef diffs a source catalog against a target catalog. It is a
	// package var so tests can exercise the full generate -> sync flow without the
	// real pg-delta runtime.
	diffPgDeltaRef = diff.DiffPgDeltaRef
	// setupShadowDatabase provisions the Supabase platform baseline (auth/storage/
	// realtime) on a shadow database before declarative schemas are applied, so
	// Supabase-managed dependencies (auth.sessions, auth.jwt(), ...) resolve. It is
	// a package var so tests can inject a no-op without a real shadow database.
	setupShadowDatabase = diff.SetupShadowDatabase
	// createShadow provisions a healthy shadow database container. It is a package
	// var so tests can exercise the baseline/migrations/declarative paths without a
	// real Docker daemon.
	createShadow = createShadowContainer
	// generateBaselineCatalogRefResolver allows Generate to reuse a freshly
	// provisioned baseline shadow for declarative cache warmup.
	generateBaselineCatalogRefResolver = getGenerateBaselineCatalogRef
	// declarativeCatalogRefResolver is used by Generate so tests can verify
	// cache warming behavior without provisioning a real shadow database.
	declarativeCatalogRefResolver = getDeclarativeCatalogRef
)

type shadowSession struct {
	container string
	config    pgconn.Config
}

func (s *shadowSession) cleanup() {
	if s == nil || len(s.container) == 0 {
		return
	}
	utils.DockerRemove(s.container)
	s.container = ""
}

type generateBaselineCatalogRef struct {
	ref    string
	shadow *shadowSession
}

// Generate exports a live database schema into files under supabase/declarative.
//
// The workflow uses pg-delta catalogs so output can be deterministic and filtered
// by schema, then optionally prompts before replacing existing files.
func Generate(ctx context.Context, schema []string, config pgconn.Config, overwrite bool, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	baseline, err := generateBaselineCatalogRefResolver(ctx, noCache, fsys, options...)
	if err != nil {
		return err
	}
	if baseline.shadow != nil {
		defer baseline.shadow.cleanup()
	}
	sourceRef := baseline.ref
	output, err := declarativeExportRef(ctx, sourceRef, utils.ToPostgresURL(config), schema, pgDeltaFormatOptions(), options...)
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
	// Warm declarative catalog cache after generate so follow-up sync
	// can reuse it without provisioning another shadow database.
	if !noCache {
		if baseline.shadow != nil {
			// The reused baseline shadow already has the platform baseline
			// provisioned (getGenerateBaselineCatalogRef), so apply declarative
			// schemas directly on top of it without setting it up again.
			hash, err := declarativeCatalogCacheKey(fsys)
			if err != nil {
				return err
			}
			if _, err := writeDeclarativeCatalogFromConfig(ctx, baseline.shadow.config, hash, "local", false, fsys, options...); err != nil {
				return err
			}
		} else {
			if _, err := declarativeCatalogRefResolver(ctx, false, fsys, options...); err != nil {
				return err
			}
		}
	}
	fmt.Fprintln(os.Stderr, "Declarative schema written to "+utils.Bold(utils.GetDeclarativeDir()))
	return nil
}

// SyncResult holds the output of a declarative-to-migrations diff operation.
type SyncResult struct {
	DiffSQL      string   // The generated migration SQL
	SourceRef    string   // Migrations catalog ref (for debug)
	TargetRef    string   // Declarative catalog ref (for debug)
	DropWarnings []string // Any DROP statements found
}

// DiffDeclarativeToMigrations computes the diff between local migrations state
// and declarative schema files, returning the result without writing anything.
func DiffDeclarativeToMigrations(ctx context.Context, schema []string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (*SyncResult, error) {
	declarativeDir := utils.GetDeclarativeDir()
	if exists, err := afero.DirExists(fsys, declarativeDir); err != nil {
		return nil, err
	} else if !exists {
		return nil, errors.Errorf("No declarative schema directory found. Run %s first.", utils.Aqua("supabase db schema declarative generate"))
	}
	sourceRef, err := getMigrationsCatalogRef(ctx, noCache, fsys, "local", options...)
	if err != nil {
		return nil, err
	}
	targetRef, err := getDeclarativeCatalogRef(ctx, noCache, fsys, options...)
	if err != nil {
		return nil, err
	}
	out, err := diffPgDeltaRef(ctx, sourceRef, targetRef, schema, pgDeltaFormatOptions(), options...)
	if err != nil {
		return nil, err
	}
	return &SyncResult{
		DiffSQL:      out,
		SourceRef:    sourceRef,
		TargetRef:    targetRef,
		DropWarnings: findDropStatements(out),
	}, nil
}

// SyncToMigrations diffs local declarative files against migration state and
// writes the delta as a new migration file.
func SyncToMigrations(ctx context.Context, schema []string, file string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	result, err := DiffDeclarativeToMigrations(ctx, schema, noCache, fsys, options...)
	if err != nil {
		return err
	}
	if len(strings.TrimSpace(file)) == 0 {
		file = "declarative_sync"
	}
	if err := diff.SaveDiff(result.DiffSQL, file, fsys); err != nil {
		return err
	}
	if len(result.DropWarnings) > 0 {
		fmt.Fprintln(os.Stderr, "Found drop statements in schema diff. Please double check if these are expected:")
		fmt.Fprintln(os.Stderr, utils.Yellow(strings.Join(result.DropWarnings, "\n")))
	}
	return nil
}

// confirmOverwrite asks before replacing existing declarative files.
//
// This guard exists because declarative export rewrites the entire directory.
func confirmOverwrite(ctx context.Context, fsys afero.Fs) (bool, error) {
	declarativeDir := utils.GetDeclarativeDir()
	exists, err := afero.DirExists(fsys, declarativeDir)
	if err != nil || !exists {
		return true, err
	}
	files, err := afero.ReadDir(fsys, declarativeDir)
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
	declarativeDir := utils.GetDeclarativeDir()
	if err := fsys.RemoveAll(declarativeDir); err != nil {
		return errors.Errorf("failed to clean declarative schema directory: %w", err)
	}
	if err := utils.MkdirIfNotExistFS(fsys, declarativeDir); err != nil {
		return err
	}
	for _, file := range output.Files {
		relPath := filepath.FromSlash(filepath.Clean(file.Path))
		if strings.HasPrefix(relPath, "..") || filepath.IsAbs(relPath) {
			return errors.Errorf("unsafe declarative export path: %s", file.Path)
		}
		targetPath := filepath.Join(declarativeDir, relPath)
		if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(targetPath)); err != nil {
			return err
		}
		if err := utils.WriteFile(targetPath, []byte(file.SQL), fsys); err != nil {
			return err
		}
	}
	// When pg-delta is enabled, the declarative directory (default or configured)
	// is the source of truth; do not overwrite [db.migrations] schema_paths.
	if utils.IsPgDeltaEnabled() {
		return nil
	}
	utils.Config.Db.Migrations.SchemaPaths = []string{
		declarativeDir,
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
	declarativeDir := strings.TrimPrefix(utils.GetDeclarativeDir(), "supabase/")
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

func getGenerateBaselineCatalogRef(ctx context.Context, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (generateBaselineCatalogRef, error) {
	cachePath, err := baselineCatalogPath(fsys)
	if err != nil {
		return generateBaselineCatalogRef{}, err
	}
	if !noCache {
		if ok, err := afero.Exists(fsys, cachePath); err == nil && ok {
			return generateBaselineCatalogRef{ref: cachePath}, nil
		}
	}
	shadowID, config, err := createShadow(ctx)
	if err != nil {
		return generateBaselineCatalogRef{}, err
	}
	shadow := &shadowSession{
		container: shadowID,
		config:    config,
	}
	// Provision the Supabase platform baseline before exporting so the baseline
	// catalog represents "platform baseline, no user migrations" — the same
	// semantics as diff.MigrateShadowDatabase with zero migrations. This baseline is
	// reused as the diff source by both Generate (against the live database) and
	// sync-with-no-migrations (getMigrationsCatalogRef). Its starting point must
	// match the declarative target, which also sets up the platform baseline;
	// otherwise platform objects (auth/storage/realtime) surface as spurious
	// additions in generated migrations.
	if err := setupShadowDatabase(ctx, shadow.container, fsys, options...); err != nil {
		shadow.cleanup()
		return generateBaselineCatalogRef{}, err
	}
	snapshot, err := exportCatalog(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		shadow.cleanup()
		return generateBaselineCatalogRef{}, err
	}
	if noCache {
		path, err := writeTempCatalog(fsys, noCacheBaselineCatalogPath, snapshot)
		shadow.cleanup()
		if err != nil {
			return generateBaselineCatalogRef{}, err
		}
		return generateBaselineCatalogRef{ref: path}, nil
	}
	if err := ensureTempDir(fsys); err != nil {
		shadow.cleanup()
		return generateBaselineCatalogRef{}, err
	}
	if err := utils.WriteFile(cachePath, []byte(snapshot), fsys); err != nil {
		shadow.cleanup()
		return generateBaselineCatalogRef{}, err
	}
	return generateBaselineCatalogRef{
		ref:    cachePath,
		shadow: shadow,
	}, nil
}

// getMigrationsCatalogRef returns a catalog reference representing local
// migrations applied to a shadow database.
//
// A migration-content hash plus setup-input token keys the cache so it is reused
// only when both local migration state and platform baseline inputs are unchanged.
func getMigrationsCatalogRef(ctx context.Context, noCache bool, fsys afero.Fs, prefix string, options ...func(*pgx.ConnConfig)) (string, error) {
	migrations, err := migration.ListLocalMigrations(utils.MigrationsDir, afero.NewIOFS(fsys))
	if err != nil {
		return "", err
	}
	// With no local migrations, the migrations catalog is exactly the platform
	// baseline, so it is cached under the setup-keyed baseline path rather than the
	// migrations-hash cache. The migrations-hash cache is not setup-aware, so an
	// older empty-migrations snapshot from a different platform setup must not be
	// reused as the no-migration sync source.
	zeroMigrations := len(migrations) == 0
	var baselinePath string
	if zeroMigrations {
		baselinePath, err = baselineCatalogPath(fsys)
		if err != nil {
			return "", err
		}
		if !noCache {
			if ok, err := afero.Exists(fsys, baselinePath); err != nil {
				return "", err
			} else if ok {
				return baselinePath, nil
			}
		}
	}
	hash, err := migrationsCatalogCacheKey(fsys)
	if err != nil {
		return "", err
	}
	if !noCache && !zeroMigrations {
		if cachePath, ok, err := pgcache.ResolveMigrationCatalogPath(fsys, hash, prefix); err != nil {
			return "", err
		} else if ok {
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
	snapshot, err := exportCatalog(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return "", err
	}
	if noCache {
		return writeTempCatalog(fsys, noCacheMigrationsCatalogPath, snapshot)
	}
	if zeroMigrations {
		// MigrateShadowDatabase with zero migrations == the platform baseline.
		if err := ensureTempDir(fsys); err != nil {
			return "", err
		}
		if err := utils.WriteFile(baselinePath, []byte(snapshot), fsys); err != nil {
			return "", err
		}
		return baselinePath, nil
	}
	return pgcache.WriteMigrationCatalogSnapshot(fsys, prefix, hash, snapshot)
}

// getDeclarativeCatalogRef applies local declarative files to a shadow database
// and exports the resulting catalog for diffing.
func getDeclarativeCatalogRef(ctx context.Context, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	hash, err := declarativeCatalogCacheKey(fsys)
	if err != nil {
		return "", err
	}
	prefix := "local"
	if !noCache {
		if path, ok, err := resolveDeclarativeCatalogPath(fsys, hash, prefix); err != nil {
			return "", err
		} else if ok {
			return path, nil
		}
	}
	shadow, config, err := createShadow(ctx)
	if err != nil {
		return "", err
	}
	defer utils.DockerRemove(shadow)
	// Apply the Supabase platform baseline (auth/storage/realtime) before applying
	// declarative schemas so dependencies on Supabase-managed objects (auth.sessions,
	// auth.jwt(), ...) resolve. This keeps the declarative shadow in parity with the
	// migrations shadow (diff.MigrateShadowDatabase), so platform objects cancel out
	// of the diff instead of surfacing as spurious changes or "stuck" applies.
	if err := setupShadowDatabase(ctx, shadow, fsys, options...); err != nil {
		return "", err
	}
	return writeDeclarativeCatalogFromConfig(ctx, config, hash, prefix, noCache, fsys, options...)
}

func writeDeclarativeCatalogFromConfig(ctx context.Context, config pgconn.Config, hash, prefix string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	if err := applyDeclarative(ctx, config, fsys); err != nil {
		return "", err
	}
	snapshot, err := exportCatalog(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return "", err
	}
	if noCache {
		return writeTempCatalog(fsys, noCacheDeclarativeCatalogPath, snapshot)
	}
	if err := ensureTempDir(fsys); err != nil {
		return "", err
	}
	path := declarativeCatalogPath(hash, prefix, time.Now().UTC())
	if err := utils.WriteFile(path, []byte(snapshot), fsys); err != nil {
		return "", err
	}
	if err := cleanupOldDeclarativeCatalogs(fsys, prefix); err != nil {
		return "", err
	}
	return path, nil
}

// createShadowContainer provisions and health-checks the temporary Postgres
// container used by declarative conversion and diff operations.
func createShadowContainer(ctx context.Context) (string, pgconn.Config, error) {
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

// hashMigrations mirrors pgcache hashing for declarative package tests.
func hashMigrations(fsys afero.Fs) (string, error) {
	return pgcache.HashMigrations(fsys)
}

// hashDeclarativeSchemas computes a stable hash of declarative SQL files.
func hashDeclarativeSchemas(fsys afero.Fs) (string, error) {
	declarativeDir := utils.GetDeclarativeDir()
	var paths []string
	if err := afero.Walk(fsys, declarativeDir, func(path string, info fs.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && filepath.Ext(info.Name()) == ".sql" {
			paths = append(paths, path)
		}
		return nil
	}); err != nil {
		return "", err
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, path := range paths {
		contents, err := afero.ReadFile(fsys, path)
		if err != nil {
			return "", err
		}
		rel, err := filepath.Rel(declarativeDir, path)
		if err != nil {
			return "", err
		}
		normalized := filepath.ToSlash(rel)
		if _, err := h.Write([]byte(normalized)); err != nil {
			return "", err
		}
		if _, err := h.Write(contents); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil)), nil
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

func declarativeCatalogPath(hash, prefix string, createdAt time.Time) string {
	return filepath.Join(pgDeltaTempPath(), fmt.Sprintf(declarativeCatalogName, sanitizedCatalogPrefix(prefix), hash, createdAt.UnixMilli()))
}

func resolveDeclarativeCatalogPath(fsys afero.Fs, hash, prefix string) (string, bool, error) {
	if err := ensureTempDir(fsys); err != nil {
		return "", false, err
	}
	entries, err := afero.ReadDir(fsys, pgDeltaTempPath())
	if err != nil {
		return "", false, err
	}
	familyPrefix := fmt.Sprintf("catalog-%s-declarative-%s-", sanitizedCatalogPrefix(prefix), hash)
	latestPath := ""
	latestTimestamp := int64(-1)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, familyPrefix) || !strings.HasSuffix(name, ".json") {
			continue
		}
		stamp := strings.TrimSuffix(strings.TrimPrefix(name, familyPrefix), ".json")
		ts, err := strconv.ParseInt(stamp, 10, 64)
		if err != nil {
			continue
		}
		if ts > latestTimestamp {
			latestTimestamp = ts
			latestPath = filepath.Join(pgDeltaTempPath(), name)
		}
	}
	if latestTimestamp >= 0 {
		return latestPath, true, nil
	}
	return "", false, nil
}

func cleanupOldDeclarativeCatalogs(fsys afero.Fs, prefix string) error {
	if err := ensureTempDir(fsys); err != nil {
		return err
	}
	entries, err := afero.ReadDir(fsys, pgDeltaTempPath())
	if err != nil {
		return err
	}
	familyPrefix := fmt.Sprintf("catalog-%s-declarative-", sanitizedCatalogPrefix(prefix))
	type catalogFile struct {
		name      string
		timestamp int64
	}
	var files []catalogFile
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, familyPrefix) || !strings.HasSuffix(name, ".json") {
			continue
		}
		if ts, ok := catalogTimestamp(name); ok {
			files = append(files, catalogFile{name: name, timestamp: ts})
			continue
		}
		files = append(files, catalogFile{name: name, timestamp: 0})
	}
	sort.Slice(files, func(i, j int) bool {
		if files[i].timestamp == files[j].timestamp {
			return files[i].name > files[j].name
		}
		return files[i].timestamp > files[j].timestamp
	})
	for i := catalogRetentionCount; i < len(files); i++ {
		if err := fsys.Remove(filepath.Join(pgDeltaTempPath(), files[i].name)); err != nil {
			return err
		}
	}
	return nil
}

func catalogTimestamp(name string) (int64, bool) {
	if !strings.HasSuffix(name, ".json") {
		return 0, false
	}
	raw := strings.TrimSuffix(name, ".json")
	idx := strings.LastIndex(raw, "-")
	if idx < 0 || idx+1 >= len(raw) {
		return 0, false
	}
	ts, err := strconv.ParseInt(raw[idx+1:], 10, 64)
	if err != nil {
		return 0, false
	}
	return ts, true
}

func baselineVersionToken() string {
	image := strings.TrimSpace(utils.Config.Db.Image)
	if idx := strings.LastIndex(image, ":"); idx >= 0 && idx+1 < len(image) {
		image = image[idx+1:]
	}
	if len(strings.TrimSpace(image)) == 0 {
		image = fmt.Sprintf("pg%d", utils.Config.Db.MajorVersion)
	}
	return catalogPrefixRegexp.ReplaceAllString(image, "-")
}

// setupInputsToken hashes every project input that start.SetupDatabase consumes
// and that therefore shapes the platform baseline:
//
//   - the Postgres image (initSchema content);
//   - the service toggles that gate initSchema — auth/storage/realtime;
//   - api.auto_expose_new_tables (ApplyApiPrivileges default ACLs);
//   - vault secret names (UpsertVaultSecrets);
//   - supabase/roles.sql (SeedGlobals).
//
// Every catalog produced in this flow is "platform baseline + {nothing | migrations
// | declarative}", so each cache folds this token into its key and self-invalidates
// when setup changes instead of reusing a snapshot from a different baseline.
func setupInputsToken(fsys afero.Fs) (string, error) {
	h := sha256.New()
	fmt.Fprintln(h, baselineVersionToken())
	// initSchema conditionally provisions these service schemas.
	fmt.Fprintf(h, "auth=%t storage=%t realtime=%t\n",
		utils.Config.Auth.Enabled, utils.Config.Storage.Enabled, utils.Config.Realtime.Enabled)
	// api.auto_expose_new_tables drives ApplyApiPrivileges (default ACLs). Key on the
	// effective value, not the raw tri-state: as of the 2026-05-30 flip an unset flag
	// resolves to the same revoke-by-default baseline as explicit false (see
	// start.ApplyApiPrivileges). Folding the effective bool in self-invalidates caches
	// built before the flip (when unset meant auto-expose, keyed as "unset").
	autoExpose := utils.Config.Api.AutoExposeNewTables != nil && *utils.Config.Api.AutoExposeNewTables
	fmt.Fprintf(h, "auto_expose_new_tables=%t\n", autoExpose)
	// Vault secrets are created during setup; key on their names.
	names := make([]string, 0, len(utils.Config.Db.Vault))
	for name := range utils.Config.Db.Vault {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		fmt.Fprintf(h, "vault=%s\n", name)
	}
	// supabase/roles.sql is seeded into the baseline.
	roles, err := afero.ReadFile(fsys, utils.CustomRolesPath)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", err
	}
	if _, err := h.Write(roles); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil))[:12], nil
}

// baselineCatalogKey derives the cache key for the platform baseline catalog.
//
// Keying only by image would let a stale baseline — produced by a pre-platform-
// baseline CLI, a different image, or different service/api/vault/roles config — be
// reused as the no-migration diff source, leaking spurious objects into generated
// migrations until .temp/pgdelta is cleared. The image token stays as a human-
// readable prefix; old bare-baseline files keyed by the token alone no longer
// match, so they are never reused.
func baselineCatalogKey(fsys afero.Fs) (string, error) {
	token, err := setupInputsToken(fsys)
	if err != nil {
		return "", err
	}
	return baselineVersionToken() + "-" + token, nil
}

// baselineCatalogPath returns the on-disk path of the platform baseline catalog
// for the current project inputs. Both the generate writer and the no-migration
// sync reader resolve the path through this helper so they always agree.
func baselineCatalogPath(fsys afero.Fs) (string, error) {
	key, err := baselineCatalogKey(fsys)
	if err != nil {
		return "", err
	}
	return filepath.Join(pgDeltaTempPath(), fmt.Sprintf(baselineCatalogName, key)), nil
}

// declarativeCatalogCacheKey keys the warmed declarative target catalog by both the
// declarative SQL files and the setup inputs. The target is the platform baseline
// plus the declarative schema, so a change to either must invalidate it; otherwise
// sync could pair a freshly keyed source baseline with a target warmed under a
// different setup, emitting platform/config-only differences as user migrations.
func declarativeCatalogCacheKey(fsys afero.Fs) (string, error) {
	schemaHash, err := hashDeclarativeSchemas(fsys)
	if err != nil {
		return "", err
	}
	setup, err := setupInputsToken(fsys)
	if err != nil {
		return "", err
	}
	return setup + "-" + schemaHash, nil
}

func migrationsCatalogCacheKey(fsys afero.Fs) (string, error) {
	migrationsHash, err := hashMigrations(fsys)
	if err != nil {
		return "", err
	}
	setup, err := setupInputsToken(fsys)
	if err != nil {
		return "", err
	}
	return setup + "-" + migrationsHash, nil
}

func sanitizedCatalogPrefix(prefix string) string {
	prefix = strings.TrimSpace(prefix)
	if len(prefix) == 0 {
		return "local"
	}
	return catalogPrefixRegexp.ReplaceAllString(prefix, "-")
}

func pgDeltaFormatOptions() string {
	if utils.Config.Experimental.PgDelta == nil {
		return ""
	}
	return strings.TrimSpace(utils.Config.Experimental.PgDelta.FormatOptions)
}

func TryCacheMigrationsCatalog(ctx context.Context, config pgconn.Config, prefix string, version string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	if !shouldCacheMigrationsCatalog() || len(version) > 0 {
		return nil
	}
	if len(strings.TrimSpace(prefix)) == 0 {
		prefix = catalogPrefixFromConfig(config)
	}
	hash, err := hashMigrations(fsys)
	if err != nil {
		return err
	}
	snapshot, err := exportCatalog(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		return err
	}
	if err := ensureTempDir(fsys); err != nil {
		return err
	}
	_, err = pgcache.WriteMigrationCatalogSnapshot(fsys, prefix, hash, snapshot)
	return err
}

func shouldCacheMigrationsCatalog() bool {
	return pgcache.ShouldCacheMigrationsCatalog()
}

func catalogPrefixFromConfig(config pgconn.Config) string {
	return pgcache.CatalogPrefixFromConfig(config)
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
