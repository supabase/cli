package pull

import (
	"bytes"
	"context"
	_ "embed"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/go-errors/errors"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
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

func Run(ctx context.Context, schema []string, config pgconn.Config, name string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 1. Check postgres connection
	conn, err := utils.ConnectByConfig(ctx, config, options...)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())
	if viper.GetBool("EXPERIMENTAL") {
		var buf bytes.Buffer
		if err := migration.DumpRole(ctx, config, &buf, dump.DockerExec); err != nil {
			return err
		}
		if err := migration.DumpSchema(ctx, config, &buf, dump.DockerExec); err != nil {
			return err
		}
		// TODO: handle managed schemas
		return format.WriteStructuredSchemas(ctx, &buf, fsys)
	}
	// 2. Pull schema
	timestamp := utils.GetCurrentTimestamp()
	path := new.GetMigrationPath(timestamp, name)
	if err := run(ctx, schema, path, conn, fsys); err != nil {
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

func run(ctx context.Context, schema []string, path string, conn *pgx.Conn, fsys afero.Fs) error {
	config := conn.Config().Config
	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := assertRemoteInSync(ctx, conn, fsys); errors.Is(err, errMissing) {
		// Ignore schemas flag when working on the initial pull
		if err = dumpRemoteSchema(ctx, path, config, fsys); err != nil {
			return err
		}
		// Run a second pass to pull in changes from default privileges and managed schemas
		if err = diffRemoteSchema(ctx, nil, path, config, fsys); errors.Is(err, errInSync) {
			err = nil
		}
		return err
	} else if err != nil {
		return err
	}
	// 2. Fetch remote schema changes
	return diffRemoteSchema(ctx, schema, path, config, fsys)
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
	return migration.DumpSchema(ctx, config, f, dump.DockerExec)
}

func diffRemoteSchema(ctx context.Context, schema []string, path string, config pgconn.Config, fsys afero.Fs) error {
	// Diff remote db (source) & shadow db (target) and write it as a new migration.
	output, err := diff.DiffDatabase(ctx, schema, config, os.Stderr, fsys, diff.DiffSchemaMigra)
	if err != nil {
		return err
	}
	if trimmed := strings.TrimSpace(output); len(trimmed) == 0 {
		return errors.New(errInSync)
	}
	// Append to existing migration file since we run this after dump
	f, err := fsys.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0644)
	if err != nil {
		return errors.Errorf("failed to open migration file: %w", err)
	}
	defer f.Close()
	if _, err := f.WriteString(output); err != nil {
		return errors.Errorf("failed to write migration file: %w", err)
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
