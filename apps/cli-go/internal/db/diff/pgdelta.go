package diff

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/gen/types"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/config"
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
// /workspace). Postgres URLs and empty strings pass through unchanged. Path
// separators are normalised to forward slashes so Windows paths (with `\`)
// resolve correctly inside the Linux container.
func containerRef(ref string) string {
	if ref == "" || isPostgresURL(ref) {
		return ref
	}
	return "/workspace/" + filepath.ToSlash(ref)
}

// pgDeltaFormatOptions returns the experimental.pgdelta.format_options config for
// use when invoking pg-delta scripts that produce SQL output.
func pgDeltaFormatOptions() string {
	if utils.Config.Experimental.PgDelta == nil {
		return ""
	}
	return strings.TrimSpace(utils.Config.Experimental.PgDelta.FormatOptions)
}

func appendPgDeltaPostgresEnv(
	ctx context.Context,
	env []string,
	name string,
	ref string,
	sslRootCertEnv string,
	options ...func(*pgx.ConnConfig),
) (string, []string, error) {
	preparedRef, sslEnv, err := types.PreparePgDeltaPostgresRef(ctx, ref, sslRootCertEnv, options...)
	if err != nil {
		return "", nil, err
	}
	env = append(env, name+"="+containerRef(preparedRef))
	return preparedRef, append(env, sslEnv...), nil
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
	result, err := DiffPgDeltaRefDetailed(ctx, sourceRef, targetRef, schema, formatOptions, options...)
	if err != nil {
		return "", err
	}
	return result.SQL, nil
}

// DiffPgDeltaRefDetailed is like DiffPgDeltaRef but also returns edge-runtime stderr.
func DiffPgDeltaRefDetailed(ctx context.Context, sourceRef, targetRef string, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (PgDeltaDiffResult, error) {
	var env []string
	var err error
	targetRef, env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
	if err != nil {
		return PgDeltaDiffResult{}, err
	}
	if len(sourceRef) > 0 {
		sourceRef, env, err = appendPgDeltaPostgresEnv(ctx, env, "SOURCE", sourceRef, types.PgDeltaSourceSSLRootCert, options...)
		if err != nil {
			return PgDeltaDiffResult{}, err
		}
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	if len(strings.TrimSpace(formatOptions)) > 0 {
		env = append(env, "FORMAT_OPTIONS="+formatOptions)
	}
	if IsPgDeltaDebugEnabled() {
		env = append(env, "PGDELTA_DEBUG=1")
	}
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	script := config.InterpolatePgDeltaScript(config.Config(&utils.Config), pgDeltaScript)
	if err := utils.RunEdgeRuntimeScript(ctx, env, script, binds, "error diffing schema", &stdout, &stderr, utils.PgDeltaNpmRegistryOption()); err != nil {
		return PgDeltaDiffResult{}, err
	}
	return PgDeltaDiffResult{
		SQL:    stdout.String(),
		Stderr: stderr.String(),
	}, nil
}

// exportCatalogPgDelta is overridden in tests to mock catalog export.
var exportCatalogPgDelta = ExportCatalogPgDelta

// DeclarativeExportPgDelta exports target schema as declarative file payloads
// while keeping a config-based API for existing call sites.
func DeclarativeExportPgDelta(ctx context.Context, source, target pgconn.Config, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (DeclarativeOutput, error) {
	return DeclarativeExportPgDeltaRef(ctx, utils.ToPostgresURL(source), utils.ToPostgresURL(target), schema, formatOptions, options...)
}

// DeclarativeExportPgDeltaRef exports declarative file payloads using either
// live URLs or catalog references as source/target inputs.
func DeclarativeExportPgDeltaRef(ctx context.Context, sourceRef, targetRef string, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (DeclarativeOutput, error) {
	var env []string
	var err error
	targetRef, env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
	if err != nil {
		return DeclarativeOutput{}, err
	}
	if len(sourceRef) > 0 {
		sourceRef, env, err = appendPgDeltaPostgresEnv(ctx, env, "SOURCE", sourceRef, types.PgDeltaSourceSSLRootCert, options...)
		if err != nil {
			return DeclarativeOutput{}, err
		}
	}
	if len(schema) > 0 {
		env = append(env, "INCLUDED_SCHEMAS="+strings.Join(schema, ","))
	}
	if len(strings.TrimSpace(formatOptions)) > 0 {
		env = append(env, "FORMAT_OPTIONS="+formatOptions)
	}
	if IsPgDeltaDebugEnabled() {
		env = append(env, "PGDELTA_DEBUG=1")
	}
	binds := []string{utils.EdgeRuntimeId + ":/root/.cache/deno:rw"}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	script := config.InterpolatePgDeltaScript(config.Config(&utils.Config), pgDeltaDeclarativeExportScript)
	if err := utils.RunEdgeRuntimeScript(ctx, env, script, binds, "error exporting declarative schema", &stdout, &stderr, utils.PgDeltaNpmRegistryOption()); err != nil {
		return DeclarativeOutput{}, err
	}
	if stdout.Len() == 0 {
		return DeclarativeOutput{}, errors.Errorf("error exporting declarative schema: edge-runtime script produced no output:\n%s", stderr.String())
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
	var env []string
	var err error
	targetRef, env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
	if err != nil {
		return "", err
	}
	if len(role) > 0 {
		env = append(env, "ROLE="+role)
	}
	binds := []string{
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
	}
	if cwd, err := os.Getwd(); err == nil {
		binds = append(binds, cwd+":/workspace")
	}
	var stdout, stderr bytes.Buffer
	script := config.InterpolatePgDeltaScript(config.Config(&utils.Config), pgDeltaCatalogExportScript)
	if err := utils.RunEdgeRuntimeScript(ctx, env, script, binds, "error exporting pg-delta catalog", &stdout, &stderr, utils.PgDeltaNpmRegistryOption()); err != nil {
		return "", err
	}
	snapshot := strings.TrimSpace(stdout.String())
	if len(snapshot) == 0 {
		return "", errors.Errorf("error exporting pg-delta catalog: edge-runtime script produced no output:\n%s", stderr.String())
	}
	return snapshot, nil
}
