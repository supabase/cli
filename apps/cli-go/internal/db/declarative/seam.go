package declarative

import (
	"context"

	"github.com/go-errors/errors"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
)

// ExportModeCatalog produces (and caches under supabase/.temp/pgdelta/) the
// pg-delta catalog for the given mode and returns its on-disk path.
//
// It is the seam consumed by the native-TypeScript `db schema declarative`
// commands: they own orchestration, the pg-delta diff/export, file writes, and
// prompts, but delegate the shadow-database platform-baseline provisioning
// (start.SetupDatabase, which runs the auth/storage/realtime service migrations)
// to this Go path, which is not yet ported.
//
//   - "baseline":    platform baseline only (no user migrations) — the generate source.
//   - "migrations":  platform baseline + local migrations applied — the sync source.
//   - "declarative": platform baseline + declarative files applied — the sync target.
func ExportModeCatalog(ctx context.Context, mode string, noCache bool, fsys afero.Fs, options ...func(*pgx.ConnConfig)) (string, error) {
	switch mode {
	case "migrations":
		return getMigrationsCatalogRef(ctx, noCache, fsys, "local", options...)
	case "declarative":
		return getDeclarativeCatalogRef(ctx, noCache, fsys, options...)
	case "baseline":
		ref, err := getGenerateBaselineCatalogRef(ctx, noCache, fsys, options...)
		if err != nil {
			return "", err
		}
		if ref.shadow != nil {
			ref.shadow.cleanup()
		}
		return ref.ref, nil
	default:
		return "", errors.Errorf("unknown catalog mode: %s", mode)
	}
}
