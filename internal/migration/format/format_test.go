package format

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path"
	"path/filepath"
	"strings"
	"testing"

	"github.com/spf13/afero"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/internal/utils"
)

//go:embed testdata
var testdata embed.FS

func TestWriteStructured(t *testing.T) {
	testCases, err := testdata.ReadDir("testdata")
	require.NoError(t, err)

	for _, tc := range testCases {
		testName := fmt.Sprintf("formats %s statements", tc.Name())
		testFs := afero.NewBasePathFs(
			afero.FromIOFS{FS: testdata},
			path.Join("testdata", tc.Name()),
		)
		const dumpPath = "dump.sql"

		t.Run(testName, func(t *testing.T) {
			sql, err := testFs.Open(dumpPath)
			require.NoError(t, err)
			defer sql.Close()
			// Setup in-memory fs
			fsys := afero.NewMemMapFs()
			// Run test
			err = WriteStructuredSchemas(context.Background(), sql, fsys)
			// Check error
			assert.NoError(t, err)
			err = afero.Walk(testFs, ".", func(fp string, info fs.FileInfo, err error) error {
				if err != nil || info.IsDir() || info.Name() == dumpPath {
					return err
				}
				expected, err := afero.ReadFile(testFs, fp)
				assert.NoError(t, err)
				actual, _ := afero.ReadFile(fsys, path.Join(utils.SupabaseDirPath, fp))
				assert.Equal(t, string(expected), string(actual), fp)
				return nil
			})
			assert.NoError(t, err)
		})
	}
}

func TestAppendConfig(t *testing.T) {
	t.Run("replaces config inline", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		assert.NoError(t, utils.WriteConfig(fsys, false))
		// Run test
		utils.Config.Db.Migrations.SchemaPaths = []string{
			getSchemaPath("public"),
		}
		err := appendConfig(fsys)
		// Check error
		assert.NoError(t, err)
		data, err := afero.ReadFile(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.True(t, strings.Contains(string(data), `
schema_paths = [
  "schemas/public/schema.sql",
]
`))
		assert.True(t, strings.HasSuffix(
			strings.TrimSpace(string(data)),
			`s3_secret_key = "env(S3_SECRET_KEY)"`,
		))
	})

	t.Run("appends config file", func(t *testing.T) {
		// Setup in-memory fs
		fsys := afero.NewMemMapFs()
		// Run test
		utils.Config.Db.Migrations.SchemaPaths = []string{
			getSchemaPath("public"),
		}
		err := appendConfig(fsys)
		// Check error
		assert.NoError(t, err)
		data, err := afero.ReadFile(fsys, utils.ConfigPath)
		assert.NoError(t, err)
		assert.Equal(t, `
[db.migrations]
schema_paths = [
  "schemas/public/schema.sql",
]
`, string(data))
	})
}

func TestWriteStructuredWithSchemaPlacement(t *testing.T) {
	testFs := afero.NewBasePathFs(
		afero.FromIOFS{FS: testdata},
		path.Join("testdata", "simple"),
	)
	sql, err := testFs.Open("dump.sql")
	require.NoError(t, err)
	defer sql.Close()

	prevPlacement := utils.Config.Db.Migrations.SchemaPlacement
	prevSchemaPaths := utils.Config.Db.Migrations.SchemaPaths
	t.Cleanup(func() {
		utils.Config.Db.Migrations.SchemaPlacement = prevPlacement
		utils.Config.Db.Migrations.SchemaPaths = prevSchemaPaths
	})
	utils.Config.Db.Migrations.SchemaPlacement = map[string]string{
		"tables": filepath.Join(utils.SupabaseDirPath, "custom", "tables", "{name}.sql"),
		"types":  filepath.Join(utils.SupabaseDirPath, "custom", "types.sql"),
	}

	fsys := afero.NewMemMapFs()
	err = WriteStructuredSchemas(context.Background(), sql, fsys)
	require.NoError(t, err)

	expectedTable, err := afero.ReadFile(testFs, "schemas/public/tables/countries.sql")
	require.NoError(t, err)
	actualTable, err := afero.ReadFile(fsys, filepath.Join(utils.SupabaseDirPath, "custom", "tables", "countries.sql"))
	require.NoError(t, err)
	assert.Equal(t, string(expectedTable), string(actualTable))

	data, err := afero.ReadFile(fsys, utils.ConfigPath)
	require.NoError(t, err)
	assert.Contains(t, string(data), `"custom/tables/countries.sql"`)
	assert.Contains(t, string(data), `"custom/types.sql"`)
}
