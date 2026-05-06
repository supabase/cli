package utils

import (
	"context"
	"net/http"
	"os"
	"sync"

	"github.com/go-errors/errors"
	"github.com/google/go-github/v62/github"
	"golang.org/x/oauth2"
)

var (
	githubClient *github.Client
	githubOnce   sync.Once
)

func GetGitHubClient(ctx context.Context) *github.Client {
	githubOnce.Do(func() {
		var client *http.Client
		if token := os.Getenv("GITHUB_TOKEN"); len(token) > 0 {
			ts := oauth2.StaticTokenSource(
				&oauth2.Token{AccessToken: token},
			)
			client = oauth2.NewClient(ctx, ts)
		}
		githubClient = github.NewClient(client)
	})
	return githubClient
}

const (
	CLI_OWNER = "supabase"
	CLI_REPO  = "cli"
)

func GetLatestRelease(ctx context.Context) (string, error) {
	client := GetGitHubClient(ctx)
	release, _, err := client.Repositories.GetLatestRelease(ctx, CLI_OWNER, CLI_REPO)
	if err != nil {
		return "", errors.Errorf("Failed to fetch latest release: %w", err)
	}
	if release.TagName == nil {
		return "", nil
	}
	return *release.TagName, nil
}
