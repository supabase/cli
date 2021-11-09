package init

import (
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"text/template"

	"github.com/charmbracelet/bubbles/progress"
	"github.com/charmbracelet/bubbles/spinner"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/docker/docker/api/types"
	"github.com/supabase/cli/internal/utils"
)

// TODO: Handle cleanup on SIGINT/SIGTERM.
func Init() error {
	// Sanity checks.
	{
		if _, err := os.ReadDir("supabase"); err == nil {
			fmt.Fprintln(
				os.Stderr,
				"Project already initialized. Remove `supabase` directory to reinitialize.",
			)
			os.Exit(1)
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}

		if _, err := utils.GetGitRoot(); err != nil {
			return err
		}

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
		errCh <- run(p)
		p.Send(tea.Quit())
	}()

	if err := p.Start(); err != nil {
		_ = os.RemoveAll("supabase")
		return err
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		_ = os.RemoveAll("supabase")
		return errors.New("Aborted `supabase init`.")
	}
	if err := <-errCh; err != nil {
		_ = os.RemoveAll("supabase")
		return err
	}

	fmt.Println("Finished `supabase init`.")
	return nil
}

type model struct {
	spinner  spinner.Model
	status   string
	progress *progress.Model
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
	default:
		return m, nil
	}
}

func (m model) View() string {
	var progress string
	if m.progress != nil {
		progress = "\n\n" + m.progress.View()
	}

	return m.spinner.View() + m.status + progress
}

const (
	latestDbImage   = "supabase/postgres:13.3.0" // Latest supabase/postgres image on hosted platform.
	latestDbVersion = "130003"
	netId           = "supabase_init_net"
)

var (
	ctx, cancelCtx = context.WithCancel(context.Background())

	// pg_dump --dbname $DB_URL
	//go:embed templates/init_migration_sql
	initMigrationSql []byte
	//go:embed templates/init_seed_sql
	initSeedSql []byte
	//go:embed templates/init_config
	initConfigEmbed       string
	initConfigTemplate, _ = template.New("initConfig").Parse(initConfigEmbed)
	//go:embed templates/init_gitignore
	initGitignore []byte
)

func run(p *tea.Program) error {
	defer utils.Docker.NetworkRemove(context.Background(), netId) //nolint:errcheck
	_, _ = utils.Docker.NetworkCreate(ctx, netId, types.NetworkCreate{CheckDuplicate: true})

	defer utils.DockerRemoveAll()

	p.Send(utils.StatusMsg("Pulling images..."))

	// Pull images.
	{
		// Don't know deploy db's version yet, so use latest image.
		if _, _, err := utils.Docker.ImageInspectWithRaw(ctx, "docker.io/"+latestDbImage); err != nil {
			out, err := utils.Docker.ImagePull(
				ctx,
				"docker.io/"+latestDbImage,
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

	if err := os.Mkdir("supabase", 0755); err != nil {
		return err
	}

	p.Send(utils.StatusMsg("Generating initial migration..."))

	// 1. Write `migrations`.
	if err := os.Mkdir("supabase/migrations", 0755); err != nil {
		return err
	}
	if err := os.WriteFile(
		"supabase/migrations/"+utils.GetCurrentTimestamp()+"_init.sql",
		initMigrationSql,
		0644,
	); err != nil {
		return err
	}

	// 2. Write `.globals.sql`.
	if err := os.WriteFile("supabase/.globals.sql", utils.FallbackGlobalsSql, 0644); err != nil {
		return err
	}

	// 3. Write `config.json`.
	{
		cwd, err := os.Getwd()
		if err != nil {
			return err
		}
		dir := filepath.Base(cwd)

		var initConfigBuf bytes.Buffer
		if err := initConfigTemplate.Execute(
			&initConfigBuf,
			struct{ ProjectId, DbVersion string }{
				ProjectId: dir,
				DbVersion: latestDbVersion,
			},
		); err != nil {
			return err
		}
		if err := os.WriteFile("supabase/config.json", initConfigBuf.Bytes(), 0644); err != nil {
			return err
		}
	}

	// 4. Write `seed.sql`.
	if err := os.WriteFile("supabase/seed.sql", initSeedSql, 0644); err != nil {
		return err
	}

	// 5. Append to `.gitignore`.
	{
		gitRoot, err := utils.GetGitRoot()
		if err != nil {
			return err
		}
		gitignorePath := *gitRoot + "/.gitignore"
		gitignore, err := os.ReadFile(gitignorePath)
		if errors.Is(err, os.ErrNotExist) {
			if err := os.WriteFile(gitignorePath, initGitignore, 0644); err != nil {
				return err
			}
		} else if err != nil {
			return err
		} else if bytes.Contains(gitignore, initGitignore) {
			// skip
		} else {
			f, err := os.OpenFile(gitignorePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0644)
			if err != nil {
				return err
			}
			if _, err := f.Write(append([]byte("\n"), initGitignore...)); err != nil {
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		}
	}

	return nil
}
