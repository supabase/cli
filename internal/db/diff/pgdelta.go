package diff

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/pgdelta.ts
var pgDeltaScript string

//go:embed templates/pgdelta_declarative_export.ts
var pgDeltaDeclarativeExportScript string

//go:embed templates/pgdelta_catalog_export.ts
var pgDeltaCatalogExportScript string

// DeclarativeFile mirrors the per-file payload returned by pg-delta declarative
// export so the CLI can materialize structured SQL files on disk.
type DeclarativeFile struct {
	Path       string `json:"path"`
	Order      int    `json:"order"`
	Statements int    `json:"statements"`
	SQL        string `json:"sql"`
}

// DeclarativeOutput is the top-level declarative export envelope emitted by the
// pg-delta script and consumed by db/declarative workflows.
type DeclarativeOutput struct {
	Version int               `json:"version"`
	Mode    string            `json:"mode"`
	Files   []DeclarativeFile `json:"files"`
}

func isPostgresURL(ref string) bool {
	return strings.HasPrefix(ref, "postgres://") || strings.HasPrefix(ref, "postgresql://")
}

// containerRef translates a host-relative catalog file path into the absolute
// path where it appears inside the edge runtime container (CWD mounted at
// /workspace). Postgres URLs and empty strings pass through unchanged.
func containerRef(ref string) string {
	if ref == "" || isPostgresURL(ref) {
		return ref
	}
	return "/workspace/" + ref
}

// pgDeltaFormatOptions returns the experimental.pgdelta.format_options config for
// use when invoking pg-delta scripts that produce SQL output.
func pgDeltaFormatOptions() string {
	if utils.Config.Experimental.PgDelta == nil {
		return ""
	}
	return strings.TrimSpace(utils.Config.Experimental.PgDelta.FormatOptions)
}

// DiffPgDelta diffs source and target Postgres configs via pg-delta.
//
// This wrapper preserves the old config-based interface while delegating to
// DiffPgDeltaRef, which also supports catalog-file references. Format options
// are read from config so DiffFunc callers do not need to change.
func DiffPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, options ...func(*pgx.ConnConfig)) (string, error) {
	return DiffPgDeltaRef(ctx, utils.ToPostgresURL(source), utils.ToPostgresURL(target), schema, pgDeltaFormatOptions(), options...)
}

// DiffPgDeltaRef supports pg-delta diffing across both live database URLs and
// on-disk catalog references used by declarative sync commands. formatOptions
// is passed through as FORMAT_OPTIONS to the pg-delta script when non-empty.
func DiffPgDeltaRef(ctx context.Context, sourceRef, targetRef string, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"TARGET=" + containerRef(targetRef),
	}
	if len(sourceRef) > 0 {
		env = append(env, "SOURCE="+containerRef(sourceRef))
	}
	if isPostgresURL(targetRef) {
		if ca, err := types.GetRootCA(ctx, targetRef, options...); err != nil {
			return "", err
		} else if len(ca) > 0 {
			env = append(env, "PGDELTA_TARGET_SSLROOTCERT="+ca)
		}
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	if len(strings.TrimSpace(formatOptions)) > 0 {
		env = append(env, "FORMAT_OPTIONS="+formatOptions)
	}
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaScript, binds, "error diffing schema", &stdout, &stderr); err != nil {
		return "", err
	}
	return stdout.String(), nil
}

// DeclarativeExportPgDelta exports target schema as declarative file payloads
// while keeping a config-based API for existing call sites.
func DeclarativeExportPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (DeclarativeOutput, error) {
	return DeclarativeExportPgDeltaRef(ctx, utils.ToPostgresURL(source), utils.ToPostgresURL(target), schema, formatOptions, options...)
}

// DeclarativeExportPgDeltaRef exports declarative file payloads using either
// live URLs or catalog references as source/target inputs.
func DeclarativeExportPgDeltaRef(ctx context.Context, sourceRef, targetRef string, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (DeclarativeOutput, error) {
	env := []string{
		"TARGET=" + containerRef(targetRef),
	}
	if len(sourceRef) > 0 {
		env = append(env, "SOURCE="+containerRef(sourceRef))
	}
	if isPostgresURL(targetRef) {
		if ca, err := types.GetRootCA(ctx, targetRef, options...); err != nil {
			return DeclarativeOutput{}, err
		} else if len(ca) > 0 {
			env = append(env, "PGDELTA_TARGET_SSLROOTCERT="+ca)
		}
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	if len(strings.TrimSpace(formatOptions)) > 0 {
		env = append(env, "FORMAT_OPTIONS="+formatOptions)
	}
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaDeclarativeExportScript, binds, "error exporting declarative schema", &stdout, &stderr); err != nil {
		return DeclarativeOutput{}, err
	}
	var result DeclarativeOutput
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return DeclarativeOutput{}, errors.Errorf("failed to parse declarative export output: %w", err)
	}
	return result, nil
}

// ExportCatalogPgDelta snapshots a database/catalog into serialized pg-delta
// catalog JSON so later operations can diff without reconnecting.
func ExportCatalogPgDelta(ctx context.Context, targetRef, role string, options ...func(*pgx.ConnConfig)) (string, error) {
	env := []string{
		"TARGET=" + targetRef,
	}
	if len(role) > 0 {
		env = append(env, "ROLE="+role)
	}
	if isPostgresURL(targetRef) {
		if ca, err := types.GetRootCA(ctx, targetRef, options...); err != nil {
			return "", err
		} else if len(ca) > 0 {
			env = append(env, "PGDELTA_TARGET_SSLROOTCERT="+ca)
		}
	}
	binds := []string{
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
	}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaCatalogExportScript, binds, "error exporting pg-delta catalog", &stdout, &stderr); err != nil {
		return "", err
	}
	return strings.TrimSpace(stdout.String()), nil
}
