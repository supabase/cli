package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"text/template"

	"github.com/google/go-github/v53/github"
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
	if len(os.Args) < 2 {
		log.Fatalln("Missing required arg: version")
	}
	semver := os.Args[1]

	ctx, _ := signal.NotifyContext(context.Background(), os.Interrupt)
	if err := publishPackages(ctx, semver); err != nil {
		log.Fatalln(err)
	}
}

func publishPackages(ctx context.Context, version string) error {
	config, err := fetchConfig(ctx, version)
	if err != nil {
		return err
	}
	client := shared.NewGtihubClient(ctx)
	if err := updatePackage(ctx, client, HOMEBREW_REPO, "supabase.rb", brewFormulaTemplate, config); err != nil {
		return err
	}
	return updatePackage(ctx, client, SCOOP_REPO, "supabase.json", scoopBucketTemplate, config)
}

type PackageConfig struct {
	Version  string
	Checksum map[string]string
}

func fetchConfig(ctx context.Context, version string) (PackageConfig, error) {
	config := PackageConfig{Version: version}
	url := fmt.Sprintf("https://github.com/supabase/cli/releases/download/v%[1]v/supabase_%[1]v_checksums.txt", config.Version)
	log.Println(url)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return config, err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return config, err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp, http.StatusOK); err != nil {
		return config, err
	}
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

func checkStatus(resp *http.Response, status int) error {
	if resp.StatusCode == status {
		return nil
	}
	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return fmt.Errorf("status %d: %w", resp.StatusCode, err)
	}
	return fmt.Errorf("status %d: %s", resp.StatusCode, string(data))
}

func updatePackage(ctx context.Context, client *github.Client, repo, path string, tmpl *template.Template, config PackageConfig) error {
	fmt.Fprintf(os.Stderr, "Updating %s: %s\n", repo, path)
	// Render formula from template
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, config); err != nil {
		return err
	}
	// Get file SHA
	file, _, _, err := client.Repositories.GetContents(ctx, SUPABASE_OWNER, repo, path, nil)
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
	message := "Update supabase stable release channel"
	commit := github.RepositoryContentFileOptions{
		Message: &message,
		Content: buf.Bytes(),
		SHA:     file.SHA,
	}
	resp, _, err := client.Repositories.UpdateFile(ctx, SUPABASE_OWNER, repo, path, &commit)
	if err != nil {
		return err
	}
	fmt.Fprintln(os.Stderr, "Committed changes to", *resp.Commit.SHA)
	return nil
}
