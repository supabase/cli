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

type PgDeltaTransactionMode string

const (
	PgDeltaTransactionModeTransactional PgDeltaTransactionMode = "transactional"
	PgDeltaTransactionModeNone          PgDeltaTransactionMode = "none"
)

func (m PgDeltaTransactionMode) validate() error {
	switch m {
	case PgDeltaTransactionModeTransactional, PgDeltaTransactionModeNone:
		return nil
	default:
		return errors.Errorf("unknown pg-delta transaction mode %q", m)
	}
}

// PgDeltaPlanFile is one execution-aware migration unit rendered by pg-delta's
// renderPlanFiles: a numbered SQL file whose header comments record the unit
// number, transaction mode and boundary reason.
type PgDeltaPlanFile struct {
	Order           int                    `json:"order"`
	Name            string                 `json:"name"`
	TransactionMode PgDeltaTransactionMode `json:"transactionMode"`
	SQL             string                 `json:"sql"`
}

// PgDeltaDiffOutput is the top-level diff envelope emitted by templates/pgdelta.ts.
type PgDeltaDiffOutput struct {
	Version int               `json:"version"`
	Files   []PgDeltaPlanFile `json:"files"`
}

// joinPgDeltaFiles flattens the per-unit files back into a single SQL string for
// callers (db diff, declarative sync) that consume one blob. The per-unit header
// comments keep the transaction boundaries visible in the reviewed output; empty
// files produce an empty string, preserving "no changes" detection.
func joinPgDeltaFiles(files []PgDeltaPlanFile) string {
	blocks := make([]string, len(files))
	for i, file := range files {
		blocks[i] = file.SQL
	}
	return strings.Join(blocks, "\n\n")
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
) ([]string, error) {
	preparedRef, sslEnv, err := types.PreparePgDeltaPostgresRef(ctx, ref, sslRootCertEnv, options...)
	if err != nil {
		return nil, err
	}
	env = append(env, name+"="+containerRef(preparedRef))
	return append(env, sslEnv...), nil
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
	return joinPgDeltaFiles(result.Files), nil
}

// DiffPgDeltaRefDetailed is like DiffPgDeltaRef but also returns edge-runtime stderr.
func DiffPgDeltaRefDetailed(ctx context.Context, sourceRef, targetRef string, schema []string, formatOptions string, options ...func(*pgx.ConnConfig)) (PgDeltaDiffResult, error) {
	var env []string
	var err error
	env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
	if err != nil {
		return PgDeltaDiffResult{}, err
	}
	if len(sourceRef) > 0 {
		env, err = appendPgDeltaPostgresEnv(ctx, env, "SOURCE", sourceRef, types.PgDeltaSourceSSLRootCert, options...)
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
	return parsePgDeltaDiffOutput(stdout.String(), stderr.String())
}

// parsePgDeltaDiffOutput turns the pg-delta diff script's stdout envelope into a
// result. The template always prints the envelope on the success path, even for
// an empty plan (`{"version":1,"files":[]}`); a truly empty stdout means no
// envelope was produced, which we surface as "no changes" (empty Files) rather
// than an error. Non-empty stdout that is not valid envelope JSON is a parse
// error carrying the edge-runtime stderr for diagnosis.
func parsePgDeltaDiffOutput(stdout, stderr string) (PgDeltaDiffResult, error) {
	result := PgDeltaDiffResult{Stderr: stderr}
	if len(strings.TrimSpace(stdout)) == 0 {
		return result, nil
	}
	var envelope PgDeltaDiffOutput
	if err := json.Unmarshal([]byte(stdout), &envelope); err != nil {
		return PgDeltaDiffResult{}, errors.Errorf("failed to parse pg-delta diff output: %w:\n%s", err, stderr)
	}
	for _, file := range envelope.Files {
		if err := file.TransactionMode.validate(); err != nil {
			return PgDeltaDiffResult{}, err
		}
	}
	result.Files = envelope.Files
	return result, nil
}

// exportCatalogPgDelta is overridden in tests to mock catalog export.
var exportCatalogPgDelta = ExportCatalogPgDelta

// diffPgDeltaRefDetailed is the seam DiffDatabase uses for the pg-delta engine.
// Tests override it to stub the real edge-runtime pipeline (which the injected
// DiffFunc differ cannot, since pg-delta bypasses differ), the same pattern as
// exportCatalogPgDelta above.
var diffPgDeltaRefDetailed = DiffPgDeltaRefDetailed

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
	env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
	if err != nil {
		return DeclarativeOutput{}, err
	}
	if len(sourceRef) > 0 {
		env, err = appendPgDeltaPostgresEnv(ctx, env, "SOURCE", sourceRef, types.PgDeltaSourceSSLRootCert, options...)
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
	env, err = appendPgDeltaPostgresEnv(ctx, env, "TARGET", targetRef, types.PgDeltaTargetSSLRootCert, options...)
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
