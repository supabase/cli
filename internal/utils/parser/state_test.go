package parser

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestLineComment(t *testing.T) {
	t.Run("after separator", func(t *testing.T) {
		sql := "END;-- comment"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"END;", "-- comment"}, stats)
	})

	t.Run("before separator", func(t *testing.T) {
		sql := "SELECT --; 1"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT --; 1"}, stats)
	})

	t.Run("not started", func(t *testing.T) {
		sql := "- ;END"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"- ;", "END"}, stats)
	})

	t.Run("between lines", func(t *testing.T) {
		sql := "-- /* \n; */ END"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"-- /* \n;", " */ END"}, stats)
	})
}

func TestBlockComment(t *testing.T) {
	t.Run("contains separator", func(t *testing.T) {
		sql := "SELECT /* ; */ 1;"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT /* ; */ 1;"}, stats)
	})

	t.Run("nested block", func(t *testing.T) {
		sql := "SELECT /*; /*;*/ ;*/ 1"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT /*; /*;*/ ;*/ 1"}, stats)
	})

	t.Run("not started", func(t *testing.T) {
		sql := "/ * ; */ END"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"/ * ;", " */ END"}, stats)
	})
}

func TestSeparator(t *testing.T) {
	t.Run("no spaces", func(t *testing.T) {
		sql := ";END;;"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{";", "END;", ";"}, stats)
	})

	t.Run("between spaces", func(t *testing.T) {
		sql := "BEGIN   ;  END"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"BEGIN   ;", "  END"}, stats)
	})

	t.Run("backslash escaped", func(t *testing.T) {
		sql := "\\;;\\;"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"\\;;", "\\;"}, stats)
	})
}

func TestDollarQuote(t *testing.T) {
	t.Run("named tag", func(t *testing.T) {
		sql := "$tag$ any ; string$tag$"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"$tag$ any ; string$tag$"}, stats)
	})

	t.Run("anonymous tag", func(t *testing.T) {
		sql := "$$\"Dane's horse\"$$"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"$$\"Dane's horse\"$$"}, stats)
	})

	t.Run("not started", func(t *testing.T) {
		sql := "SELECT \"$\"; $$"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT \"$\";", " $$"}, stats)
	})
}

func TestSingleQuote(t *testing.T) {
	t.Run("escapes separator", func(t *testing.T) {
		sql := "SELECT ';' 1"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT ';' 1"}, stats)
	})

	t.Run("preserves single quote", func(t *testing.T) {
		sql := "SELECT ';'';' 1"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT ';'';' 1"}, stats)
	})

	t.Run("literal backslash", func(t *testing.T) {
		sql := "SELECT '\\'; 1'"
		stats, err := Split(strings.NewReader(sql))
		require.NoError(t, err)
		assert.ElementsMatch(t, []string{"SELECT '\\';", " 1'"}, stats)
	})
}
