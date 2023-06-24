package shared

import (
	"context"
	"os"

	"github.com/google/go-github/v53/github"
	"golang.org/x/oauth2"
)

func NewGtihubClient(ctx context.Context) *github.Client {
	ts := oauth2.StaticTokenSource(
		&oauth2.Token{AccessToken: os.Getenv("GITHUB_TOKEN")},
	)
	tc := oauth2.NewClient(ctx, ts)
	return github.NewClient(tc)
}
