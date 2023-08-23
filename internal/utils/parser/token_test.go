package parser

import (
	"bufio"
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
	fixture = append(fixture, "\n")

	sql, err := os.Open(filepath.Join(testdata, "all.sql"))
	require.NoError(t, err)
	stats, err := Split(sql)
	require.NoError(t, err)

	assert.ElementsMatch(t, fixture, stats)
}

func TestSplitAndTrim(t *testing.T) {
	sql := "\tBEGIN; " + strings.Repeat("a", MaxScannerCapacity)
	stats, err := SplitAndTrim(strings.NewReader(sql))
	// Check error
	assert.ErrorIs(t, err, bufio.ErrTooLong)
	assert.ErrorContains(t, err, "After statement 1:     BEGIN;")
	assert.ElementsMatch(t, []string{"BEGIN"}, stats)
}
