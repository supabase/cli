package placement

import (
	"path/filepath"
	"strings"
)

const (
	placeholderSchema   = "{schema}"
	placeholderName     = "{name}"
	placeholderBasename = "{basename}"
)

type Context struct {
	Schema      string
	Name        string
	DefaultPath string
}

func ResolvePath(schemaKey string, schemaPlacement map[string]string, ctx Context) string {
	pattern := strings.TrimSpace(schemaPlacement[schemaKey])
	if len(pattern) == 0 {
		return ctx.DefaultPath
	}
	resolved := strings.NewReplacer(
		placeholderSchema, ctx.Schema,
		placeholderName, ctx.Name,
		placeholderBasename, filepath.Base(ctx.DefaultPath),
	).Replace(pattern)
	// Treat path as a file if:
	// - it's explicitly a SQL file
	// - it includes supported placeholders and user expects exact rendering
	// - it contains any placeholder expression
	if filepath.Ext(resolved) == ".sql" ||
		strings.Contains(pattern, placeholderSchema) ||
		strings.Contains(pattern, placeholderName) ||
		strings.Contains(pattern, placeholderBasename) ||
		strings.Contains(resolved, "{") {
		return filepath.Clean(resolved)
	}
	if len(ctx.Name) > 0 {
		return filepath.Join(resolved, ctx.Name+".sql")
	}
	return filepath.Join(resolved, filepath.Base(ctx.DefaultPath))
}
