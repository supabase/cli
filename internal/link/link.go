package link

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strings"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/iancoleman/orderedmap"
	pgx "github.com/jackc/pgx/v4"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Link(url string) error {
	// Sanity checks.
	{
		if err := utils.AssertDockerIsRunning(); err != nil {
			return err
		}
	}

	s := spinner.NewModel()
	s.Spinner = spinner.Dot
	s.Style = lipgloss.NewStyle().Foreground(lipgloss.Color("205"))
	p := tea.NewProgram(model{spinner: s})

	errCh := make(chan error, 1)
	go func() {
		errCh <- run(p, url)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return errors.New("Aborted `supabase link`.")
	}
	if err := <-errCh; err != nil {
		return err
	}

	fmt.Println("Finished `supabase link`.")
	return nil
}

type model struct {
	spinner     spinner.Model
	status      string
	progress    *progress.Model
	psqlOutputs []string
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
			cancelCtx()
			// Stop current runs
			utils.DockerRemoveAll()
			return m, tea.Quit
		default:
			return m, nil
		}
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
			progressModel := progress.NewModel(progress.WithDefaultGradient())
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

	return m.spinner.View() + m.status + progress + psqlOutputs
}

const (
	netId    = "supabase_link_network"
	dbId     = "supabase_link_db"
	differId = "supabase_link_differ"
)

var ctx, cancelCtx = context.WithCancel(context.Background())

func run(p *tea.Program, url string) error {
	_, _ = utils.Docker.NetworkCreate(ctx, netId, types.NetworkCreate{CheckDuplicate: true})
	defer utils.Docker.NetworkRemove(context.Background(), netId) //nolint:errcheck

	defer utils.DockerRemoveAll()

	conn, err := pgx.Connect(ctx, url)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	var dbVersion string
	if err := conn.QueryRow(ctx, "SELECT current_setting('server_version_num')").Scan(&dbVersion); err != nil {
		return err
	}

	oldConfig, err := os.ReadFile("supabase/config.json")
	if err != nil {
		return err
	}
	o := orderedmap.New()
	if err := json.Unmarshal(oldConfig, &o); err != nil {
		return err
	}
	o.Set("dbVersion", dbVersion)
	newConfig, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		return err
	}
	newConfig = append(newConfig, '\n')

	if err := os.WriteFile("supabase/config.json", newConfig, 0644); err != nil {
		return err
	}
	utils.LoadConfig()
	if err := os.WriteFile("supabase/config.json", oldConfig, 0644); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DbImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DbImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+utils.DifferImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+utils.DifferImage,
				types.ImagePullOptions{},
			)
			if err != nil {
				return err
			}
			if err := utils.ProcessPullOutput(out, p); err != nil {
				return err
			}
		}
	}

	// Sync migrations.
	if rows, err := conn.Query(ctx, "SELECT version FROM supabase_migrations.schema_migrations ORDER BY version"); err == nil {
		// A. supabase_migrations.schema_migrations exists on the deploy database.

		// if `migrations` is a "prefix" of list of migrations in repo:
		// - dump `.env`, `.globals.sql`
		// otherwise:
		// - fail, warn user

		versions := []string{}
		for rows.Next() {
			var version string
			if err := rows.Scan(&version); err != nil {
				return err
			}
			versions = append(versions, version)
		}

		migrations, err := os.ReadDir("supabase/migrations")
		if err != nil {
			return err
		}

		conflictErr := errors.New(
			"supabase_migrations.schema_migrations table conflicts with the contents of `migrations` directory.",
		)

		if len(versions) > len(migrations) {
			return conflictErr
		}

		re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
		for i, version := range versions {
			migrationTimestamp := re.FindStringSubmatch(migrations[i].Name())[1]

			if version == migrationTimestamp {
				continue
			}

			return conflictErr
		}

		p.Send(utils.StatusMsg("`supabase_migrations.schema_migrations` exists on the deploy database. Generating .globals.sql, .env, and updating dbVersion config..."))

		// .globals.sql
		if _, err := utils.DockerRun(
			ctx,
			dbId,
			&container.Config{
				Image: utils.DbImage,
				Env:   []string{"POSTGRES_PASSWORD=postgres"},
				Cmd:   []string{"postgres", "-c", "wal_level=logical"},
			},
			&container.HostConfig{NetworkMode: netId},
		); err != nil {
			return err
		}
		out, err := utils.DockerExec(ctx, dbId, []string{
			"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done",
		})
		if err != nil {
			return err
		}
		var errBuf bytes.Buffer
		if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New("Error starting database: " + errBuf.String())
		}

		out, err = utils.DockerExec(ctx, dbId, []string{
			"sh", "-c", "pg_dumpall --dbname '" + url + "' --globals-only --no-role-passwords " +
				// Drop DDL for `postgres` role since it's already created.
				"| sed '/^CREATE ROLE postgres;/d' " +
				"| sed '/^ALTER ROLE postgres WITH /d' " +
				// Change password of all login roles to `postgres`, useful for Gotrue etc.
				`| sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"`,
		})
		if err != nil {
			return err
		}

		f, err := os.Create("supabase/.globals.sql")
		if err != nil {
			return err
		}
		if _, err := stdcopy.StdCopy(f, &errBuf, out); err != nil {
			return err
		}
		if errBuf.Len() > 0 {
			return errors.New("Error running pg_dumpall: " + errBuf.String())
		}
		if err := f.Close(); err != nil {
			return err
		}

		if err := os.WriteFile("supabase/.env", []byte("SUPABASE_DEPLOY_DB_URL="+url), 0644); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/config.json", newConfig, 0644); err != nil {
			return err
		}
	} else {
		// B. supabase_migrations.schema_migrations doesn't exist on the deploy database.

		p.Send(utils.StatusMsg("`supabase_migrations.schema_migrations` doesn't exist on the deploy database. Creating shadow database..."))

		// 1. Create shadow db and run migrations.
		{
			if _, err := utils.DockerRun(
				ctx,
				dbId,
				&container.Config{
					Image: utils.DbImage,
					Env:   []string{"POSTGRES_PASSWORD=postgres"},
					Cmd:   []string{"postgres", "-c", "wal_level=logical"},
				},
				&container.HostConfig{NetworkMode: netId},
			); err != nil {
				return err
			}
			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", "until pg_isready --host $(hostname --ip-address); do sleep 0.1; done",
			})
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(io.Discard, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error starting database: " + errBuf.String())
			}

			globalsSql := utils.FallbackGlobalsSql
			if content, err := os.ReadFile("supabase/.globals.sql"); err == nil {
				globalsSql = content
			}

			p.Send(utils.StatusMsg("Applying .globals.sql..."))

			out, err = utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", `psql --username postgres --dbname postgres <<'EOSQL'
BEGIN;
` + string(globalsSql) + `
COMMIT;
EOSQL
`,
			})
			if err != nil {
				return err
			}
			if err := utils.ProcessPsqlOutput(out, p); err != nil {
				return err
			}

			migrations, err := os.ReadDir("supabase/migrations")
			if err != nil {
				return err
			}

			for _, migration := range migrations {
				p.Send(utils.StatusMsg("Applying migration " + migration.Name() + "..."))

				content, err := os.ReadFile("supabase/migrations/" + migration.Name())
				if err != nil {
					return err
				}

				out, err := utils.DockerExec(ctx, dbId, []string{
					"sh", "-c", `psql --username postgres --dbname postgres <<'EOSQL'
BEGIN;
` + string(content) + `
COMMIT;
EOSQL
`,
				})
				if err != nil {
					return err
				}
				if err := utils.ProcessPsqlOutput(out, p); err != nil {
					return err
				}
			}
		}

		p.Send(utils.StatusMsg("Syncing current migrations with the deploy database..."))

		// 2. Diff deploy db (source) & shadow db (target) and write it as a new migration.
		{
			out, err := utils.DockerRun(
				ctx,
				differId,
				&container.Config{
					Image: utils.DifferImage,
					Entrypoint: []string{
						"sh", "-c", "/venv/bin/python3 -u cli.py " +
							"'" + url + "' " +
							"'postgres://postgres:postgres@" + dbId + ":5432/postgres'",
					},
				},
				&container.HostConfig{NetworkMode: container.NetworkMode(netId)},
			)
			if err != nil {
				return err
			}

			currentTimestamp := utils.GetCurrentTimestamp()

			f, err := os.Create("supabase/migrations/" + currentTimestamp + "_link.sql")
			if err != nil {
				return err
			}

			diffBytes, err := utils.ProcessDiffOutput(p, out)
			if err != nil {
				return err
			}
			f.Write(diffBytes)

			if err := f.Close(); err != nil {
				return err
			}
		}

		p.Send(utils.StatusMsg("Creating `supabase_migrations.schema_migrations` on the deploy database..."))

		// 3. Generate `schema_migrations` up to the new migration.
		{
			tx, err := conn.BeginTx(ctx, pgx.TxOptions{})
			if err != nil {
				return err
			}
			defer tx.Rollback(context.Background()) //nolint:errcheck

			if _, err := tx.Exec(
				ctx,
				`CREATE SCHEMA IF NOT EXISTS supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text NOT NULL PRIMARY KEY);
`,
			); err != nil {
				return err
			}

			migrations, err := os.ReadDir("supabase/migrations")
			if err != nil {
				return err
			}

			for _, migration := range migrations {
				re := regexp.MustCompile(`([0-9]+)_.*\.sql`)
				migrationTimestamp := re.FindStringSubmatch(migration.Name())[1]
				if _, err := tx.Exec(
					ctx,
					"INSERT INTO supabase_migrations.schema_migrations(version) VALUES($1);",
					migrationTimestamp,
				); err != nil {
					return err
				}
			}

			if err := tx.Commit(ctx); err != nil {
				return err
			}
		}

		p.Send(utils.StatusMsg("Generating .globals.sql, .env, and updating dbVersion config..."))

		// 4. Persist .globals.sql, .env, and new config w/ updated dbVersion.
		{
			// .globals.sql
			out, err := utils.DockerExec(ctx, dbId, []string{
				"sh", "-c", "pg_dumpall --dbname '" + url + "' --globals-only --no-role-passwords " +
					// Omit DDL for `postgres` role since it's already created.
					"| sed '/^CREATE ROLE postgres;/d' " +
					"| sed '/^ALTER ROLE postgres WITH /d' " +
					// Change password of all login roles to `postgres`, useful for Gotrue etc.
					`| sed "/^ALTER ROLE .* WITH .* LOGIN /s/;$/ PASSWORD 'postgres';/"`,
			})
			if err != nil {
				return err
			}

			f, err := os.Create("supabase/.globals.sql")
			if err != nil {
				return err
			}
			var errBuf bytes.Buffer
			if _, err := stdcopy.StdCopy(f, &errBuf, out); err != nil {
				return err
			}
			if errBuf.Len() > 0 {
				return errors.New("Error running pg_dumpall: " + errBuf.String())
			}
			if err := f.Close(); err != nil {
				return err
			}

			if err := os.WriteFile("supabase/.env", []byte("SUPABASE_DEPLOY_DB_URL="+url), 0644); err != nil {
				return err
			}
			if err := os.WriteFile("supabase/config.json", newConfig, 0644); err != nil {
				return err
			}
		}
	}

	return nil
}
