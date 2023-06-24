package main

import (
	"context"
	_ "embed"
	"fmt"
	"log"
	"os"
	"os/signal"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/google/go-github/v53/github"
	"github.com/supabase/cli/tools/shared"
)

const (
	SUPABASE_OWNER = "supabase"
	SUPABASE_REPO  = "cli"
)

func main() {
	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := showChangeLog(ctx); err != nil {
		log.Fatalln(err)
	}
}

func showChangeLog(ctx context.Context) error {
	client := shared.NewGtihubClient(ctx)
	releases, _, err := client.Repositories.ListReleases(ctx, SUPABASE_OWNER, SUPABASE_REPO, &github.ListOptions{})
	if err != nil {
		return err
	}
	opts := github.GenerateNotesOptions{}
	n := getLatestRelease(releases)
	if n < len(releases) {
		opts.TagName = *releases[n].TagName
		if m := getLatestRelease(releases[n+1:]) + n + 1; m < len(releases) {
			opts.PreviousTagName = releases[m].TagName
		}
	} else {
		branch := "main"
		opts.TargetCommitish = &branch
		opts.TagName = "v1.0.0"
	}
	fmt.Fprintln(os.Stderr, "Generating changelog for", opts.TagName)
	notes, _, err := client.Repositories.GenerateReleaseNotes(ctx, SUPABASE_OWNER, SUPABASE_REPO, &opts)
	if err != nil {
		return err
	}
	fmt.Println(Title(releases[n]))
	fmt.Println(Body(notes))
	return nil
}

func getLatestRelease(releases []*github.RepositoryRelease) int {
	for i, r := range releases {
		if !*r.Draft && !*r.Prerelease {
			return i
		}
	}
	return len(releases)
}

func Title(r *github.RepositoryRelease) string {
	timestamp := r.PublishedAt.GetTime()
	if timestamp == nil {
		now := time.Now().UTC()
		timestamp = &now
	}
	return fmt.Sprintf("# %s (%s)\n", timestamp.Format("2 Jan 2006"), *r.TagName)
}

var pattern = regexp.MustCompile("^* (.*): (.*) by @(.*) in (https:.*)$")

type ChangeGroup struct {
	Prefix   string
	Header   string
	Messages []string
}

func (g ChangeGroup) Markdown() string {
	result := make([]string, len(g.Messages)+2)
	result[1] = "### " + g.Header
	for i, m := range g.Messages {
		matches := pattern.FindStringSubmatch(m)
		result[i+2] = fmt.Sprintf("* [%s](%s): %s", matches[1], matches[4], matches[2])
	}
	return strings.Join(result, "\n")
}

func Body(n *github.RepositoryReleaseNotes) string {
	lines := strings.Split(n.Body, "\n")
	// Group features, fixes, dependencies, and chores
	groups := []ChangeGroup{
		{Prefix: "feat", Header: "Features"},
		{Prefix: "fix", Header: "Bug fixes"},
		{Prefix: "chore(deps)", Header: "Dependencies"},
		{Header: "Others"},
	}
	footer := []string{}
	for _, msg := range lines[1:] {
		matches := pattern.FindStringSubmatch(msg)
		if len(matches) != 5 {
			footer = append(footer, msg)
			continue
		}
		cat := strings.ToLower(matches[1])
		for i, g := range groups {
			if strings.HasPrefix(cat, g.Prefix) {
				groups[i].Messages = append(g.Messages, msg)
				break
			}
		}
	}
	// Concatenate output
	result := []string{lines[0]}
	for _, g := range groups {
		if len(g.Messages) > 0 {
			sort.Strings(g.Messages)
			result = append(result, g.Markdown())
		}
	}
	result = append(result, footer...)
	return strings.Join(result, "\n")
}
