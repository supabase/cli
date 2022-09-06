package commit

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/jackc/pgx/v4"
	"github.com/muesli/reflow/wrap"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	differ "github.com/supabase/cli/internal/db/diff"
	"github.com/supabase/cli/internal/debug"
	"github.com/supabase/cli/internal/utils"
)

const (
	CHECK_MIGRATION_EXISTS = "SELECT 1 FROM supabase_migrations.schema_migrations LIMIT 1"
	LIST_MIGRATION_VERSION = "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"
	CREATE_MIGRATION_TABLE = `CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
`
	INSERT_MIGRATION_VERSION = "INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1)"
)

var (
	//go:embed templates/dump_initial_migration.sh
	dumpInitialMigrationScript string
)

func Run(ctx context.Context, username, password, database string, fsys afero.Fs) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
		if err := utils.LoadConfigFS(fsys); err != nil {
			return err
		}
	}

	ctx, cancel := context.WithCancel(ctx)
	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := utils.NewProgram(model{cancel: cancel, spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, ctx, username, password, database, fsys)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted " + utils.Aqua("supabase db remote commit") + ".")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println("Finished " + utils.Aqua("supabase db remote commit") + `.
WARNING: The diff tool is not foolproof, so you may need to manually rearrange and modify the generated migration.
Run ` + utils.Aqua("supabase db reset") + ` to verify that the new migration does not generate errors.`)
	return nil
}

const (
	netId    = "supabase_db_remote_commit_network"
	dbId     = "supabase_db_remote_commit_db"
	differId = "supabase_db_remote_commit_differ"
)

func run(p utils.Program, ctx context.Context, username, password, database string, fsys afero.Fs) error {
	projectRef, err := utils.LoadProjectRef(fsys)
	if err != nil {
		return err
	}
	conn, err := ConnectRemotePostgres(ctx, username, password, database, projectRef)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	_, _ = utils.Docker.NetworkCreate(
		ctx,
		netId,
		types.NetworkCreate{
			CheckDuplicate: true,
			Labels: map[string]string{
				"com.supabase.cli.project":   utils.Config.ProjectId,
				"com.docker.compose.project": utils.Config.ProjectId,
			},
		},
	)
	defer utils.DockerRemoveAll(context.Background(), netId)

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		dbImage := utils.GetRegistryImageUrl(utils.DbImage)
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, dbImage); err != nil {
			out, err := utils.Docker.ImagePull(ctx, dbImage, types.ImagePullOptions{})
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		diffImage := utils.GetRegistryImageUrl(utils.DifferImage)
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, diffImage); err != nil {
			out, err := utils.Docker.ImagePull(ctx, diffImage, types.ImagePullOptions{})
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
	}

	// 1. Assert `supabase/migrations` and `schema_migrations` are in sync.
	if err := AssertRemoteInSync(ctx, conn, fsys); err != nil {
		return err
	}

	timestamp := utils.GetCurrentTimestamp()

	// 2. Special case if this is the first migration
	{
		localMigrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
		if err != nil {
			return err
		}

		if len(localMigrations) == 0 {
			// Use pg_dump instead of schema diff
			out, err := utils.DockerRun(
				ctx,
				dbId,
				&container.Config{
					Image: utils.GetRegistryImageUrl(utils.DbImage),
					Env: []string{
						"POSTGRES_PASSWORD=postgres",
						"EXCLUDED_SCHEMAS=" + strings.Join(utils.InternalSchemas, "|"),
						"DB_URL=" + conn.Config().ConnString(),
					},
					Entrypoint: []string{
						"bash", "-c", dumpInitialMigrationScript,
					},
					Labels: map[string]string{
						"com.supabase.cli.project":   utils.Config.ProjectId,
						"com.docker.compose.project": utils.Config.ProjectId,
					},
				},
				&container.HostConfig{NetworkMode: netId},
			)
			if err != nil {
				return err
			}

			var dumpBuf, errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(&dumpBuf, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error running pg_dump on remote database: " + errBuf.String())
			}

			// Insert a row to `schema_migrations`
			if _, err := conn.Query(ctx, INSERT_MIGRATION_VERSION, timestamp); err != nil {
				return err
			}

			if err := differ.SaveDiff(dumpBuf.String(), "remote_commit", fsys); err != nil {
				return err
			}

			return nil
		}
	}

	// 3. Create shadow db and run migrations.
	p.Send(utils.StatusMsg("Creating shadow database..."))
	{
		cmd := []string{}
		if utils.Config.Db.MajorVersion >= 14 {
			cmd = []string{"postgres", "-c", "config_file=/etc/postgresql/postgresql.conf"}
		}

		if _, err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.DbImage),
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   cmd,
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{NetworkMode: netId},
		); err != nil {
			return err
		}

		out, err := utils.DockerExec(ctx, dbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done " +
				`&& psql postgresql://postgres:postgres@localhost/postgres <<'EOSQL'
BEGIN;
` + utils.GlobalsSql + `
COMMIT;
EOSQL
`,
		})
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New("Error starting shadow database: " + errBuf.String())
		}

		p.Send(utils.StatusMsg("Resetting database..."))
		if err := differ.ResetDatabase(ctx, dbId, utils.ShadowDbName); err != nil {
			return err
		}

		migrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
		if err != nil {
			return err
		}

		for i, migration := range migrations {
			// NOTE: To handle backward-compatibility. `<timestamp>_init.sql` as
			// the first migration (prev versions of the CLI) is deprecated.
			if i == 0 {
				matches := regexp.MustCompile(`([0-9]{14})_init\.sql`).FindStringSubmatch(migration.Name())
				if len(matches) == 2 {
					if timestamp, err := strconv.ParseUint(matches[1], 10, 64); err != nil {
						return err
					} else if timestamp < 20211209000000 {
						continue
					}
				}
			}

			p.Send(utils.StatusMsg("Applying migration " + utils.Bold(migration.Name()) + "..."))

			content, err := afero.ReadFile(fsys, filepath.Join(utils.MigrationsDir, migration.Name()))
			if err != nil {
				return err
			}

			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", "PGOPTIONS='--client-min-messages=error' psql postgresql://postgres:postgres@localhost/" + utils.ShadowDbName + ` <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error starting shadow database: " + errBuf.String())
			}
		}
	}

	// 4. Diff remote db (source) & shadow db (target) and write it as a new migration.
	{
		p.Send(utils.StatusMsg("Committing changes on remote database as a new migration..."))

		out, err := utils.DockerRun(
			ctx,
			differId,
			&container.Config{
				Image: utils.GetRegistryImageUrl(utils.DifferImage),
				Entrypoint: []string{
					"sh", "-c", "/venv/bin/python3 -u cli.py --json-diff" +
						" '" + conn.Config().ConnString() + "'" +
						" 'postgresql://postgres:postgres@" + dbId + ":5432/" + utils.ShadowDbName + "'",
				},
				Labels: map[string]string{
					"com.supabase.cli.project":   utils.Config.ProjectId,
					"com.docker.compose.project": utils.Config.ProjectId,
				},
			},
			&container.HostConfig{NetworkMode: container.NetworkMode(netId)},
		)
		if err != nil {
			return err
		}

		diffBytes, err := utils.ProcessDiffOutput(p, out)
		if err != nil {
			return err
		}

		if err := differ.SaveDiff(string(diffBytes), "remote_commit", fsys); err != nil {
			return err
		}
	}

	// 5. Insert a row to `schema_migrations`
	if _, err := conn.Exec(ctx, INSERT_MIGRATION_VERSION, timestamp); err != nil {
		return err
	}

	return nil
}

type model struct {
	cancel      context.CancelFunc
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string

	width int
}

func (m model) Init() tea.Cmd {
	return spinner.Tick
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.Type {
		case tea.KeyCtrlC:
			// Stop future runs
			m.cancel()
			// Stop current runs
			utils.DockerRemoveAll(context.Background(), netId)
			return m, tea.Quit
		default:
			return m, nil
		}
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case spinner.TickMsg:
		spinnerModel, cmd := m.spinner.Update(msg)
		m.spinner = spinnerModel
		return m, cmd
	case progress.FrameMsg:
		if m.progress == nil {
			return m, nil
		}

		tmp, cmd := m.progress.Update(msg)
		progressModel := tmp.(progress.Model)
		m.progress = &progressModel
		return m, cmd
	case utils.StatusMsg:
		m.status = string(msg)
		return m, nil
	case utils.ProgressMsg:
		if msg == nil {
			m.progress = nil
			return m, nil
		}

		if m.progress == nil {
			progressModel := progress.NewModel(progress.WithGradient("#1c1c1c", "#34b27b"))
			m.progress = &progressModel
		}

		return m, m.progress.SetPercent(*msg)
	case utils.PsqlMsg:
		if msg == nil {
			m.psqlOutputs = []string{}
			return m, nil
		}

		m.psqlOutputs = append(m.psqlOutputs, *msg)
		if len(m.psqlOutputs) > 5 {
			m.psqlOutputs = m.psqlOutputs[1:]
		}
		return m, nil
	default:
		return m, nil
	}
}

func (m model) View() string {
	var progress string
	if m.progress != nil {
		progress = "\n\n" + m.progress.View()
	}

	var psqlOutputs string
	if len(m.psqlOutputs) > 0 {
		psqlOutputs = "\n\n" + strings.Join(m.psqlOutputs, "\n")
	}

	return wrap.String(m.spinner.View()+m.status+progress+psqlOutputs, m.width)
}

func AssertPostgresVersionMatch(conn *pgx.Conn) error {
	serverVersion := conn.PgConn().ParameterStatus("server_version")
	// Safe to assume that supported Postgres version is 10.0 <= n < 100.0
	majorDigits := len(serverVersion)
	if majorDigits > 2 {
		majorDigits = 2
	}
	dbMajorVersion, err := strconv.ParseUint(serverVersion[:majorDigits], 10, 7)
	if err != nil {
		return err
	}
	if dbMajorVersion != uint64(utils.Config.Db.MajorVersion) {
		return fmt.Errorf(
			"Remote database Postgres version %[1]d is incompatible with %[3]s %[2]d. If you are setting up a fresh Supabase CLI project, try changing %[3]s in %[4]s to %[1]d.",
			dbMajorVersion,
			utils.Config.Db.MajorVersion,
			utils.Aqua("db.major_version"),
			utils.Bold(utils.ConfigPath),
		)
	}
	return nil
}

// Connnect to remote Postgres with optimised settings. The caller is responsible for closing the connection returned.
func ConnectRemotePostgres(ctx context.Context, username, password, database, host string) (*pgx.Conn, error) {
	// Build connection string
	pgUrl := fmt.Sprintf(
		// Use port 6543 for connection pooling
		"postgresql://%s:%s@db.%s.supabase.co:6543/%s",
		url.QueryEscape(username),
		url.QueryEscape(password),
		url.QueryEscape(host),
		url.QueryEscape(database),
	)
	// Parse connection url
	config, err := pgx.ParseConfig(pgUrl)
	if err != nil {
		return nil, err
	}
	// Simple protocol is preferred over pgx default Parse -> Bind flow because
	//   1. Using a single command for each query reduces RTT over an Internet connection.
	//   2. Performance gains from using the alternate binary protocol is negligible because
	//      we are only selecting from migrations table. Large reads are handled by PostgREST.
	//   3. Any prepared statements are cleared server side upon closing the TCP connection.
	//      Since CLI workloads are one-off scripts, we don't use connection pooling and hence
	//      don't benefit from per connection server side cache.
	config.PreferSimpleProtocol = true
	if viper.GetBool("DEBUG") {
		debug.SetupPGX(config)
	}
	return pgx.ConnectConfig(ctx, config)
}

func AssertRemoteInSync(ctx context.Context, conn *pgx.Conn, fsys afero.Fs) error {
	// Load remote migrations
	rows, err := conn.Query(ctx, LIST_MIGRATION_VERSION)
	if err != nil {
		return err
	}
	remoteMigrations := []string{}
	for rows.Next() {
		var version string
		if err := rows.Scan(&version); err != nil {
			return err
		}
		remoteMigrations = append(remoteMigrations, version)
	}
	// Load local migrations
	if err := utils.MkdirIfNotExistFS(fsys, utils.MigrationsDir); err != nil {
		return err
	}
	localMigrations, err := afero.ReadDir(fsys, utils.MigrationsDir)
	if err != nil {
		return err
	}

	conflictErr := errors.New("The remote database's migration history is not in sync with the contents of " + utils.Bold(utils.MigrationsDir) + `. Resolve this by:
- Updating the project from version control to get the latest ` + utils.Bold(utils.MigrationsDir) + `,
- Pushing unapplied migrations with ` + utils.Aqua("supabase db push") + `,
- Or failing that, manually inserting/deleting rows from the supabase_migrations.schema_migrations table on the remote database.`)
	if len(remoteMigrations) != len(localMigrations) {
		return conflictErr
	}

	for i, remoteTimestamp := range remoteMigrations {
		localTimestamp := utils.MigrateFilePattern.FindStringSubmatch(localMigrations[i].Name())[1]

		if localTimestamp == remoteTimestamp {
			continue
		}

		return conflictErr
	}

	return nil
}
