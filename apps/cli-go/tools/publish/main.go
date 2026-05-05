package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"text/template"

	"github.com/google/go-github/v62/github"
	"github.com/supabase/cli/internal/utils"
	"github.com/supabase/cli/pkg/fetcher"
	"github.com/supabase/cli/tools/shared"
)

const (
	SUPABASE_OWNER = "supabase"
	HOMEBREW_REPO  = "homebrew-tap"
	SCOOP_REPO     = "scoop-bucket"
)

var (
	//go:embed templates/supabase.rb
	brewFormula         string
	brewFormulaTemplate = template.Must(template.New(HOMEBREW_REPO).Parse(brewFormula))
	//go:embed templates/supabase.json
	scoopBucket         string
	scoopBucketTemplate = template.Must(template.New(SCOOP_REPO).Parse(scoopBucket))
)

func main() {
	beta := flag.Bool("beta", false, "Updates the beta release channel.")
	flag.Parse()

	semver := flag.Arg(0)
	if len(semver) == 0 {
		log.Fatalln("Missing required arg: version")
	} else if semver[0] == 'v' {
		semver = semver[1:]
	}

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := publishPackages(ctx, semver, *beta); err != nil {
		log.Fatalln(err)
	}
}

func publishPackages(ctx context.Context, version string, beta bool) error {
	config, err := fetchConfig(ctx, version)
	if err != nil {
		return err
	}
	config.FormulaName = "Supabase"
	config.Description = "Supabase CLI"
	filename := "supabase"
	if beta {
		config.FormulaName += "Beta"
		config.Description += " (Beta)"
		filename += "-beta"
	}
	client := utils.GetGitHubClient(ctx)
	if err := updatePackage(ctx, client, HOMEBREW_REPO, filename+".rb", brewFormulaTemplate, config); err != nil {
		return err
	}
	return updatePackage(ctx, client, SCOOP_REPO, filename+".json", scoopBucketTemplate, config)
}

type PackageConfig struct {
	Version     string
	Checksum    map[string]string
	Description string
	FormulaName string
}

func fetchConfig(ctx context.Context, version string) (PackageConfig, error) {
	client := fetcher.NewFetcher("https://github.com", fetcher.WithExpectedStatus(http.StatusOK))
	checkPath := fmt.Sprintf("/%s/%s/releases/download/v%[3]s/supabase_%[3]s_checksums.txt",
		utils.CLI_OWNER,
		utils.CLI_REPO,
		version,
	)
	log.Println("Downloading checksum:", checkPath)
	config := PackageConfig{Version: version}
	resp, err := client.Send(ctx, http.MethodGet, checkPath, nil)
	if err != nil {
		return config, err
	}
	defer resp.Body.Close()
	// Read checksums into map: filename -> sha256
	config.Checksum = make(map[string]string)
	scanner := bufio.NewScanner(resp.Body)
	for scanner.Scan() {
		tokens := strings.Fields(scanner.Text())
		key := strings.TrimSuffix(tokens[1], ".tar.gz")
		config.Checksum[key] = tokens[0]
	}
	if err := scanner.Err(); err != nil {
		return config, err
	}
	return config, nil
}

func updatePackage(ctx context.Context, client *github.Client, repo, path string, tmpl *template.Template, config PackageConfig) error {
	fmt.Fprintf(os.Stderr, "Updating %s: %s\n", repo, path)
	// Render formula from template
	var buf bytes.Buffer
	if err := tmpl.Option("missingkey=error").Execute(&buf, config); err != nil {
		return err
	}
	branch := "release/cli"
	master := "main"
	if err := shared.CreateGitBranch(ctx, client, SUPABASE_OWNER, repo, branch, master); err != nil {
		return err
	}
	// Get file SHA
	opts := github.RepositoryContentGetOptions{Ref: "heads/" + branch}
	file, _, _, err := client.Repositories.GetContents(ctx, SUPABASE_OWNER, repo, path, &opts)
	if err != nil {
		return err
	}
	content, err := base64.StdEncoding.DecodeString(*file.Content)
	if err != nil {
		return err
	}
	if bytes.Equal(content, buf.Bytes()) {
		fmt.Fprintln(os.Stderr, "All versions are up to date.")
		return nil
	}
	// Update file content
	message := "Release " + config.Description
	commit := github.RepositoryContentFileOptions{
		Message: &message,
		Content: buf.Bytes(),
		SHA:     file.SHA,
		Branch:  &branch,
	}
	resp, _, err := client.Repositories.UpdateFile(ctx, SUPABASE_OWNER, repo, path, &commit)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Committed changes to", *resp.SHA)
	// Create pull request
	pr := github.NewPullRequest{
		Title: &message,
		Head:  &branch,
		Base:  &master,
	}
	return shared.CreatePullRequest(ctx, client, SUPABASE_OWNER, repo, pr)
}
