package declarative

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/pgcache"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

func TestWriteDeclarativeSchemas(t *testing.T) {
	// This verifies the main happy path for declarative export materialization:
	// files are written to expected locations and config is updated accordingly.
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))

	output := diff.DeclarativeOutput{
		Files: []diff.DeclarativeFile{
			{Path: "cluster/roles.sql", SQL: "create role app;"},
			{Path: "schemas/public/tables/users.sql", SQL: "create table users(id bigint);"},
		},
	}

	err := WriteDeclarativeSchemas(output, fsys)
	require.NoError(t, err)

	roles, err := afero.ReadFile(fsys, filepath.Join(utils.DeclarativeDir, "cluster", "roles.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create role app;", string(roles))

	users, err := afero.ReadFile(fsys, filepath.Join(utils.DeclarativeDir, "schemas", "public", "tables", "users.sql"))
	require.NoError(t, err)
	assert.Equal(t, "create table users(id bigint);", string(users))

	cfg, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(cfg), `"database"`)
}

func TestTryCacheMigrationsCatalogWritesPrefixedCache(t *testing.T) {
	fsys := afero.NewMemMapFs()
	original := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = original
		exportCatalog = diff.ExportCatalogPgDelta
	})
	p := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	require.NoError(t, afero.WriteFile(fsys, p, []byte("create table a();"), 0644))
	exportCatalog = func(_ context.Context, targetRef, role string, _ ...func(*pgx.ConnConfig)) (string, error) {
		assert.Equal(t, "postgres", role)
		assert.Contains(t, targetRef, "db.test.supabase.co")
		return `{"version":1}`, nil
	}

	err := TryCacheMigrationsCatalog(t.Context(), pgconn.Config{
		Host:     "db.test.supabase.co",
		Port:     5432,
		User:     "postgres",
		Password: "postgres",
		Database: "postgres",
	}, "remote-ref", "", fsys)
	require.NoError(t, err)

	hash, err := hashMigrations(fsys)
	require.NoError(t, err)
	cachePath, ok, err := pgcache.ResolveMigrationCatalogPath(fsys, hash, "remote-ref")
	require.NoError(t, err)
	require.True(t, ok)
	cached, err := afero.ReadFile(fsys, cachePath)
	require.NoError(t, err)
	assert.JSONEq(t, `{"version":1}`, string(cached))
}

func TestTryCacheMigrationsCatalogSkipsPartialApply(t *testing.T) {
	fsys := afero.NewMemMapFs()
	original := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	called := false
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = original
		exportCatalog = diff.ExportCatalogPgDelta
	})
	exportCatalog = func(_ context.Context, _ string, _ string, _ ...func(*pgx.ConnConfig)) (string, error) {
		called = true
		return `{"version":1}`, nil
	}

	err := TryCacheMigrationsCatalog(t.Context(), pgconn.Config{
		Host: "127.0.0.1", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres",
	}, "", "20240101000000", fsys)
	require.NoError(t, err)
	assert.False(t, called)
}

func TestCatalogPrefixFromConfig(t *testing.T) {
	local := catalogPrefixFromConfig(pgconn.Config{Host: utils.Config.Hostname, Port: utils.Config.Db.Port})
	assert.Equal(t, "local", local)

	linked := catalogPrefixFromConfig(pgconn.Config{Host: "db.abcdefghijklmnopqrst.supabase.co", Port: 5432})
	assert.Equal(t, "abcdefghijklmnopqrst", linked)

	custom := catalogPrefixFromConfig(pgconn.Config{Host: "db.example.com", Port: 5432, Database: "postgres", User: "postgres"})
	sum := sha256.Sum256([]byte("postgres@db.example.com:5432/postgres"))
	assert.Equal(t, "url-"+hex.EncodeToString(sum[:])[:12], custom)
}

func TestWriteDeclarativeSchemasUsesConfiguredDir(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))
	original := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{
		DeclarativeSchemaPath: filepath.Join(utils.SupabaseDirPath, "db", "decl"),
	}
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = original
	})

	output := diff.DeclarativeOutput{
		Files: []diff.DeclarativeFile{
			{Path: "cluster/roles.sql", SQL: "create role app;"},
		},
	}

	err := WriteDeclarativeSchemas(output, fsys)
	require.NoError(t, err)

	rolesPath := filepath.Join(utils.SupabaseDirPath, "db", "decl", "cluster", "roles.sql")
	roles, err := afero.ReadFile(fsys, rolesPath)
	require.NoError(t, err)
	assert.Equal(t, "create role app;", string(roles))

	cfg, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(cfg), `db/decl`)
}

func TestWriteDeclarativeSchemasRejectsUnsafePath(t *testing.T) {
	// Export paths must stay within supabase/declarative to prevent traversal.
	fsys := afero.NewMemMapFs()
	err := WriteDeclarativeSchemas(diff.DeclarativeOutput{
		Files: []diff.DeclarativeFile{
			{Path: "../oops.sql", SQL: "select 1;"},
		},
	}, fsys)
	assert.ErrorContains(t, err, "unsafe declarative export path")
}

func TestHashMigrationsChangesWithContent(t *testing.T) {
	// Cache keys must change whenever migration SQL changes.
	fsys := afero.NewMemMapFs()
	p1 := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	p2 := filepath.Join(utils.MigrationsDir, "20240101000001_second.sql")
	require.NoError(t, afero.WriteFile(fsys, p1, []byte("create table a();"), 0644))
	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b();"), 0644))

	h1, err := hashMigrations(fsys)
	require.NoError(t, err)
	require.NotEmpty(t, h1)

	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b(id bigint);"), 0644))
	h2, err := hashMigrations(fsys)
	require.NoError(t, err)

	assert.NotEqual(t, h1, h2)
}

func TestGetMigrationsCatalogRefUsesCache(t *testing.T) {
	// When a matching hash snapshot exists, catalog generation should be skipped.
	fsys := afero.NewMemMapFs()
	p := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	require.NoError(t, afero.WriteFile(fsys, p, []byte("create table a();"), 0644))
	hash, err := hashMigrations(fsys)
	require.NoError(t, err)

	cachePath := filepath.Join(utils.TempDir, "pgdelta", "catalog-local-migrations-"+hash+"-1000.json")
	require.NoError(t, afero.WriteFile(fsys, cachePath, []byte(`{"version":1}`), 0644))

	ref, err := getMigrationsCatalogRef(t.Context(), false, fsys, "local")
	require.NoError(t, err)
	assert.Equal(t, cachePath, ref)
}

func TestGetMigrationsCatalogRefUsesProjectPrefix(t *testing.T) {
	fsys := afero.NewMemMapFs()
	p := filepath.Join(utils.MigrationsDir, "20240101000000_first.sql")
	require.NoError(t, afero.WriteFile(fsys, p, []byte("create table a();"), 0644))
	hash, err := hashMigrations(fsys)
	require.NoError(t, err)

	cachePath := filepath.Join(utils.TempDir, "pgdelta", "catalog-testproject-migrations-"+hash+"-1000.json")
	require.NoError(t, afero.WriteFile(fsys, cachePath, []byte(`{"version":1}`), 0644))

	ref, err := getMigrationsCatalogRef(t.Context(), false, fsys, "testproject")
	require.NoError(t, err)
	assert.Equal(t, cachePath, ref)
}

func TestGetMigrationsCatalogRefUsesBaselineWhenNoMigrations(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, fsys.MkdirAll(filepath.Join(utils.TempDir, "pgdelta"), 0755))
	baselinePath := filepath.Join(pgDeltaTempPath(), fmt.Sprintf(baselineCatalogName, baselineVersionToken()))
	require.NoError(t, afero.WriteFile(fsys, baselinePath, []byte(`{"version":1}`), 0644))

	ref, err := getMigrationsCatalogRef(t.Context(), false, fsys, "local")
	require.NoError(t, err)
	assert.Equal(t, baselinePath, ref)
}

func TestHashDeclarativeSchemasChangesWithContent(t *testing.T) {
	fsys := afero.NewMemMapFs()
	p1 := filepath.Join(utils.GetDeclarativeDir(), "schemas", "public", "tables", "a.sql")
	p2 := filepath.Join(utils.GetDeclarativeDir(), "schemas", "public", "tables", "b.sql")
	require.NoError(t, afero.WriteFile(fsys, p1, []byte("create table a();"), 0644))
	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b();"), 0644))

	h1, err := hashDeclarativeSchemas(fsys)
	require.NoError(t, err)
	require.NotEmpty(t, h1)

	require.NoError(t, afero.WriteFile(fsys, p2, []byte("create table b(id bigint);"), 0644))
	h2, err := hashDeclarativeSchemas(fsys)
	require.NoError(t, err)
	assert.NotEqual(t, h1, h2)
}

func TestResolveDeclarativeCatalogPathUsesLatestTimestamp(t *testing.T) {
	fsys := afero.NewMemMapFs()
	temp := filepath.Join(utils.TempDir, "pgdelta")
	require.NoError(t, fsys.MkdirAll(temp, 0755))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-hash-1000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-hash-2000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-hash-3000.json"), []byte("{}"), 0644))

	path, ok, err := resolveDeclarativeCatalogPath(fsys, "hash", "local")
	require.NoError(t, err)
	require.True(t, ok)
	assert.Equal(t, filepath.Join(temp, "catalog-local-declarative-hash-3000.json"), path)
}

func TestCleanupOldDeclarativeCatalogsKeepsLatestTwo(t *testing.T) {
	fsys := afero.NewMemMapFs()
	temp := filepath.Join(utils.TempDir, "pgdelta")
	require.NoError(t, fsys.MkdirAll(temp, 0755))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-h1-1000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-h2-2000.json"), []byte("{}"), 0644))
	require.NoError(t, afero.WriteFile(fsys, filepath.Join(temp, "catalog-local-declarative-h3-3000.json"), []byte("{}"), 0644))
	require.NoError(t, cleanupOldDeclarativeCatalogs(fsys, "local"))

	ok, err := afero.Exists(fsys, filepath.Join(temp, "catalog-local-declarative-h1-1000.json"))
	require.NoError(t, err)
	assert.False(t, ok)

	ok, err = afero.Exists(fsys, filepath.Join(temp, "catalog-local-declarative-h2-2000.json"))
	require.NoError(t, err)
	assert.True(t, ok)

	ok, err = afero.Exists(fsys, filepath.Join(temp, "catalog-local-declarative-h3-3000.json"))
	require.NoError(t, err)
	assert.True(t, ok)
}

func TestBaselineVersionToken(t *testing.T) {
	originalImage := utils.Config.Db.Image
	originalMajor := utils.Config.Db.MajorVersion
	t.Cleanup(func() {
		utils.Config.Db.Image = originalImage
		utils.Config.Db.MajorVersion = originalMajor
	})

	utils.Config.Db.Image = "public.ecr.aws/supabase/postgres:15.8.1.049"
	assert.Equal(t, "15.8.1.049", baselineVersionToken())

	utils.Config.Db.Image = ""
	utils.Config.Db.MajorVersion = 17
	assert.Equal(t, "pg17", baselineVersionToken())
}

func TestGenerateWarmsDeclarativeCatalogCache(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))
	require.NoError(t, fsys.MkdirAll(filepath.Join(utils.TempDir, "pgdelta"), 0755))
	baselinePath := filepath.Join(pgDeltaTempPath(), fmt.Sprintf(baselineCatalogName, baselineVersionToken()))
	require.NoError(t, afero.WriteFile(fsys, baselinePath, []byte(`{"version":1}`), 0644))

	originalPgDelta := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	originalExportRef := declarativeExportRef
	originalBaselineResolver := generateBaselineCatalogRefResolver
	originalResolver := declarativeCatalogRefResolver
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = originalPgDelta
		declarativeExportRef = originalExportRef
		generateBaselineCatalogRefResolver = originalBaselineResolver
		declarativeCatalogRefResolver = originalResolver
	})
	generateBaselineCatalogRefResolver = func(_ context.Context, _ bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (generateBaselineCatalogRef, error) {
		return generateBaselineCatalogRef{ref: baselinePath}, nil
	}

	declarativeExportRef = func(_ context.Context, sourceRef, _ string, _ []string, _ string, _ ...func(*pgx.ConnConfig)) (diff.DeclarativeOutput, error) {
		assert.Equal(t, baselinePath, sourceRef)
		return diff.DeclarativeOutput{
			Files: []diff.DeclarativeFile{
				{Path: "cluster/roles.sql", SQL: "create role app;"},
			},
		}, nil
	}
	called := false
	declarativeCatalogRefResolver = func(_ context.Context, noCache bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (string, error) {
		assert.False(t, noCache)
		called = true
		return filepath.Join(utils.TempDir, "pgdelta", "catalog-local-declarative-hash-1000.json"), nil
	}

	err := Generate(t.Context(), nil, pgconn.Config{Host: "127.0.0.1", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres"}, true, false, fsys)
	require.NoError(t, err)
	assert.True(t, called)
}

func TestGenerateNoCacheSkipsDeclarativeCatalogWarmup(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))
	require.NoError(t, fsys.MkdirAll(filepath.Join(utils.TempDir, "pgdelta"), 0755))

	originalPgDelta := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	originalExportRef := declarativeExportRef
	originalBaselineResolver := generateBaselineCatalogRefResolver
	originalResolver := declarativeCatalogRefResolver
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = originalPgDelta
		declarativeExportRef = originalExportRef
		generateBaselineCatalogRefResolver = originalBaselineResolver
		declarativeCatalogRefResolver = originalResolver
	})
	generateBaselineCatalogRefResolver = func(_ context.Context, _ bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (generateBaselineCatalogRef, error) {
		return generateBaselineCatalogRef{ref: filepath.Join(utils.TempDir, "pgdelta", "catalog-baseline-test.json")}, nil
	}

	declarativeExportRef = func(_ context.Context, _, _ string, _ []string, _ string, _ ...func(*pgx.ConnConfig)) (diff.DeclarativeOutput, error) {
		return diff.DeclarativeOutput{
			Files: []diff.DeclarativeFile{
				{Path: "cluster/roles.sql", SQL: "create role app;"},
			},
		}, nil
	}
	declarativeCatalogRefResolver = func(_ context.Context, _ bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (string, error) {
		return "", assert.AnError
	}

	err := Generate(t.Context(), nil, pgconn.Config{Host: "127.0.0.1", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres"}, true, true, fsys)
	require.NoError(t, err)
}

func TestGenerateReusesBaselineShadowForDeclarativeWarmup(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))
	require.NoError(t, fsys.MkdirAll(filepath.Join(utils.TempDir, "pgdelta"), 0755))

	originalPgDelta := utils.Config.Experimental.PgDelta
	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	originalExportRef := declarativeExportRef
	originalBaselineResolver := generateBaselineCatalogRefResolver
	originalResolver := declarativeCatalogRefResolver
	originalApplyDeclarative := applyDeclarative
	originalExportCatalog := exportCatalog
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = originalPgDelta
		declarativeExportRef = originalExportRef
		generateBaselineCatalogRefResolver = originalBaselineResolver
		declarativeCatalogRefResolver = originalResolver
		applyDeclarative = originalApplyDeclarative
		exportCatalog = originalExportCatalog
	})

	const baselinePath = ".temp/pgdelta/catalog-baseline-test.json"
	shadowConfig := pgconn.Config{
		Host:     "127.0.0.1",
		Port:     5432,
		User:     "postgres",
		Password: "postgres",
		Database: "postgres",
	}
	generateBaselineCatalogRefResolver = func(_ context.Context, _ bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (generateBaselineCatalogRef, error) {
		return generateBaselineCatalogRef{
			ref: baselinePath,
			shadow: &shadowSession{
				config: shadowConfig,
			},
		}, nil
	}
	declarativeExportRef = func(_ context.Context, sourceRef, _ string, _ []string, _ string, _ ...func(*pgx.ConnConfig)) (diff.DeclarativeOutput, error) {
		assert.Equal(t, baselinePath, sourceRef)
		return diff.DeclarativeOutput{
			Files: []diff.DeclarativeFile{
				{Path: "cluster/roles.sql", SQL: "create role app;"},
			},
		}, nil
	}
	fallbackCalled := false
	declarativeCatalogRefResolver = func(_ context.Context, _ bool, _ afero.Fs, _ ...func(*pgx.ConnConfig)) (string, error) {
		fallbackCalled = true
		return "", nil
	}
	applyCalled := false
	applyDeclarative = func(_ context.Context, config pgconn.Config, _ afero.Fs) error {
		applyCalled = true
		assert.Equal(t, shadowConfig.Host, config.Host)
		assert.Equal(t, shadowConfig.Port, config.Port)
		return nil
	}
	exportCatalog = func(_ context.Context, _ string, role string, _ ...func(*pgx.ConnConfig)) (string, error) {
		assert.Equal(t, "postgres", role)
		return `{"version":1}`, nil
	}

	err := Generate(t.Context(), nil, pgconn.Config{Host: "127.0.0.1", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres"}, true, false, fsys)
	require.NoError(t, err)
	assert.True(t, applyCalled, "generate should apply declarative schema using reused baseline shadow")
	assert.False(t, fallbackCalled, "fallback declarative resolver should not run when baseline shadow is reusable")

	hash, err := hashDeclarativeSchemas(fsys)
	require.NoError(t, err)
	cachePath, ok, err := resolveDeclarativeCatalogPath(fsys, hash, "local")
	require.NoError(t, err)
	require.True(t, ok)
	assert.NotEmpty(t, cachePath)
}
