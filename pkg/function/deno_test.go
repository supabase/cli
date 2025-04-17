package function

import (
	"embed"
	"io"
	"os"
	"testing"
	fs "testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/mock"
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
		im := ImportMap{}
		err := im.WalkImportPaths("testdata/modules/imports.ts", fsys.ReadFile)
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
		fsys.On("ReadFile", "testdata/shared/mod.ts").Once()
		fsys.On("ReadFile", "testdata/nested/index.ts").Once()
		// Setup deno.json
		im := ImportMap{Imports: map[string]string{
			"module-name/": "../shared/",
		}}
		assert.NoError(t, im.Resolve("testdata/modules/deno.json", testImports))
		// Run test
		err := im.WalkImportPaths("testdata/modules/imports.ts", fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})

	t.Run("resolves legacy import map", func(t *testing.T) {
		// Setup in-memory fs
		fsys := MockFS{}
		fsys.On("ReadFile", "/modules/my-module.ts").Once()
		fsys.On("ReadFile", "testdata/modules/imports.ts").Once()
		fsys.On("ReadFile", "testdata/geometries/Geometries.js").Once()
		fsys.On("ReadFile", "testdata/shared/whatever.ts").Once()
		fsys.On("ReadFile", "testdata/shared/mod.ts").Once()
		fsys.On("ReadFile", "testdata/nested/index.ts").Once()
		// Setup legacy import map
		im := ImportMap{Imports: map[string]string{
			"module-name/": "./shared/",
		}}
		assert.NoError(t, im.Resolve("testdata/import_map.json", testImports))
		// Run test
		err := im.WalkImportPaths("testdata/modules/imports.ts", fsys.ReadFile)
		// Check error
		assert.NoError(t, err)
		fsys.AssertExpectations(t)
	})
}

func TestResolveImports(t *testing.T) {
	t.Run("resolves relative directory", func(t *testing.T) {
		imPath := "supabase/functions/import_map.json"
		// Setup in-memory fs
		fsys := fs.MapFS{
			imPath: &fs.MapFile{Data: []byte(`{
				"imports": {
					"abs/":    "/tmp/",
					"root":    "../../common",
					"parent":  "../tests",
					"child":   "child/",
					"missing": "../missing"
				}
			}`)},
			"/tmp/":                    &fs.MapFile{},
			"common":                   &fs.MapFile{},
			"supabase/tests":           &fs.MapFile{},
			"supabase/functions/child": &fs.MapFile{},
		}
		// Run test
		resolved := ImportMap{}
		err := resolved.Load(imPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "/tmp/", resolved.Imports["abs/"])
		assert.Equal(t, "./common", resolved.Imports["root"])
		assert.Equal(t, "./supabase/tests", resolved.Imports["parent"])
		assert.Equal(t, "./supabase/functions/child/", resolved.Imports["child"])
		assert.Equal(t, "../missing", resolved.Imports["missing"])
	})

	t.Run("resolves parent scopes", func(t *testing.T) {
		imPath := "supabase/functions/import_map.json"
		// Setup in-memory fs
		fsys := fs.MapFS{
			imPath: &fs.MapFile{Data: []byte(`{
				"scopes": {
					"my-scope": {
						"my-mod": "https://deno.land"
					}
				}
			}`)},
		}
		// Run test
		resolved := ImportMap{}
		err := resolved.Load(imPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "https://deno.land", resolved.Scopes["my-scope"]["my-mod"])
	})
}

func TestResolveDeno(t *testing.T) {
	t.Run("resolves deno.json", func(t *testing.T) {
		imPath := "supabase/functions/slug/deno.json"
		// Setup in-memory fs
		fsys := fs.MapFS{
			imPath: &fs.MapFile{Data: []byte(`{
				"imports": {
					"@mod": "./mod.ts"
				},
				"importMap": "../../import_map.json"
			}`)},
			"supabase/functions/slug/mod.ts": &fs.MapFile{},
		}
		// Run test
		resolved := ImportMap{}
		err := resolved.LoadAsDeno(imPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "./supabase/functions/slug/mod.ts", resolved.Imports["@mod"])
	})

	t.Run("resolves fallback imports", func(t *testing.T) {
		imPath := "supabase/functions/slug/deno.json"
		// Setup in-memory fs
		fsys := fs.MapFS{
			imPath: &fs.MapFile{Data: []byte(`{
				"importMap": "../../import_map.json"
			}`)},
			"supabase/import_map.json": &fs.MapFile{Data: []byte(`{
				"imports": {
					"my-mod": "https://deno.land"
				}
			}`)},
		}
		// Run test
		resolved := ImportMap{}
		err := resolved.LoadAsDeno(imPath, fsys)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, "https://deno.land", resolved.Imports["my-mod"])
	})

	t.Run("throws error on missing import", func(t *testing.T) {
		imPath := "supabase/functions/slug/deno.jsonc"
		// Setup in-memory fs
		fsys := fs.MapFS{
			imPath: &fs.MapFile{Data: []byte(`{
				"importMap": "../../import_map.json"
			}`)},
		}
		// Run test
		resolved := ImportMap{}
		err := resolved.LoadAsDeno(imPath, fsys)
		// Check error
		assert.ErrorIs(t, err, os.ErrNotExist)
		assert.Empty(t, resolved.Imports)
		assert.Empty(t, resolved.Scopes)
	})
}
