package placement

import (
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestResolvePath(t *testing.T) {
	t.Run("falls back to default path", func(t *testing.T) {
		defaultPath := filepath.Join("supabase", "schemas", "public", "tables", "todos.sql")
		actual := ResolvePath("tables", nil, Context{
			Schema:      "public",
			Name:        "todos",
			DefaultPath: defaultPath,
		})
		assert.Equal(t, defaultPath, actual)
	})

	t.Run("resolves placeholders", func(t *testing.T) {
		defaultPath := filepath.Join("supabase", "schemas", "public", "tables", "todos.sql")
		actual := ResolvePath("tables", map[string]string{
			"tables": filepath.Join("supabase", "database", "{schema}", "{name}.sql"),
		}, Context{
			Schema:      "public",
			Name:        "todos",
			DefaultPath: defaultPath,
		})
		assert.Equal(t, filepath.Join("supabase", "database", "public", "todos.sql"), actual)
	})

	t.Run("treats non-file path as directory for named component", func(t *testing.T) {
		defaultPath := filepath.Join("supabase", "schemas", "public", "tables", "todos.sql")
		actual := ResolvePath("tables", map[string]string{
			"tables": filepath.Join("supabase", "database", "tables"),
		}, Context{
			Schema:      "public",
			Name:        "todos",
			DefaultPath: defaultPath,
		})
		assert.Equal(t, filepath.Join("supabase", "database", "tables", "todos.sql"), actual)
	})

	t.Run("treats non-file path as directory for singleton component", func(t *testing.T) {
		defaultPath := filepath.Join("supabase", "cluster", "extensions.sql")
		actual := ResolvePath("extensions", map[string]string{
			"extensions": filepath.Join("supabase", "database", "cluster"),
		}, Context{
			DefaultPath: defaultPath,
		})
		assert.Equal(t, filepath.Join("supabase", "database", "cluster", "extensions.sql"), actual)
	})
}
