package deploy

import (
	"embed"
	"io"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
	"github.com/supabase/cli/internal/utils"
)

//go:embed testdata
var testImports embed.FS

type MockFS struct {
	mock.Mock
}

func (m *MockFS) ReadFile(srcPath string, w io.Writer) error {
	_ = m.Called(srcPath)
	data, err := testImports.ReadFile(srcPath)
	if err != nil {
		return err
	}
	if _, err := w.Write(data); err != nil {
		return err
	}
	return nil
}

func TestImportPaths(t *testing.T) {
	t.Run("iterates all import paths", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFS{}
		fsys.On("ReadFile", "/modules/my-module.ts").Once()
		fsys.On("ReadFile", "testdata/modules/imports.ts").Once()
		fsys.On("ReadFile", "testdata/geometries/Geometries.js").Once()
		// Run test
		im := utils.ImportMap{}
		err := walkImportPaths("testdata/modules/imports.ts", im, fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})

	t.Run("iterates with import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFS{}
		fsys.On("ReadFile", "/modules/my-module.ts").Once()
		fsys.On("ReadFile", "testdata/modules/imports.ts").Once()
		fsys.On("ReadFile", "testdata/geometries/Geometries.js").Once()
		fsys.On("ReadFile", "testdata/shared/whatever.ts").Once()
		fsys.On("ReadFile", "testdata/nested/index.ts").Once()
		// Run test
		im := utils.ImportMap{Imports: map[string]string{
			"module-name/": "../shared/",
		}}
		err := walkImportPaths("testdata/modules/imports.ts", im, fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})
}
