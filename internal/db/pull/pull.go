package pull

import (
	"context"
	_ "embed"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var (
	errMissing       = errors.New("No migrations found")
	errInSync        = errors.New("No schema changes found")
	errConflict      = errors.Errorf("The remote database's migration history does not match local files in %s directory.", utils.MigrationsDir)
	suggestExtraPull = fmt.Sprintf(
		"The %s and %s schemas are excluded. Run %s again to diff them.",
		utils.Bold("auth"),
		utils.Bold("storage"),
		utils.Aqua("supabase db pull --schema auth,storage"),
	)
)

func Run(ctx context.Context, schema []string, config pgconn.Config, name string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Check postgres connection
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	// 2. Pull schema
	timestamp := utils.GetCurrentTimestamp()
	path := new.GetMigrationPath(timestamp, name)
	if err := utils.RunProgram(ctx, func(p utils.Program, ctx context.Context) error {
		return run(p, ctx, schema, path, conn, fsys)
	}); err != nil {
		return err
	}
	// 3. Insert a row to `schema_migrations`
	fmt.Fprintln(os.Stderr, "Schema written to "+utils.Bold(path))
	if shouldUpdate, err := utils.NewConsole().PromptYesNo(ctx, "Update remote migration history table?", true); err != nil {
		return err
	} else if shouldUpdate {
		return repair.UpdateMigrationTable(ctx, conn, []string{timestamp}, repair.Applied, false, fsys)
	}
	return nil
}

func run(p utils.Program, ctx context.Context, schema []string, path string, conn *pgx.Conn, fsys afero.Fs) error {
	config := conn.Config().Config
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := assertRemoteInSync(ctx, conn, fsys); errors.Is(err, errMissing) {
		// Not passing down schemas to avoid pulling in managed schemas
		if err = dumpRemoteSchema(p, ctx, path, config, fsys); err == nil {
			utils.CmdSuggestion = suggestExtraPull
		}
		return err
	} else if err != nil {
		return err
	}
	// 2. Fetch remote schema changes
	defaultSchema := len(schema) == 0
	if defaultSchema {
		var err error
		schema, err = migration.ListUserSchemas(ctx, conn)
		if err != nil {
			return err
		}
	}
	err := diffRemoteSchema(p, ctx, schema, path, config, fsys)
	if defaultSchema && (err == nil || errors.Is(err, errInSync)) {
		utils.CmdSuggestion = suggestExtraPull
	}
	return err
}

func dumpRemoteSchema(p utils.Program, ctx context.Context, path string, config pgconn.Config, fsys afero.Fs) error {
	// Special case if this is the first migration
	p.Send(utils.StatusMsg("Dumping schema from remote database..."))
	if err := utils.MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0644)
	if err != nil {
		return errors.Errorf("failed to open dump file: %w", err)
	}
	defer f.Close()
	return migration.DumpSchema(ctx, config, f, dump.DockerExec)
}

func diffRemoteSchema(p utils.Program, ctx context.Context, schema []string, path string, config pgconn.Config, fsys afero.Fs) error {
	w := utils.StatusWriter{Program: p}
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	output, err := diff.DiffDatabase(ctx, schema, config, w, fsys, diff.DiffSchemaMigra)
	if err != nil {
		return err
	}
	if len(output) == 0 {
		return errors.New(errInSync)
	}
	if err := utils.WriteFile(path, []byte(output), fsys); err != nil {
		return errors.Errorf("failed to write dump file: %w", err)
	}
	return nil
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
