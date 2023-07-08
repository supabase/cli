package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"os"
	"os/signal"
	"regexp"

	"github.com/google/go-github/v53/github"
	"github.com/supabase/cli/tools/shared"
)

const (
	SUPABASE_OWNER = "supabase"
	SUPABASE_REPO  = "supabase"
)

func main() {
	path := ""
	if len(os.Args) > 1 {
		path = os.Args[1]
	}

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := updateRefDoc(ctx, path, os.Stdin); err != nil {
		log.Fatalln(err)
	}
}

var quotePattern = regexp.MustCompile(`(default_value|clispec): "(true|false|[0-9]+|\s*)"`)

func updateRefDoc(ctx context.Context, path string, stdin io.Reader) error {
	buf, err := io.ReadAll(stdin)
	if err != nil {
		return err
	}
	buf = quotePattern.ReplaceAll(buf, []byte("$1: '$2'"))
	if len(path) == 0 {
		fmt.Print(string(buf))
		return nil
	}
	fmt.Fprintf(os.Stderr, "Updating reference doc: %s\n", path)
	client := shared.NewGtihubClient(ctx)
	branch := "cli/ref-doc"
	master := "master"
	if err := shared.CreateGitBranch(ctx, client, SUPABASE_OWNER, SUPABASE_REPO, branch, master); err != nil {
		return err
	}
	// Get original file
	opts := github.RepositoryContentGetOptions{Ref: "heads/" + branch}
	file, _, _, err := client.Repositories.GetContents(ctx, SUPABASE_OWNER, SUPABASE_REPO, path, &opts)
	if err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(*file.Content)
	if err != nil {
		return err
	}
	if bytes.Equal(content, buf) {
		fmt.Fprintln(os.Stderr, "All versions are up to date.")
		return nil
	}
	// Update file content
	message := "chore: update cli reference doc"
	commit := github.RepositoryContentFileOptions{
		Message: &message,
		Content: buf,
		SHA:     file.SHA,
		Branch:  &branch,
	}
	resp, _, err := client.Repositories.UpdateFile(ctx, SUPABASE_OWNER, SUPABASE_REPO, path, &commit)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Committed changes to", *resp.Commit.SHA)
	// Create pull request
	pr := github.NewPullRequest{
		Title: &message,
		Head:  &branch,
		Base:  &master,
	}
	return shared.CreatePullRequest(ctx, client, SUPABASE_OWNER, SUPABASE_REPO, pr)
}
