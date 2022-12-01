package list

import (
	"context"
	"fmt"
	"math"
	"os"
	"regexp"
	"strconv"
	"time"

	"github.com/charmbracelet/glamour"
	"github.com/jackc/pgx/v4"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils"
)

const LIST_MIGRATION_VERSION = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"

var initSchemaPattern = regexp.MustCompile(`([0-9]{14})_init\.sql`)

func Run(ctx context.Context, username, password, database, host string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	remoteVersions, err := loadRemoteMigrations(ctx, username, password, database, host, options...)
	if err != nil {
		return err
	}
	localVersions, err := loadLocalMigrations(fsys)
	if err != nil {
		return err
	}
	// Render table
	table := makeTable(remoteVersions, localVersions)
	r, err := glamour.NewTermRenderer(
		glamour.WithAutoStyle(),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return err
	}
	out, err := r.Render(table)
	if err != nil {
		return err
	}
	fmt.Print(out)
	return nil
}

func loadRemoteMigrations(ctx context.Context, username, password, database, host string, options ...func(*pgx.ConnConfig)) ([]string, error) {
	conn, err := utils.ConnectRemotePostgres(ctx, username, password, database, host, options...)
	if err != nil {
		return nil, err
	}
	defer conn.Close(context.Background())
	return LoadRemoteMigrations(ctx, conn)
}

func LoadRemoteMigrations(ctx context.Context, conn *pgx.Conn) ([]string, error) {
	rows, err := conn.Query(ctx, LIST_MIGRATION_VERSION)
	if err != nil {
		return nil, err
	}
	versions := []string{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return nil, err
		}
		versions = append(versions, version)
	}
	return versions, nil
}

const (
	layoutVersion = "20060102150405"
	layoutHuman   = "2006-01-02 15:04:05"
)

func formatTimestamp(version string) string {
	timestamp, err := time.Parse(layoutVersion, version)
	if err != nil {
		return version
	}
	return timestamp.Format(layoutHuman)
}

func makeTable(remoteMigrations []string, localMigrations []string) string {
	var err error
	table := "|Local|Remote|Time (UTC)|\n|-|-|-|\n"
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
			table += fmt.Sprintf("|`%s`|` `|`%s`|\n", localMigrations[j], formatTimestamp(localMigrations[j]))
			j++
		} else if remoteTimestamp < localTimestamp {
			table += fmt.Sprintf("|` `|`%s`|`%s`|\n", remoteMigrations[i], formatTimestamp(remoteMigrations[i]))
			i++
		} else {
			table += fmt.Sprintf("|`%s`|`%s`|`%s`|\n", localMigrations[j], remoteMigrations[i], formatTimestamp(remoteMigrations[i]))
			i++
			j++
		}
	}
	return table
}

func loadLocalMigrations(fsys afero.Fs) ([]string, error) {
	names, err := LoadLocalMigrations(fsys)
	if err != nil {
		return nil, err
	}
	var versions []string
	for _, filename := range names {
		// LoadLocalMigrations guarantees we always have a match
		verion := utils.MigrateFilePattern.FindStringSubmatch(filename)[1]
		versions = append(versions, verion)
	}
	return versions, nil
}

func LoadLocalMigrations(fsys afero.Fs) ([]string, error) {
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return nil, err
	}
	localMigrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
	if err != nil {
		return nil, err
	}
	var names []string
	for i, migration := range localMigrations {
		filename := migration.Name()
		if i == 0 && shouldSkip(filename) {
			fmt.Fprintln(os.Stderr, "Skipping migration "+utils.Bold(filename)+`... (replace "init" with a different file name to apply this migration)`)
			continue
		}
		matches := utils.MigrateFilePattern.FindStringSubmatch(filename)
		if len(matches) == 0 {
			fmt.Fprintln(os.Stderr, "Skipping migration "+utils.Bold(filename)+`... (file name must match pattern "<timestamp>_name.sql")`)
			continue
		}
		names = append(names, filename)
	}
	return names, nil
}

func shouldSkip(name string) bool {
	// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
	// the first migration (prev versions of the CLI) is deprecated.
	matches := initSchemaPattern.FindStringSubmatch(name)
	if len(matches) == 2 {
		if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err == nil && timestamp < 20211209000000 {
			return true
		}
	}
	return false
}
