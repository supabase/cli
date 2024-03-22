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
	"sync"
	"time"

	"github.com/cenkalti/backoff/v4"
	"github.com/go-errors/errors"
	"github.com/google/go-github/v53/github"
	"github.com/google/uuid"
	"github.com/jackc/pgconn"
	"github.com/jackc/pgx/v4"
	"github.com/joho/godotenv"
	"github.com/spf13/afero"
	"github.com/spf13/viper"
	"github.com/supabase/cli/internal/db/push"
	"github.com/supabase/cli/internal/link"
	"github.com/supabase/cli/internal/login"
	"github.com/supabase/cli/internal/projects/apiKeys"
	"github.com/supabase/cli/internal/projects/create"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/internal/utils/flags"
	"github.com/supabase/cli/internal/utils/tenant"
	"github.com/supabase/cli/pkg/api"
	"golang.org/x/oauth2"
	"golang.org/x/term"
)

func Run(ctx context.Context, templateUrl string, fsys afero.Fs, options ...func(*pgx.ConnConfig)) error {
	// 0. Download starter template
	client := GetGtihubClient(ctx)
	if err := downloadSample(ctx, client, templateUrl, fsys); err != nil {
		return err
	}
	// 1. Login
	_, err := utils.LoadAccessTokenFS(fsys)
	if errors.Is(err, utils.ErrMissingToken) {
		if err := promptLogin(ctx, fsys); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	// 2. Create project
	if err := create.Run(ctx, api.CreateProjectBody{}, fsys); err != nil {
		return err
	}
	// 3. Get api keys
	var keys []api.ApiKeyResponse
	policy := newBackoffPolicy(ctx)
	if err := backoff.Retry(func() error {
		fmt.Fprintln(os.Stderr, "Linking project...")
		keys, err = apiKeys.RunGetApiKeys(ctx, flags.ProjectRef)
		if err == nil {
			tenant.SetApiKeys(tenant.NewApiKey(keys))
		}
		return err
	}, policy); err != nil {
		return err
	}
	// 4. Link project
	if err := utils.LoadConfigFS(fsys); err != nil {
		return err
	}
	link.LinkServices(ctx, flags.ProjectRef, fsys)
	if err := utils.WriteFile(utils.ProjectRefPath, []byte(flags.ProjectRef), fsys); err != nil {
		return err
	}
	// 5. Push migrations
	config := flags.NewDbConfigWithPassword(flags.ProjectRef)
	if err := writeDotEnv(keys, config, fsys); err != nil {
		fmt.Fprintln(os.Stderr, "Failed to create .env file:", err)
	}
	policy.Reset()
	return backoff.Retry(func() error {
		return push.Run(ctx, false, false, false, false, config, fsys)
	}, policy)
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

func promptLogin(ctx context.Context, fsys afero.Fs) (err error) {
	params := login.RunParams{
		OpenBrowser: term.IsTerminal(int(os.Stdin.Fd())),
		Fsys:        fsys,
	}
	params.TokenName, err = login.GenerateTokenName()
	if err != nil {
		return err
	}
	params.Encryption, err = login.NewLoginEncryption()
	if err != nil {
		return err
	}
	params.SessionId = uuid.New().String()
	return login.Run(ctx, os.Stdout, params)
}

func writeDotEnv(keys []api.ApiKeyResponse, config pgconn.Config, fsys afero.Fs) error {
	// Write to .env file
	mapvalue := map[string]string{
		"SUPABASE_DB_URL": utils.ToPostgresURL(config),
	}
	for _, entry := range keys {
		key := fmt.Sprintf("SUPABASE_%s_KEY", strings.ToUpper(entry.Name))
		mapvalue[key] = entry.ApiKey
	}
	out, err := godotenv.Marshal(mapvalue)
	if err != nil {
		return errors.Errorf("failed to marshal env map: %w", err)
	}
	return utils.WriteFile(".env", []byte(out), fsys)
}

var (
	githubClient *github.Client
	clientOnce   sync.Once
)

func GetGtihubClient(ctx context.Context) *github.Client {
	clientOnce.Do(func() {
		var client *http.Client
		token := os.Getenv("GITHUB_TOKEN")
		if len(token) > 0 {
			ts := oauth2.StaticTokenSource(
				&oauth2.Token{AccessToken: token},
			)
			client = oauth2.NewClient(ctx, ts)
		}
		githubClient = github.NewClient(client)
	})
	return githubClient
}

type samplesRepo struct {
	Samples []StarterTemplate `json:"samples"`
}

type StarterTemplate struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Url         string `json:"url"`
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
	if !viper.IsSet("WORKDIR") {
		if !utils.PromptYesNo("Do you want to bootstrap in the current directory?", true, os.Stdin) {
			utils.CmdSuggestion = fmt.Sprintf("Run %s to use a custom directory.", utils.Aqua("supabase bootstrap --workdir <path>"))
			return context.Canceled
		}
	}
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
	jq := utils.NewJobQueue(5)
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
				hostPath := filepath.FromSlash("." + path)
				if err := jq.Put(func() error {
					return utils.DownloadFile(ctx, hostPath, file.GetDownloadURL(), fsys)
				}); err != nil {
					return err
				}
			case "dir":
				queue = append(queue, file.GetPath())
			default:
				fmt.Fprintf(os.Stderr, "Ignoring %s: %s\n", file.GetType(), file.GetPath())
			}
		}
	}
	return jq.Collect()
}
