package function

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	fs "testing/fstest"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/supabase/cli/pkg/cast"
)

func TestMain(m *testing.M) {
	// Setup mock edge runtime binary
	if len(os.Args) > 1 && os.Args[1] == "bundle" {
		if msg := os.Getenv("TEST_BUNDLE_ERROR"); len(msg) > 0 {
			fmt.Fprintln(os.Stderr, msg)
			os.Exit(1)
		}
		os.Exit(0)
	}
	// Run test suite
	os.Exit(m.Run())
}

func TestBundleFunction(t *testing.T) {
	cwd, err := os.Getwd()
	require.NoError(t, err)
	edgeRuntimeBin, err = os.Executable()
	require.NoError(t, err)

	t.Run("creates eszip bundle", func(t *testing.T) {
		var body bytes.Buffer
		// Setup in-memory fs
		fsys := fs.MapFS{
			"hello.eszip": &fs.MapFile{},
		}
		// Setup mock bundler
		bundler := nativeBundler{fsys: fsys}
		// Run test
		meta, err := bundler.Bundle(
			context.Background(),
			"hello",
			"hello/index.ts",
			"hello/deno.json",
			[]string{"hello/data.pdf"},
			&body,
		)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, compressedEszipMagicID+";", body.String())
		assert.Equal(t, cast.Ptr("hello"), meta.Name)
		entrypoint := fmt.Sprintf("file://%s/hello/index.ts", filepath.ToSlash(cwd))
		assert.Equal(t, entrypoint, meta.EntrypointPath)
		importMap := fmt.Sprintf("file://%s/hello/deno.json", filepath.ToSlash(cwd))
		assert.Equal(t, &importMap, meta.ImportMapPath)
		staticFile := fmt.Sprintf("file://%s/hello/data.pdf", filepath.ToSlash(cwd))
		assert.Equal(t, cast.Ptr([]string{staticFile}), meta.StaticPatterns)
		assert.Nil(t, meta.VerifyJwt)
	})

	t.Run("ignores empty value", func(t *testing.T) {
		var body bytes.Buffer
		// Setup in-memory fs
		fsys := fs.MapFS{
			"hello.eszip": &fs.MapFile{},
		}
		// Setup mock bundler
		bundler := nativeBundler{fsys: fsys}
		// Run test
		meta, err := bundler.Bundle(
			context.Background(),
			"hello",
			"hello/index.ts",
			"",
			nil,
			&body,
		)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, compressedEszipMagicID+";", body.String())
		assert.Equal(t, cast.Ptr("hello"), meta.Name)
		entrypoint := fmt.Sprintf("file://%s/hello/index.ts", filepath.ToSlash(cwd))
		assert.Equal(t, entrypoint, meta.EntrypointPath)
		assert.Nil(t, meta.ImportMapPath)
		assert.NotNil(t, meta.StaticPatterns)
		assert.Nil(t, meta.VerifyJwt)
	})
}
