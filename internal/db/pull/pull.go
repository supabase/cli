package pull

import (
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
	"github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/db/dump"
	"github.com/supabase/cli/internal/db/start"
	"github.com/supabase/cli/internal/migration/list"
	"github.com/supabase/cli/internal/migration/new"
	"github.com/supabase/cli/internal/migration/repair"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/migration"
)

var (
	errMissing     = errors.New("No migrations found")
	errInSync      = errors.New("No schema changes found")
	errConflict    = errors.Errorf("The remote database's migration history does not match local files in %s directory.", utils.MigrationsDir)
	managedSchemas = []string{"auth", "storage", "realtime"}
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
		return CloneRemoteSchema(ctx, path, config, fsys)
	} else if err != nil {
		return err
	}
	// 2. Fetch user defined schemas
	if len(schema) == 0 {
		var err error
		if schema, err = migration.ListUserSchemas(ctx, conn); err != nil {
			return err
		}
		schema = append(schema, managedSchemas...)
	}
	// 3. Fetch remote schema changes
	return diffUserSchemas(ctx, schema, path, config, fsys)
}

func CloneRemoteSchema(ctx context.Context, path string, config pgconn.Config, fsys afero.Fs) error {
	// Ignore schemas flag when working on the initial pull
	if err := dumpRemoteSchema(ctx, path, config, fsys); err != nil {
		return err
	}
	// Pull changes in managed schemas automatically
	if err := diffRemoteSchema(ctx, managedSchemas, path, config, fsys); err != nil && !errors.Is(err, errInSync) {
		return err
	}
	return nil
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
	if len(output) == 0 {
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

func diffUserSchemas(ctx context.Context, schema []string, path string, config pgconn.Config, fsys afero.Fs) error {
	var managed, user []string
	for _, s := range schema {
		if utils.SliceContains(managedSchemas, s) {
			managed = append(managed, s)
		} else {
			user = append(user, s)
		}
	}
	fmt.Fprintln(os.Stderr, "Creating shadow database...")
	shadow, err := diff.CreateShadowDatabase(ctx, utils.Config.Db.ShadowPort)
	if err != nil {
		return err
	}
	defer utils.DockerRemove(shadow)
	if err := start.WaitForHealthyService(ctx, start.HealthTimeout, shadow); err != nil {
		return err
	}
	if err := diff.MigrateShadowDatabase(ctx, shadow, fsys); err != nil {
		return err
	}
	shadowConfig := pgconn.Config{
		Host:     utils.Config.Hostname,
		Port:     utils.Config.Db.ShadowPort,
		User:     "postgres",
		Password: utils.Config.Db.Password,
		Database: "postgres",
	}
	// Diff managed and user defined schemas separately
	var output string
	if len(user) > 0 {
		fmt.Fprintln(os.Stderr, "Diffing schemas:", strings.Join(user, ","))
		if output, err = diff.DiffSchemaMigraBash(ctx, shadowConfig, config, user); err != nil {
			return err
		}
	}
	if len(managed) > 0 {
		fmt.Fprintln(os.Stderr, "Diffing schemas:", strings.Join(managed, ","))
		if result, err := diff.DiffSchemaMigra(ctx, shadowConfig, config, managed); err != nil {
			return err
		} else {
			output += result
		}
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
