package pull

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/declarative"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/format"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var (
	errMissing  = errors.New("No migrations found")
	errInSync   = errors.New("No schema changes found")
	errConflict = errors.Errorf("The remote database's migration history does not match local files in %s directory.", utils.MigrationsDir)
)

func Run(ctx context.Context, schema []string, config pgconn.Config, name string, usePgDelta bool, usePgDeltaDiff bool, differ diff.DiffFunc, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Check postgres connection
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// In experimental mode, allow db pull to switch from migration-file output to
	// declarative-file output through pg-delta when explicitly requested.
	if usePgDelta {
		return pullDeclarativePgDelta(ctx, schema, config, fsys, options...)
	}
	if viper.GetBool("EXPERIMENTAL") {
		var buf bytes.Buffer
		if err := dump.RunWithPoolerFallback(ctx, config, &buf, false, func(ctx context.Context, config pgconn.Config, out io.Writer, exec migration.ExecFunc) error {
			if err := migration.DumpRole(ctx, config, out, exec); err != nil {
				return err
			}
			return migration.DumpSchema(ctx, config, out, exec)
		}); err != nil {
			return err
		}
		// TODO: handle managed schemas
		return format.WriteStructuredSchemas(ctx, &buf, fsys)
	}
	// 2. Pull schema. pg-delta plans with transaction boundaries produce more than
	// one ordered migration file; migra always produces exactly one.
	base := time.Now().UTC()
	written, err := run(ctx, schema, base, name, conn, usePgDeltaDiff, differ, fsys, options...)
	if err != nil {
		return err
	}
	if len(written) == 0 {
		return errors.New(errInSync)
	}
	// 3. Insert a row to `schema_migrations` for every file written.
	versions := make([]string, len(written))
	for i, w := range written {
		fmt.Fprintln(os.Stderr, "Schema written to "+utils.Bold(w.Path))
		versions[i] = w.Version
	}
	if shouldUpdate, err := utils.NewConsole().PromptYesNo(ctx, "Update remote migration history table?", true); err != nil {
		return err
	} else if shouldUpdate {
		return repair.UpdateMigrationTable(ctx, conn, versions, repair.Applied, false, fsys)
	}
	return nil
}

// writtenMigration is a migration file produced by a pull, paired with the
// version to record in the remote migration history.
type writtenMigration struct {
	Path    string
	Version string
}

// pullDeclarativePgDelta exports remote schema into declarative SQL files by
// diffing against an empty shadow baseline with pg-delta declarative export.
//
// This path is separate from run() because it does not produce or update
// timestamped migration files.
func pullDeclarativePgDelta(ctx context.Context, schema []string, config pgconn.Config, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	fmt.Fprintln(os.Stderr, "Preparing declarative schema export using pg-delta...")
	shadowSource, err := diff.PrepareRawShadow(ctx)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadowSource.Container)
	shadowConfig := shadowSource.Source
	formatOptions := ""
	if utils.Config.Experimental.PgDelta != nil {
		formatOptions = strings.TrimSpace(utils.Config.Experimental.PgDelta.FormatOptions)
	}
	exported, err := diff.DeclarativeExportPgDelta(ctx, shadowConfig, config, schema, formatOptions, options...)
	if err != nil {
		// The pg-delta container connects to the remote (target) host; if that
		// fails over IPv6, retry through the IPv4 pooler like the dump path does.
		poolerConfig, ok := dump.PoolerFallbackConfig(ctx, config, err)
		if !ok {
			return err
		}
		if exported, err = diff.DeclarativeExportPgDelta(ctx, shadowConfig, poolerConfig, schema, formatOptions, options...); err != nil {
			return err
		}
	}
	if err := declarative.WriteDeclarativeSchemas(exported, fsys); err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Declarative schema written to "+utils.Bold(utils.GetDeclarativeDir()))
	return nil
}

func run(ctx context.Context, schema []string, base time.Time, name string, conn *pgx.Conn, usePgDeltaDiff bool, differ diff.DiffFunc, fsys afero.Fs, options ...func(*pgx.ConnConfig)) ([]writtenMigration, error) {
	config := conn.Config().Config
	timestamp := utils.GetVersionTimestamp(base)
	path := new.GetMigrationPath(timestamp, name)
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := assertRemoteInSync(ctx, conn, fsys); errors.Is(err, errMissing) {
		// pg_dump strips ownership when restored as a non-superuser, so platform
		// objects (FDWs, wasm wrappers, system-owned ACLs) leak into the migration
		// and later break `supabase db reset`. pg-delta speaks pg_catalog directly
		// and the supabase integration filter drops these by owner, so the diff
		// against an empty shadow yields a clean initial migration on its own.
		if !usePgDeltaDiff {
			// Ignore schemas flag when working on the initial pull
			if err = dumpRemoteSchema(ctx, path, config, fsys); err != nil {
				return nil, err
			}
		}
		// For the legacy path this is a second pass that captures changes
		// pg_dump cannot emit (default privileges, managed schemas). For the
		// pg-delta path this is the only pass and produces the full schema.
		written, err := diffRemoteSchema(ctx, nil, base, name, config, usePgDeltaDiff, differ, fsys, options...)
		if err = swallowInitialInSync(err, fsys, path); err != nil {
			return nil, err
		}
		// The migra initial pull seeds `path` with a pg_dump even when the follow-up
		// diff is empty and swallowed above, so record that single migration.
		if !usePgDeltaDiff && len(written) == 0 {
			written = []writtenMigration{{Path: path, Version: timestamp}}
		}
		return written, nil
	} else if err != nil {
		return nil, err
	}
	// 2. Fetch remote schema changes
	return diffRemoteSchema(ctx, schema, base, name, config, usePgDeltaDiff, differ, fsys, options...)
}

func dumpRemoteSchema(ctx context.Context, path string, config pgconn.Config, fsys afero.Fs) error {
	// Special case if this is the first migration
	fmt.Fprintln(os.Stderr, "Dumping schema from remote database...")
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open dump file: %w", err)
	}
	defer f.Close()
	return dump.RunWithPoolerFallback(ctx, config, f, false, func(ctx context.Context, config pgconn.Config, out io.Writer, exec migration.ExecFunc) error {
		return migration.DumpSchema(ctx, config, out, exec)
	})
}

func diffRemoteSchema(ctx context.Context, schema []string, base time.Time, name string, config pgconn.Config, usePgDeltaDiff bool, differ diff.DiffFunc, fsys afero.Fs, options ...func(*pgx.ConnConfig)) ([]writtenMigration, error) {
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	result, err := diff.DiffDatabase(ctx, schema, config, os.Stderr, fsys, differ, usePgDeltaDiff, options...)
	if err != nil {
		// The diff runs the remote (source) host inside a container; if that
		// fails over IPv6, retry through the IPv4 pooler like the dump path does
		// so the whole db pull workflow is self-healing, not just the dump pass.
		poolerConfig, ok := dump.PoolerFallbackConfig(ctx, config, err)
		if !ok {
			return nil, err
		}
		if result, err = diff.DiffDatabase(ctx, schema, poolerConfig, os.Stderr, fsys, differ, usePgDeltaDiff, options...); err != nil {
			return nil, err
		}
	}
	// pg-delta path: one migration file per execution-aware plan unit.
	if usePgDeltaDiff {
		if len(result.Files) == 0 {
			if diff.IsPgDeltaDebugEnabled() {
				if debugDir, debugErr := saveEmptyPgDeltaPullDebug(ctx, config, result.Debug, fsys, options...); debugErr != nil {
					fmt.Fprintf(os.Stderr, "Warning: failed to save pg-delta debug bundle: %v\n", debugErr)
				} else if len(debugDir) > 0 {
					return nil, errors.Errorf("%w (debug bundle: %s)", errInSync, debugDir)
				}
			}
			return nil, errors.New(errInSync)
		}
		return writePgDeltaMigrations(result.Files, base, name, fsys)
	}
	// migra path: a single migration file, appended when seeded by dumpRemoteSchema.
	output := result.SQL
	if trimmed := strings.TrimSpace(output); len(trimmed) == 0 {
		return nil, errors.New(errInSync)
	}
	timestamp := utils.GetVersionTimestamp(base)
	path := new.GetMigrationPath(timestamp, name)
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return nil, err
	}
	// Append to existing migration file when we run this after dumpRemoteSchema;
	// for a non-initial pull this creates the file fresh.
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return nil, errors.Errorf("failed to open migration file: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(output); err != nil {
		return nil, errors.Errorf("failed to write migration file: %w", err)
	}
	return []writtenMigration{{Path: path, Version: timestamp}}, nil
}

// writePgDeltaMigrations writes one ordered migration file per plan unit. A
// single-unit plan (the common case) keeps the exact `<ts>_<name>.sql` filename;
// multi-unit plans append the unit name and give each file a strictly increasing
// timestamp (real time arithmetic on the base, never string increment) so their
// execution order and migration-history order stay stable.
func writePgDeltaMigrations(files []diff.PgDeltaPlanFile, base time.Time, name string, fsys afero.Fs) ([]writtenMigration, error) {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return nil, err
	}
	single := len(files) == 1
	written := make([]writtenMigration, 0, len(files))
	for i, file := range files {
		version := utils.GetVersionTimestamp(base.Add(time.Duration(i) * time.Second))
		fileName := name
		if !single {
			fileName = name + "_" + file.Name
		}
		path := new.GetMigrationPath(version, fileName)
		f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
		if err != nil {
			return nil, errors.Errorf("failed to open migration file: %w", err)
		}
		if _, err := f.WriteString(file.SQL + "\n"); err != nil {
			f.Close()
			return nil, errors.Errorf("failed to write migration file: %w", err)
		}
		f.Close()
		written = append(written, writtenMigration{Path: path, Version: version})
	}
	return written, nil
}

func assertRemoteInSync(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	remoteMigrations, err := migration.ListRemoteMigrations(ctx, conn)
	if err != nil {
		return err
	}
	localMigrations, err := list.LoadLocalVersions(fsys)
	if err != nil {
		return err
	}
	// Find any mismatch between local and remote migrations
	var extraRemote, extraLocal []string
	for i, j := 0, 0; i < len(remoteMigrations) || j < len(localMigrations); {
		remoteTimestamp := math.MaxInt
		if i < len(remoteMigrations) {
			if remoteTimestamp, err = strconv.Atoi(remoteMigrations[i]); err != nil {
				i++
				continue
			}
		}
		localTimestamp := math.MaxInt
		if j < len(localMigrations) {
			if localTimestamp, err = strconv.Atoi(localMigrations[j]); err != nil {
				j++
				continue
			}
		}
		// Top to bottom chronological order
		if localTimestamp < remoteTimestamp {
			extraLocal = append(extraLocal, localMigrations[j])
			j++
		} else if remoteTimestamp < localTimestamp {
			extraRemote = append(extraRemote, remoteMigrations[i])
			i++
		} else {
			i++
			j++
		}
	}
	// Suggest delete local migrations / reset migration history
	if len(extraRemote)+len(extraLocal) > 0 {
		utils.CmdSuggestion = suggestMigrationRepair(extraRemote, extraLocal)
		return errors.New(errConflict)
	}
	if len(localMigrations) == 0 {
		return errors.New(errMissing)
	}
	return nil
}

func hasMigrationContent(fsys afero.Fs, path string) bool {
	info, err := fsys.Stat(path)
	return err == nil && info.Size() > 0
}

func swallowInitialInSync(err error, fsys afero.Fs, path string) error {
	if errors.Is(err, errInSync) && hasMigrationContent(fsys, path) {
		return nil
	}
	return err
}

func ensureMigrationWritten(fsys afero.Fs, path string) error {
	if hasMigrationContent(fsys, path) {
		return nil
	}
	return errors.New(errInSync)
}

func suggestMigrationRepair(extraRemote, extraLocal []string) string {
	result := fmt.Sprintln("\nMake sure your local git repo is up-to-date. If the error persists, try repairing the migration history table:")
	for _, version := range extraRemote {
		result += fmt.Sprintln(utils.Bold("supabase migration repair --status reverted " + version))
	}
	for _, version := range extraLocal {
		result += fmt.Sprintln(utils.Bold("supabase migration repair --status applied " + version))
	}
	return result
}
