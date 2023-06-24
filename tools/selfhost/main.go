package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"

	"github.com/google/go-github/v53/github"
	"github.com/supabase/cli/internal/utils"
	"golang.org/x/oauth2"
	"gopkg.in/yaml.v2"
)

const (
	SUPABASE_REPO  = "supabase"
	SUPABASE_OWNER = "supabase"
)

func main() {
	branch := "cli/latest"
	if len(os.Args) > 1 {
		branch = os.Args[1]
	}

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := updateSelfHosted(ctx, branch); err != nil {
		log.Fatalln(err)
	}
}

type ComposeService struct {
	Image string `yaml:"image,omitempty"`
}

type ComposeFile struct {
	Services map[string]ComposeService `yaml:"services,omitempty"`
}

func updateSelfHosted(ctx context.Context, branch string) error {
	client := NewGtihubClient(ctx)
	stable := getStableVersions()
	if err := createGitBranch(ctx, client, branch); err != nil {
		return err
	}
	if err := updateComposeVersion(ctx, client, "docker/docker-compose.yml", branch, stable); err != nil {
		return err
	}
	if err := updateComposeVersion(ctx, client, "docker/docker-compose-logging.yml", branch, stable); err != nil {
		return err
	}
	return createPullRequest(ctx, client, branch)
}

func NewGtihubClient(ctx context.Context) *github.Client {
	ts := oauth2.StaticTokenSource(
		&oauth2.Token{AccessToken: os.Getenv("GITHUB_TOKEN")},
	)
	tc := oauth2.NewClient(ctx, ts)
	return github.NewClient(tc)
}

func getStableVersions() map[string]string {
	images := append([]string{utils.Pg15Image}, utils.ServiceImages...)
	result := make(map[string]string, len(images))
	for _, img := range images {
		parts := strings.Split(img, ":")
		key := strings.TrimPrefix(parts[0], "library/")
		result[key] = parts[1]
	}
	return result
}

func createGitBranch(ctx context.Context, client *github.Client, branch string) error {
	master, _, err := client.Git.GetRef(ctx, SUPABASE_OWNER, SUPABASE_REPO, "refs/heads/master")
	if err != nil {
		return err
	}
	branchRef := "refs/heads/" + branch
	_, _, err = client.Git.CreateRef(ctx, SUPABASE_OWNER, SUPABASE_REPO, &github.Reference{Ref: &branchRef, Object: master.Object})
	return err
}

func createPullRequest(ctx context.Context, client *github.Client, branch string) error {
	title := "chore: update self-hosted image versions"
	master := "master"
	pr := github.NewPullRequest{
		Title: &title,
		Head:  &branch,
		Base:  &master,
	}
	_, _, err := client.PullRequests.Create(ctx, SUPABASE_OWNER, SUPABASE_REPO, &pr)
	return err
}

func updateComposeVersion(ctx context.Context, client *github.Client, path, ref string, stable map[string]string) error {
	fmt.Fprintln(os.Stderr, "Parsing file:", path)
	opts := github.RepositoryContentGetOptions{Ref: "heads/" + ref}
	file, _, _, err := client.Repositories.GetContents(ctx, SUPABASE_OWNER, SUPABASE_REPO, path, &opts)
	if err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(*file.Content)
	if err != nil {
		return err
	}
	var data ComposeFile
	if err := yaml.Unmarshal(content, &data); err != nil {
		return err
	}
	updated := false
	for _, v := range data.Services {
		parts := strings.Split(v.Image, ":")
		if version, ok := stable[parts[0]]; ok && parts[1] != version {
			fmt.Fprintf(os.Stderr, "Updating %s: %s => %s\n", parts[0], parts[1], version)
			image := strings.Join([]string{parts[0], version}, ":")
			content = bytes.ReplaceAll(content, []byte(v.Image), []byte(image))
			updated = true
		}
	}
	if !updated {
		fmt.Fprintln(os.Stderr, "All images are up to date.")
		return nil
	}
	message := "chore: update image versions for " + path
	commit := github.RepositoryContentFileOptions{
		Message: &message,
		Content: content,
		SHA:     file.SHA,
		Branch:  &ref,
	}
	resp, _, err := client.Repositories.UpdateFile(ctx, SUPABASE_OWNER, SUPABASE_REPO, path, &commit)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Committed changes to", *resp.Commit.SHA)
	return nil
}
