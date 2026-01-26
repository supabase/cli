package format

import (
	"context"
	"embed"
	"fmt"
	"io/fs"
	"path"
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
			sql, err := afero.ReadFile(testFs, dumpPath)
			assert.NoError(t, err)
			// Setup in-memory fs
			fsys := afero.NewMemMapFs()
			// Run test
			err = WriteStructuredSchemas(context.Background(), string(sql), fsys)
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
