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
	"github.com/slack-go/slack"
	"github.com/supabase/cli/tools/shared"
)

const (
	SUPABASE_OWNER = "supabase"
	SUPABASE_REPO  = "cli"
)

func main() {
	slackChannel := ""
	if len(os.Args) > 1 {
		slackChannel = os.Args[1]
	}

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := showChangeLog(ctx, slackChannel); err != nil {
		log.Fatalln(err)
	}
}

func showChangeLog(ctx context.Context, slackChannel string) error {
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
	title := Title(releases[n])
	body := Body(notes)
	fmt.Println(title)
	fmt.Println(body)
	if len(slackChannel) == 0 {
		return nil
	}
	title = slackFormat(title)
	body = slackFormat(body)
	return slackAnnounce(ctx, slackChannel, title, body)
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

var logPattern = regexp.MustCompile(`^\* (.*): (.*) by @(.*) in (https:.*)$`)

type ChangeGroup struct {
	Prefix   string
	Header   string
	Messages []string
}

func (g ChangeGroup) Markdown() string {
	result := make([]string, len(g.Messages)+2)
	result[1] = "### " + g.Header
	for i, m := range g.Messages {
		result[i+2] = logPattern.ReplaceAllString(m, "* [$1]($4): $2")
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
		matches := logPattern.FindStringSubmatch(msg)
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
		if len(g.Messages) > 0 && g.Header != "Dependencies" {
			sort.Strings(g.Messages)
			result = append(result, g.Markdown())
		}
	}
	result = append(result, footer...)
	return strings.Join(result, "\n")
}

var linkPattern = regexp.MustCompile(`^(.*)\[(.*?)\]\((.*?)\)(.*)$`)

func toSlack(md string) string {
	// Change link format
	line := linkPattern.ReplaceAllString(md, "$1<$3|$2>$4")
	// Change first header to plain text
	if strings.HasPrefix(line, "# ") {
		return line[2:]
	}
	// Change second header to italics
	if strings.HasPrefix(line, "## ") {
		return fmt.Sprintf("_%s_", line[3:])
	}
	// Change third header to bold
	if strings.HasPrefix(line, "### ") {
		return fmt.Sprintf("*%s*", line[4:])
	}
	// Keep original list style
	if strings.HasPrefix(line, "* ") {
		return "• " + line[2:]
	}
	// Keep original bold style
	return strings.ReplaceAll(line, "**", "*")
}

func slackFormat(md string) string {
	lines := strings.Split(md, "\n")
	for i, md := range lines {
		lines[i] = toSlack(md)
	}
	return strings.Join(lines, "\n")
}

func slackAnnounce(ctx context.Context, channel, title, body string) error {
	api := slack.New(os.Getenv("SLACK_TOKEN"), slack.OptionDebug(true))
	msg := slack.MsgOptionBlocks(
		slack.NewHeaderBlock(&slack.TextBlockObject{Type: slack.PlainTextType, Text: title}),
		slack.NewSectionBlock(&slack.TextBlockObject{Type: slack.MarkdownType, Text: body}, nil, nil),
	)
	_, timestamp, err := api.PostMessageContext(ctx, channel, msg)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Announced changelog", timestamp)
	return nil
}
