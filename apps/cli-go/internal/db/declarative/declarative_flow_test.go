package declarative

import (
	"context"
	"encoding/json"
	"sort"
	"strings"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
)

// catalogObjects models a pg-delta catalog snapshot as the set of object names
// present in a shadow database, so the full generate -> sync flow can be
// exercised without the real pg-delta runtime while still proving that platform
// objects cancel out of the generated diff.
type catalogObjects struct {
	Objects []string `json:"objects"`
}

func marshalCatalog(objects []string) string {
	sorted := append([]string(nil), objects...)
	sort.Strings(sorted)
	out, _ := json.Marshal(catalogObjects{Objects: sorted})
	return string(out)
}

func readCatalogObjects(t *testing.T, fsys afero.Fs, path string) []string {
	t.Helper()
	raw, err := afero.ReadFile(fsys, path)
	require.NoError(t, err)
	var parsed catalogObjects
	require.NoError(t, json.Unmarshal(raw, &parsed))
	return parsed.Objects
}

// TestGenerateThenSyncWithNoMigrationsCancelsPlatformObjects exercises the full
// generate -> sync (no local migrations) flow end to end through the public
// command functions. The bug it guards: generate writes the baseline catalog
// (catalog-baseline-<version>.json) that sync reuses as its diff source when
// there are no local migrations. If that baseline is captured from a bare image
// instead of the platform baseline, platform-managed objects (auth/storage/
// realtime) leak into the generated migration even though the user only declared
// a single table. The Docker and pg-delta seams are stubbed (the established
// cli-go pattern) so the test runs in the standard `go test ./...` CI job.
func TestGenerateThenSyncWithNoMigrationsCancelsPlatformObjects(t *testing.T) {
	fsys := afero.NewMemMapFs()
	require.NoError(t, afero.WriteFile(fsys, utils.ConfigPath, []byte("[db]\n"), 0644))

	originalPgDelta := utils.Config.Experimental.PgDelta
	originalImage := utils.Config.Db.Image
	originalCreateShadow := createShadow
	originalSetupShadow := setupShadowDatabase
	originalExportCatalog := exportCatalog
	originalApplyDeclarative := applyDeclarative
	originalExportRef := declarativeExportRef
	originalDiffRef := diffPgDeltaRef
	t.Cleanup(func() {
		utils.Config.Experimental.PgDelta = originalPgDelta
		utils.Config.Db.Image = originalImage
		createShadow = originalCreateShadow
		setupShadowDatabase = originalSetupShadow
		exportCatalog = originalExportCatalog
		applyDeclarative = originalApplyDeclarative
		declarativeExportRef = originalExportRef
		diffPgDeltaRef = originalDiffRef
	})

	utils.Config.Experimental.PgDelta = &config.PgDeltaConfig{Enabled: true}
	utils.Config.Db.Image = "public.ecr.aws/supabase/postgres:15.8.1.049"

	shadowConfig := pgconn.Config{Host: "127.0.0.1", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres"}
	// Model the evolving shadow state: platform baseline provisioning adds the
	// auth/storage/realtime schemas, declarative apply adds the user's table.
	platformReady := false
	declarativeApplied := false
	platformObjects := []string{"auth", "realtime", "storage"}
	const userObject = "public.profiles"

	createShadow = func(_ context.Context) (string, pgconn.Config, error) {
		return "test-shadow-container", shadowConfig, nil
	}
	setupShadowDatabase = func(_ context.Context, _ string, _ afero.Fs, _ ...func(*pgx.ConnConfig)) error {
		platformReady = true
		return nil
	}
	applyDeclarative = func(_ context.Context, _ pgconn.Config, _ afero.Fs) error {
		declarativeApplied = true
		return nil
	}
	exportCatalog = func(_ context.Context, _ string, role string, _ ...func(*pgx.ConnConfig)) (string, error) {
		assert.Equal(t, "postgres", role)
		var objects []string
		if platformReady {
			objects = append(objects, platformObjects...)
		}
		if declarativeApplied {
			objects = append(objects, userObject)
		}
		return marshalCatalog(objects), nil
	}
	// generate exports declarative files from the live database; emit a single
	// table that depends on auth so WriteDeclarativeSchemas + hashing have content.
	declarativeExportRef = func(_ context.Context, _, _ string, _ []string, _ string, _ ...func(*pgx.ConnConfig)) (diff.DeclarativeOutput, error) {
		return diff.DeclarativeOutput{
			Files: []diff.DeclarativeFile{
				{Path: "schemas/public/tables/profiles.sql", SQL: "create table public.profiles (id uuid primary key references auth.users(id));"},
			},
		}, nil
	}
	// Stand in for the pg-delta diff: emit DDL for objects present in the target
	// catalog but missing from the source catalog. Platform objects that exist in
	// both sides must not appear.
	diffPgDeltaRef = func(_ context.Context, sourceRef, targetRef string, _ []string, _ string, _ ...func(*pgx.ConnConfig)) (string, error) {
		source := readCatalogObjects(t, fsys, sourceRef)
		target := readCatalogObjects(t, fsys, targetRef)
		inSource := make(map[string]bool, len(source))
		for _, obj := range source {
			inSource[obj] = true
		}
		var added []string
		for _, obj := range target {
			if !inSource[obj] {
				added = append(added, obj)
			}
		}
		sort.Strings(added)
		var sb strings.Builder
		for _, obj := range added {
			sb.WriteString("create " + obj + ";\n")
		}
		return sb.String(), nil
	}

	liveConfig := pgconn.Config{Host: "db.test.supabase.co", Port: 5432, User: "postgres", Password: "postgres", Database: "postgres"}

	// 1. generate writes declarative files and warms the baseline + declarative caches.
	require.NoError(t, Generate(t.Context(), nil, liveConfig, true, false, fsys))

	// The baseline catalog reused by sync must represent the platform baseline,
	// not a bare image.
	baselinePath, err := baselineCatalogPath(fsys)
	require.NoError(t, err)
	assert.ElementsMatch(t, platformObjects, readCatalogObjects(t, fsys, baselinePath),
		"baseline catalog must capture the platform baseline (auth/storage/realtime)")

	// 2. sync with no local migrations diffs the warmed declarative catalog against
	// the baseline. Platform objects exist on both sides, so only the user's table
	// should surface in the generated migration.
	result, err := DiffDeclarativeToMigrations(t.Context(), nil, false, fsys)
	require.NoError(t, err)
	assert.Equal(t, baselinePath, result.SourceRef, "no-migration sync must source from the platform baseline catalog")
	assert.Contains(t, result.DiffSQL, "public.profiles", "the user's declared table should be generated")
	for _, platform := range platformObjects {
		assert.NotContains(t, result.DiffSQL, "create "+platform+";",
			"platform object %q must cancel out instead of leaking into the migration", platform)
	}
}
