package bootstrap

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
	"github.com/google/go-github/v62/github"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/push"
	initBlank "github.com/supabase/cli/internal/init"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/projects/apiKeys"
	"github.com/supabase/cli/internal/projects/create"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/pkg/queue"
	"golang.org/x/term"
)

func Run(ctx context.Context, starter StarterTemplate, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	workdir := viper.GetString("WORKDIR")
	if !filepath.IsAbs(workdir) {
		workdir = filepath.Join(utils.CurrentDirAbs, workdir)
	}
	if err := utils.MkdirIfNotExistFS(fsys, workdir); err != nil {
		return err
	}
	if empty, err := afero.IsEmpty(fsys, workdir); err != nil {
		return errors.Errorf("failed to read workdir: %w", err)
	} else if !empty {
		title := fmt.Sprintf("Do you want to overwrite existing files in %s directory?", utils.Bold(workdir))
		if shouldOverwrite, err := utils.NewConsole().PromptYesNo(ctx, title, true); err != nil {
			return err
		} else if !shouldOverwrite {
			return errors.New(context.Canceled)
		}
	}
	if err := utils.ChangeWorkDir(fsys); err != nil {
		return err
	}
	// 0. Download starter template
	if len(starter.Url) > 0 {
		client := utils.GetGitHubClient(ctx)
		if err := downloadSample(ctx, client, starter.Url, fsys); err != nil {
			return err
		}
	} else if err := initBlank.Run(ctx, fsys, nil, nil, utils.InitParams{Overwrite: true}); err != nil {
		return err
	}
	// 1. Login
	_, err := utils.LoadAccessTokenFS(fsys)
	if errors.Is(err, utils.ErrMissingToken) {
		if err := login.Run(ctx, os.Stdout, login.RunParams{
			OpenBrowser: term.IsTerminal(int(os.Stdin.Fd())),
			Fsys:        fsys,
		}); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	// 2. Create project
	params := api.V1CreateProjectBody{
		Name: filepath.Base(workdir),
	}
	if len(starter.Url) > 0 {
		params.TemplateUrl = &starter.Url
	}
	if err := create.Run(ctx, params, fsys); err != nil {
		return err
	}
	// 3. Get api keys
	var keys []api.ApiKeyResponse
	policy := newBackoffPolicy(ctx)
	if err := backoff.RetryNotify(func() error {
		fmt.Fprintln(os.Stderr, "Linking project...")
		keys, err = apiKeys.RunGetApiKeys(ctx, flags.ProjectRef)
		return err
	}, policy, newErrorCallback()); err != nil {
		return err
	}
	// 4. Link project
	if err := flags.LoadConfig(fsys); err != nil {
		return err
	}
	link.LinkServices(ctx, flags.ProjectRef, tenant.NewApiKey(keys).Anon, fsys)
	if err := utils.WriteFile(utils.ProjectRefPath, []byte(flags.ProjectRef), fsys); err != nil {
		return err
	}
	// 5. Wait for project healthy
	policy.Reset()
	if err := backoff.RetryNotify(func() error {
		fmt.Fprintln(os.Stderr, "Checking project health...")
		return checkProjectHealth(ctx)
	}, policy, newErrorCallback()); err != nil {
		return err
	}
	// 6. Push migrations
	config := flags.NewDbConfigWithPassword(flags.ProjectRef)
	if err := writeDotEnv(keys, config, fsys); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to create .env file:", err)
	}
	policy.Reset()
	if err := backoff.RetryNotify(func() error {
		return push.Run(ctx, false, false, true, true, config, fsys)
	}, policy, newErrorCallback()); err != nil {
		return err
	}
	// 7. TODO: deploy functions
	utils.CmdSuggestion = suggestAppStart(utils.CurrentDirAbs, starter.Start)
	return nil
}

func suggestAppStart(cwd, command string) string {
	logger := utils.GetDebugLogger()
	workdir, err := os.Getwd()
	if err != nil {
		fmt.Fprintln(logger, err)
	}
	workdir, err = filepath.Rel(cwd, workdir)
	if err != nil {
		fmt.Fprintln(logger, err)
	}
	var cmd []string
	if len(workdir) > 0 && workdir != "." {
		cmd = append(cmd, "cd "+workdir)
	}
	if len(command) > 0 {
		cmd = append(cmd, command)
	}
	suggestion := "To start your app:"
	for _, c := range cmd {
		suggestion += fmt.Sprintf("\n  %s", utils.Aqua(c))
	}
	return suggestion
}

func checkProjectHealth(ctx context.Context) error {
	params := api.V1GetServicesHealthParams{
		Services: []api.V1GetServicesHealthParamsServices{api.Db},
	}
	resp, err := utils.GetSupabase().V1GetServicesHealthWithResponse(ctx, flags.ProjectRef, &params)
	if err != nil {
		return err
	}
	if resp.JSON200 == nil {
		return errors.Errorf("Error status %d: %s", resp.StatusCode(), resp.Body)
	}
	for _, service := range *resp.JSON200 {
		if !service.Healthy {
			return errors.Errorf("Service not healthy: %s (%s)", service.Name, service.Status)
		}
	}
	return nil
}

const maxRetries = 8

func newBackoffPolicy(ctx context.Context) backoff.BackOffContext {
	b := backoff.ExponentialBackOff{
		InitialInterval:     3 * time.Second,
		RandomizationFactor: backoff.DefaultRandomizationFactor,
		Multiplier:          backoff.DefaultMultiplier,
		MaxInterval:         backoff.DefaultMaxInterval,
		MaxElapsedTime:      backoff.DefaultMaxElapsedTime,
		Stop:                backoff.Stop,
		Clock:               backoff.SystemClock,
	}
	b.Reset()
	return backoff.WithContext(backoff.WithMaxRetries(&b, maxRetries), ctx)
}

func newErrorCallback() backoff.Notify {
	failureCount := 0
	logger := utils.GetDebugLogger()
	return func(err error, d time.Duration) {
		failureCount += 1
		fmt.Fprintln(logger, err)
		fmt.Fprintf(os.Stderr, "Retry (%d/%d): ", failureCount, maxRetries)
	}
}

const (
	SUPABASE_SERVICE_ROLE_KEY = "SUPABASE_SERVICE_ROLE_KEY"
	SUPABASE_ANON_KEY         = "SUPABASE_ANON_KEY"
	SUPABASE_URL              = "SUPABASE_URL"
	POSTGRES_URL              = "POSTGRES_URL"
	// Derived keys
	POSTGRES_PRISMA_URL           = "POSTGRES_PRISMA_URL"
	POSTGRES_URL_NON_POOLING      = "POSTGRES_URL_NON_POOLING"
	POSTGRES_USER                 = "POSTGRES_USER"
	POSTGRES_HOST                 = "POSTGRES_HOST"
	POSTGRES_PASSWORD             = "POSTGRES_PASSWORD" //nolint:gosec
	POSTGRES_DATABASE             = "POSTGRES_DATABASE"
	NEXT_PUBLIC_SUPABASE_ANON_KEY = "NEXT_PUBLIC_SUPABASE_ANON_KEY"
	NEXT_PUBLIC_SUPABASE_URL      = "NEXT_PUBLIC_SUPABASE_URL"
	EXPO_PUBLIC_SUPABASE_ANON_KEY = "EXPO_PUBLIC_SUPABASE_ANON_KEY"
	EXPO_PUBLIC_SUPABASE_URL      = "EXPO_PUBLIC_SUPABASE_URL"
)

func writeDotEnv(keys []api.ApiKeyResponse, config pgconn.Config, fsys afero.Fs) error {
	// Initialise default envs
	initial := apiKeys.ToEnv(keys)
	initial[SUPABASE_URL] = "https://" + utils.GetSupabaseHost(flags.ProjectRef)
	transactionMode := *config.Copy()
	transactionMode.Port = 6543
	initial[POSTGRES_URL] = utils.ToPostgresURL(transactionMode)
	// Populate from .env.example if exists
	envs, err := parseExampleEnv(fsys)
	if err != nil {
		return err
	}
	for k, v := range envs {
		switch k {
		case SUPABASE_SERVICE_ROLE_KEY:
		case SUPABASE_ANON_KEY:
		case SUPABASE_URL:
		case POSTGRES_URL:
		// Derived keys
		case POSTGRES_PRISMA_URL:
			initial[k] = initial[POSTGRES_URL]
		case POSTGRES_URL_NON_POOLING:
			initial[k] = utils.ToPostgresURL(config)
		case POSTGRES_USER:
			initial[k] = config.User
		case POSTGRES_HOST:
			initial[k] = config.Host
		case POSTGRES_PASSWORD:
			initial[k] = config.Password
		case POSTGRES_DATABASE:
			initial[k] = config.Database
		case NEXT_PUBLIC_SUPABASE_ANON_KEY:
			fallthrough
		case EXPO_PUBLIC_SUPABASE_ANON_KEY:
			initial[k] = initial[SUPABASE_ANON_KEY]
		case NEXT_PUBLIC_SUPABASE_URL:
			fallthrough
		case EXPO_PUBLIC_SUPABASE_URL:
			initial[k] = initial[SUPABASE_URL]
		default:
			initial[k] = v
		}
	}
	// Write to .env file
	out, err := godotenv.Marshal(initial)
	if err != nil {
		return errors.Errorf("failed to marshal env map: %w", err)
	}
	return utils.WriteFile(".env", []byte(out), fsys)
}

func parseExampleEnv(fsys afero.Fs) (map[string]string, error) {
	path := ".env.example"
	f, err := fsys.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	} else if err != nil {
		return nil, errors.Errorf("failed to open %s: %w", path, err)
	}
	defer f.Close()
	envs, err := godotenv.Parse(f)
	if err != nil {
		return nil, errors.Errorf("failed to parse %s: %w", path, err)
	}
	return envs, nil
}

type samplesRepo struct {
	Samples []StarterTemplate `json:"samples"`
}

type StarterTemplate struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Url         string `json:"url"`
	Start       string `json:"start"`
}

func ListSamples(ctx context.Context, client *github.Client) ([]StarterTemplate, error) {
	owner := "supabase-community"
	repo := "supabase-samples"
	path := "samples.json"
	ref := "main"
	opts := github.RepositoryContentGetOptions{Ref: ref}
	file, _, _, err := client.Repositories.GetContents(ctx, owner, repo, path, &opts)
	if err != nil {
		return nil, errors.Errorf("failed to list samples: %w", err)
	}
	content, err := file.GetContent()
	if err != nil {
		return nil, errors.Errorf("failed to decode samples: %w", err)
	}
	var data samplesRepo
	if err := json.Unmarshal([]byte(content), &data); err != nil {
		return nil, errors.Errorf("failed to unmarshal samples: %w", err)
	}
	return data.Samples, nil
}

func downloadSample(ctx context.Context, client *github.Client, templateUrl string, fsys afero.Fs) error {
	fmt.Println("Downloading:", templateUrl)
	// https://github.com/supabase/supabase/tree/master/examples/user-management/nextjs-user-management
	parsed, err := url.Parse(templateUrl)
	if err != nil {
		return errors.Errorf("failed to parse template url: %w", err)
	}
	parts := strings.Split(parsed.Path, "/")
	owner := parts[1]
	repo := parts[2]
	ref := parts[4]
	root := strings.Join(parts[5:], "/")
	opts := github.RepositoryContentGetOptions{Ref: ref}
	queue := make([]string, 0)
	queue = append(queue, root)
	download := NewDownloader(5, fsys)
	for len(queue) > 0 {
		contentPath := queue[0]
		queue = queue[1:]
		_, directory, _, err := client.Repositories.GetContents(ctx, owner, repo, contentPath, &opts)
		if err != nil {
			return errors.Errorf("failed to download template: %w", err)
		}
		for _, file := range directory {
			switch file.GetType() {
			case "file":
				path := strings.TrimPrefix(file.GetPath(), root)
				hostPath := filepath.Join(".", filepath.FromSlash(path))
				if err := download.Start(ctx, hostPath, file.GetDownloadURL()); err != nil {
					return err
				}
			case "dir":
				queue = append(queue, file.GetPath())
			default:
				fmt.Fprintf(os.Stderr, "Ignoring %s: %s\n", file.GetType(), file.GetPath())
			}
		}
	}
	return download.Wait()
}

type Downloader struct {
	api   *fetcher.Fetcher
	queue *queue.JobQueue
	fsys  afero.Fs
}

func NewDownloader(concurrency uint, fsys afero.Fs) *Downloader {
	return &Downloader{
		api:   fetcher.NewFetcher("", fetcher.WithExpectedStatus(http.StatusOK)),
		queue: queue.NewJobQueue(concurrency),
		fsys:  fsys,
	}
}

func (d *Downloader) Start(ctx context.Context, localPath, remotePath string) error {
	job := func() error {
		resp, err := d.api.Send(ctx, http.MethodGet, remotePath, nil)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		if err := afero.WriteReader(d.fsys, localPath, resp.Body); err != nil {
			return errors.Errorf("failed to write file: %w", err)
		}
		return nil
	}
	return d.queue.Put(job)
}

func (d *Downloader) Wait() error {
	return d.queue.Collect()
}
