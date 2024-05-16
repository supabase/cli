package utils

import (
	"context"
	"net/http"
	"os"
	"sync"

	"github.com/google/go-github/v62/github"
	"golang.org/x/oauth2"
)

var (
	githubClient *github.Client
	githubOnce   sync.Once
)

func GetGtihubClient(ctx context.Context) *github.Client {
	githubOnce.Do(func() {
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
