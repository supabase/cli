package pull

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/declarative"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/utils"
)

var exportCatalogPgDelta = diff.ExportCatalogPgDelta

func saveEmptyPgDeltaPullDebug(
	ctx context.Context,
	config pgconn.Config,
	capture *diff.PgDeltaDebugCapture,
	fsys afero.Fs,
	options ...func(*pgx.ConnConfig),
) (string, error) {
	if capture == nil {
		capture = &diff.PgDeltaDebugCapture{}
	}
	targetCatalog, err := exportCatalogPgDelta(ctx, utils.ToPostgresURL(config), "postgres", options...)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Warning: failed to export remote pg-delta catalog: %v\n", err)
	}
	bundle := declarative.DebugBundle{
		SourceCatalog:  capture.SourceCatalog,
		TargetCatalog:  targetCatalog,
		PgDeltaStderr:  capture.Stderr,
		ConnectionInfo: formatConnectionInfo(config),
		Error:          errors.New(errInSync),
	}
	debugDir, err := declarative.SaveDebugBundle(bundle, fsys)
	if err != nil {
		return "", err
	}
	printEmptyPgDeltaPullSummary(debugDir, capture.SourceCatalog, targetCatalog)
	declarative.PrintDebugBundleMessage(debugDir)
	return debugDir, nil
}

func printEmptyPgDeltaPullSummary(debugDir, sourceCatalog, targetCatalog string) {
	fmt.Fprintln(os.Stderr, "pg-delta returned 0 statements.")
	fmt.Fprintln(os.Stderr, "Debug bundle saved to "+utils.Bold(debugDir))
	if len(strings.TrimSpace(sourceCatalog)) > 0 {
		fmt.Fprintln(os.Stderr, formatCatalogSummary("Shadow", diff.SummarizeCatalogJSON(sourceCatalog))+
			fmt.Sprintf(" (%s)", formatByteSize(len(sourceCatalog))))
	}
	if len(strings.TrimSpace(targetCatalog)) > 0 {
		fmt.Fprintln(os.Stderr, formatCatalogSummary("Remote", diff.SummarizeCatalogJSON(targetCatalog))+
			fmt.Sprintf(" (%s)", formatByteSize(len(targetCatalog))))
	} else {
		fmt.Fprintln(os.Stderr, "Remote catalog: export failed or empty (inspect connection.txt and pgdelta-stderr.txt)")
	}
}

func formatConnectionInfo(config pgconn.Config) string {
	return fmt.Sprintf(
		"host=%s port=%d user=%s database=%s url=%s",
		config.Host,
		config.Port,
		config.User,
		config.Database,
		redactPostgresURL(utils.ToPostgresURL(config)),
	)
}

func redactPostgresURL(raw string) string {
	parsed, err := url.Parse(raw)
	if err != nil {
		return "<invalid-url>"
	}
	if parsed.User != nil {
		username := parsed.User.Username()
		if username == "" {
			parsed.User = url.UserPassword("redacted", "xxxxx")
		} else {
			parsed.User = url.UserPassword(username, "xxxxx")
		}
	}
	return parsed.String()
}

func formatCatalogSummary(label string, summary diff.CatalogSummary) string {
	if summary.TotalObjects == 0 {
		return label + " catalog: no objects detected"
	}
	parts := make([]string, 0, len(summary.BySchema))
	for schema, count := range summary.BySchema {
		parts = append(parts, fmt.Sprintf("%s=%d", schema, count))
	}
	return fmt.Sprintf("%s catalog: %d objects (%s)", label, summary.TotalObjects, strings.Join(parts, ", "))
}

func formatByteSize(size int) string {
	switch {
	case size >= 1<<20:
		return fmt.Sprintf("%.1f MB", float64(size)/(1<<20))
	case size >= 1<<10:
		return fmt.Sprintf("%.1f KB", float64(size)/(1<<10))
	default:
		return fmt.Sprintf("%d B", size)
	}
}
