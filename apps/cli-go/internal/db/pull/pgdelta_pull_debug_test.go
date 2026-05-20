package pull

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
)

func TestSaveEmptyPgDeltaPullDebug(t *testing.T) {
	t.Setenv("PGDELTA_DEBUG", "1")
	fsys := afero.NewMemMapFs()
	original := exportCatalogPgDelta
	t.Cleanup(func() {
		exportCatalogPgDelta = original
	})
	exportCatalogPgDelta = func(ctx context.Context, targetRef, role string, options ...func(*pgx.ConnConfig)) (string, error) {
		return `{"schema":"public","name":"airports"}`, nil
	}
	config := pgconn.Config{
		Host:     "db.example.supabase.co",
		Port:     5432,
		User:     "postgres",
		Password: "secret",
		Database: "postgres",
	}
	capture := &diff.PgDeltaDebugCapture{
		SourceCatalog: `{"schema":"public","name":"roles"}`,
		Stderr:        `{"statementCount":0}`,
	}
	debugDir, err := saveEmptyPgDeltaPullDebug(context.Background(), config, capture, fsys)
	require.NoError(t, err)
	require.NotEmpty(t, debugDir)

	sourcePath := filepath.Join(debugDir, "source-catalog.json")
	targetPath := filepath.Join(debugDir, "target-catalog.json")
	stderrPath := filepath.Join(debugDir, "pgdelta-stderr.txt")
	connectionPath := filepath.Join(debugDir, "connection.txt")
	errorPath := filepath.Join(debugDir, "error.txt")

	source, err := afero.ReadFile(fsys, sourcePath)
	require.NoError(t, err)
	assert.Contains(t, string(source), `"roles"`)

	target, err := afero.ReadFile(fsys, targetPath)
	require.NoError(t, err)
	assert.Contains(t, string(target), `"airports"`)

	stderr, err := afero.ReadFile(fsys, stderrPath)
	require.NoError(t, err)
	assert.Contains(t, string(stderr), `"statementCount":0`)

	connection, err := afero.ReadFile(fsys, connectionPath)
	require.NoError(t, err)
	assert.Contains(t, string(connection), "db.example.supabase.co")
	assert.NotContains(t, string(connection), "secret")

	errorText, err := afero.ReadFile(fsys, errorPath)
	require.NoError(t, err)
	assert.Contains(t, string(errorText), "No schema changes found")
}

func TestSaveEmptyPgDeltaPullDebugUsesTempDir(t *testing.T) {
	fsys := afero.NewMemMapFs()
	original := exportCatalogPgDelta
	t.Cleanup(func() {
		exportCatalogPgDelta = original
	})
	exportCatalogPgDelta = func(ctx context.Context, targetRef, role string, options ...func(*pgx.ConnConfig)) (string, error) {
		return `{}`, nil
	}
	debugDir, err := saveEmptyPgDeltaPullDebug(context.Background(), pgconn.Config{}, &diff.PgDeltaDebugCapture{}, fsys)
	require.NoError(t, err)
	assert.Contains(t, debugDir, filepath.Join(utils.TempDir, "pgdelta", "debug"))
}

func TestDiffRemoteSchemaEmptyWithoutDebug(t *testing.T) {
	t.Setenv("PGDELTA_DEBUG", "")
	fsys := afero.NewMemMapFs()
	existsBefore, err := afero.Exists(fsys, filepath.Join(utils.TempDir, "pgdelta"))
	require.NoError(t, err)
	assert.False(t, existsBefore)

	// saveEmptyPgDeltaPullDebug should not run when env is unset; verify gate directly.
	assert.False(t, diff.IsPgDeltaDebugEnabled())
	_, err = os.Stat(filepath.Join(utils.TempDir, "pgdelta", "debug"))
	assert.Error(t, err)
}
