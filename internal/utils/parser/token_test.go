package parser

import (
	_ "embed"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSplit(t *testing.T) {
	const testdata = "testdata"

	var fixture []string
	require.NoError(t, filepath.WalkDir(testdata, func(path string, f fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !strings.HasPrefix(f.Name(), "split_") {
			return nil
		}
		contents, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		fixture = append(fixture, string(contents))
		return nil
	}))
	require.Len(t, fixture, 18)

	sql, err := os.Open(filepath.Join(testdata, "all.sql"))
	require.NoError(t, err)
	stats, err := Split(sql)
	require.NoError(t, err)

	assert.ElementsMatch(t, fixture, stats[:len(fixture)])
}
