package pgdelta

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

//go:embed templates/pgdelta_declarative_apply.ts
var pgDeltaDeclarativeApplyScript string

// ApplyResult models the JSON payload emitted by pgdelta_declarative_apply.ts.
//
// The fields are surfaced to provide concise CLI feedback after apply runs.
type ApplyResult struct {
	Status          string `json:"status"`
	TotalStatements int    `json:"totalStatements"`
	TotalRounds     int    `json:"totalRounds"`
	TotalApplied    int    `json:"totalApplied"`
	TotalSkipped    int    `json:"totalSkipped"`
}

// ApplyDeclarative applies files from supabase/declarative to the target
// database using pg-delta's declarative apply engine.
//
// This is intentionally separate from migration apply so declarative workflows
// can evolve independently from timestamped migration execution.
func ApplyDeclarative(ctx context.Context, config pgconn.Config, fsys afero.Fs) error {
	declarativeDir := utils.DeclarativeDir
	if _, err := fsys.Stat(declarativeDir); err != nil {
		return errors.Errorf("declarative schema directory not found: %s", declarativeDir)
	}
	absDir, err := filepath.Abs(declarativeDir)
	if err != nil {
		return errors.Errorf("failed to resolve declarative dir: %w", err)
	}

	const containerSchemaPath = "/declarative"
	env := []string{
		"SCHEMA_PATH=" + containerSchemaPath,
		"TARGET=" + utils.ToPostgresURL(config),
	}
	binds := []string{
		utils.EdgeRuntimeId + ":/root/.cache/deno:rw",
		absDir + ":" + containerSchemaPath + ":ro",
	}

	fmt.Fprintln(os.Stderr, "Applying declarative schemas via pg-delta...")
	var stdout, stderr bytes.Buffer
	if err := utils.RunEdgeRuntimeScript(ctx, env, pgDeltaDeclarativeApplyScript, binds, "error running pg-delta script", &stdout, &stderr); err != nil {
		return err
	}

	var result ApplyResult
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		return errors.Errorf("failed to parse pg-delta apply output: %w\nstdout: %s", err, stdout.String())
	}
	if result.Status != "success" {
		return errors.Errorf("pg-delta declarative apply failed with status: %s", result.Status)
	}
	fmt.Fprintf(os.Stderr, "Applied %d statements in %d round(s).\n", result.TotalApplied, result.TotalRounds)
	return nil
}

