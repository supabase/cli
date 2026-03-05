package format

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path"
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
