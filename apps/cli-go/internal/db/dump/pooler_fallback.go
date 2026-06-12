package dump

import (
	"context"
	"io"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/pkg/migration"
)

// resolvePoolerFallback resolves IPv4 transaction pooler credentials for a direct
// host that failed over IPv6. It is indirected through a variable so tests can
// stub the network call.
var resolvePoolerFallback = flags.ResolvePoolerConfigForFallback

// RunWithPoolerFallback runs a Docker-backed pg_dump style operation and, when it
// fails because the Supabase direct database host is unreachable over IPv6,
// transparently retries once through the project's IPv4 transaction pooler.
//
// This is the common failure on Docker Desktop for macOS: the host can reach the
// IPv6-only direct database, but the pg_dump container cannot, so the operation
// fails even though direct connection config was selected.
//
// The run closure receives the connection config to use and an ExecFunc that tees
// the container's stderr for failure classification. out receives the dump output
// and is reset between attempts when it supports truncation.
func RunWithPoolerFallback(
	ctx context.Context,
	config pgconn.Config,
	out io.Writer,
	dryRun bool,
	run func(ctx context.Context, config pgconn.Config, out io.Writer, exec migration.ExecFunc) error,
) error {
	if dryRun {
		return run(ctx, config, out, noExec)
	}
	var errBuf strings.Builder
	err := run(ctx, config, out, captureExec(&errBuf))
	if err == nil {
		return nil
	}
	// The container exit code hides why pg_dump failed; its stderr carries the
	// connection detail, so classify that to decide whether to retry via pooler.
	connErr := errors.New(errBuf.String())
	if poolerConfig, ok := PoolerFallbackConfig(ctx, config, connErr); ok {
		resetOutput(out)
		errBuf.Reset()
		if retryErr := run(ctx, poolerConfig, out, captureExec(&errBuf)); retryErr != nil {
			utils.SetConnectSuggestion(errors.New(errBuf.String()))
			return retryErr
		}
		return nil
	}
	// Could not auto-recover: classify the failure into an actionable suggestion.
	utils.SetConnectSuggestion(connErr)
	if utils.IsIPv6ConnectivityError(connErr) {
		// Enrich the hint with the project's actual transaction pooler URL so the
		// user gets a copy-pasteable --db-url.
		utils.SuggestIPv6Pooler(ctx, config.Host)
	}
	return err
}

// PoolerFallbackConfig decides whether a failed remote container operation should
// be retried through the project's IPv4 transaction pooler, returning the pooler
// config to retry with. It returns ok=false unless every condition holds:
//   - pooler fallback is eligible (the connection came from --linked, never an
//     explicit --db-url/--local target),
//   - the failure is an IPv6 connectivity error,
//   - the host is a direct Supabase database host (db.<ref>.supabase.co), and
//   - the pooler config resolves.
//
// classifyErr must carry the underlying connection failure text — the teed
// container stderr for pg_dump, or the returned error for the diff/declarative
// paths, which already embed their container stderr. It emits the user-facing
// fallback warning when it returns ok, so callers can simply retry with the
// returned config.
func PoolerFallbackConfig(ctx context.Context, config pgconn.Config, classifyErr error) (pgconn.Config, bool) {
	if !flags.PoolerFallbackEligible || !utils.IsIPv6ConnectivityError(classifyErr) {
		return pgconn.Config{}, false
	}
	projectRef, ok := utils.ProjectRefFromDirectDbHost(config.Host)
	if !ok {
		return pgconn.Config{}, false
	}
	poolerConfig, err := resolvePoolerFallback(ctx, projectRef)
	if err != nil {
		return pgconn.Config{}, false
	}
	utils.WarnIPv6PoolerFallback(config.Host)
	return poolerConfig, true
}

// resetOutput rewinds the dump output between retry attempts so a failed first
// attempt does not leave partial content. It handles the in-memory buffer,
// on-disk file, and stdout cases; truncation errors (e.g. on stdout) are ignored.
func resetOutput(out io.Writer) {
	switch w := out.(type) {
	case interface{ Reset() }:
		w.Reset()
	case interface {
		Truncate(int64) error
		Seek(int64, int) (int64, error)
	}:
		if err := w.Truncate(0); err == nil {
			_, _ = w.Seek(0, io.SeekStart)
		}
	}
}
