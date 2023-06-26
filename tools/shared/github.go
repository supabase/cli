package shared

import (
	"context"
	"fmt"
	"os"
	"strings"

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

func CreateGitBranch(ctx context.Context, client *github.Client, owner, repo, branch, base string) error {
	master, _, err := client.Git.GetRef(ctx, owner, repo, "refs/heads/"+base)
	if err != nil {
		return err
	}
	branchRef := "refs/heads/" + branch
	_, _, err = client.Git.CreateRef(ctx, owner, repo, &github.Reference{
		Ref:    &branchRef,
		Object: master.Object,
	})
	// Allow updating existing branch
	if r, ok := err.(*github.ErrorResponse); !ok || r.Message != "Reference already exists" {
		return err
	}
	return nil
}

func CreatePullRequest(ctx context.Context, client *github.Client, owner, repo string, pr github.NewPullRequest) error {
	branch := "refs/heads/" + *pr.Head
	_, _, err := client.PullRequests.Create(ctx, owner, repo, &pr)
	if err, ok := err.(*github.ErrorResponse); ok {
		for _, e := range err.Errors {
			if strings.HasPrefix(e.Message, "No commits between") {
				// Clean up PR branch
				if _, err := client.Git.DeleteRef(ctx, owner, repo, "refs/heads/"+branch); err != nil {
					fmt.Fprintln(os.Stderr, err)
					break
				}
			}
		}
	}
	return err
}
