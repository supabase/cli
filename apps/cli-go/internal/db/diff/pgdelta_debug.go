package diff

import (
	"encoding/json"
	"os"
	"strings"
)

// IsPgDeltaDebugEnabled reports whether pg-delta diagnostic output is requested.
// Unlike --debug, this does not disable SSL for remote Postgres connections.
func IsPgDeltaDebugEnabled() bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv("PGDELTA_DEBUG"))) {
	case "1", "true", "yes":
		return true
	default:
		return false
	}
}

// PgDeltaDiffResult holds the parsed pg-delta diff envelope (one file per
// execution-aware plan unit) and the edge-runtime stderr.
type PgDeltaDiffResult struct {
	Files  []PgDeltaPlanFile
	Stderr string
}

// PgDeltaDebugCapture holds artifacts collected during a pg-delta shadow diff.
type PgDeltaDebugCapture struct {
	SourceCatalog string
	Stderr        string
}

// DatabaseDiff is the result of diffing a target database against a shadow baseline.
type DatabaseDiff struct {
	SQL string
	// Files carries the per-unit pg-delta plan files (empty for the migra engine).
	// SQL is the flattened join of these, kept for callers that consume one blob.
	Files []PgDeltaPlanFile
	Debug *PgDeltaDebugCapture
}

// CatalogSummary summarizes object counts extracted from a pg-delta catalog JSON blob.
type CatalogSummary struct {
	TotalObjects int
	BySchema     map[string]int
}

// SummarizeCatalogJSON best-effort counts catalog objects grouped by schema name.
func SummarizeCatalogJSON(catalogJSON string) CatalogSummary {
	summary := CatalogSummary{BySchema: map[string]int{}}
	if len(strings.TrimSpace(catalogJSON)) == 0 {
		return summary
	}
	var root any
	if err := json.Unmarshal([]byte(catalogJSON), &root); err != nil {
		return summary
	}
	walkCatalogObjects(root, summary.BySchema, &summary.TotalObjects)
	return summary
}

func walkCatalogObjects(node any, bySchema map[string]int, total *int) {
	switch value := node.(type) {
	case map[string]any:
		if schema, ok := schemaNameFromCatalogNode(value); ok {
			*total++
			bySchema[schema]++
		}
		for _, child := range value {
			walkCatalogObjects(child, bySchema, total)
		}
	case []any:
		for _, child := range value {
			walkCatalogObjects(child, bySchema, total)
		}
	}
}

func schemaNameFromCatalogNode(node map[string]any) (string, bool) {
	if schema, ok := node["schema"].(string); ok && len(schema) > 0 {
		return schema, true
	}
	if schemaObj, ok := node["schema"].(map[string]any); ok {
		if name, ok := schemaObj["name"].(string); ok && len(name) > 0 {
			return name, true
		}
	}
	return "", false
}
