package function

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"testing"
	fs "testing/fstest"

	"github.com/stretchr/testify/assert"
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
	edgeRuntimeBin, _ = os.Executable()

	t.Run("creates eszip bundle", func(t *testing.T) {
		var body bytes.Buffer
		// Setup in-memory fs
		fsys := fs.MapFS{
			"hello.eszip": &fs.MapFile{},
		}
		// Setup mock bundler
		bundler := nativeBundler{fsys: fsys}
		// Run test
		err := bundler.Bundle(context.Background(), "hello/index.ts", "", &body)
		// Check error
		assert.NoError(t, err)
		assert.Equal(t, compressedEszipMagicID+";", body.String())
	})
}
