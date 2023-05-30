package main

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"text/template"
)

var (
	apiHeaders = http.Header{
		"Accept":               {"application/vnd.github+json"},
		"Authorization":        {"Bearer " + os.Getenv("GITHUB_TOKEN")},
		"X-GitHub-Api-Version": {"2022-11-28"},
	}
	//go:embed templates/supabase.rb
	brewFormula         string
	brewFormulaTemplate = template.Must(template.New("brewFormula").Parse(brewFormula))
	//go:embed templates/supabase.json
	scoopBucket         string
	scoopBucketTemplate = template.Must(template.New("scoopBucket").Parse(scoopBucket))
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

type PackageConfig struct {
	Version  string
	Checksum map[string]string
}

func publishPackages(ctx context.Context, version string) error {
	config, err := fetchConfig(ctx, version)
	if err != nil {
		return err
	}
	if err := updateBrew(ctx, config); err != nil {
		return err
	}
	return updateScoop(ctx, config)
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

func updateBrew(ctx context.Context, config PackageConfig) error {
	// Render formula from template
	var buf bytes.Buffer
	if err := brewFormulaTemplate.Execute(&buf, config); err != nil {
		return err
	}
	// Commit to git
	url := "https://api.github.com/repos/supabase/homebrew-tap/contents/supabase.rb"
	return commitGitHub(ctx, url, buf.Bytes())
}

func updateScoop(ctx context.Context, config PackageConfig) error {
	// Render formula from template
	var buf bytes.Buffer
	if err := scoopBucketTemplate.Execute(&buf, config); err != nil {
		return err
	}
	// Commit to git
	url := "https://api.github.com/repos/supabase/scoop-bucket/contents/supabase.json"
	return commitGitHub(ctx, url, buf.Bytes())
}

type UpdateContentsBody struct {
	Message string `json:"message"`
	Content string `json:"content"`
	Sha     string `json:"sha,omitempty"`
}

type GetContentsResponse struct {
	Sha string `json:"sha,omitempty"`
}

func commitGitHub(ctx context.Context, url string, contents []byte) (err error) {
	body := UpdateContentsBody{
		Message: "Update supabase stable release channel",
		Content: base64.StdEncoding.EncodeToString(contents),
	}
	body.Sha, err = getFileSha(ctx, url)
	if err != nil {
		return err
	}
	var jsonBody bytes.Buffer
	enc := json.NewEncoder(&jsonBody)
	if err := enc.Encode(body); err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, url, &jsonBody)
	if err != nil {
		return err
	}
	req.Header = apiHeaders
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	return checkStatus(resp, http.StatusOK)
}

func getFileSha(ctx context.Context, url string) (string, error) {
	log.Println(url)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", err
	}
	req.Header = apiHeaders
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if err := checkStatus(resp, http.StatusOK); err != nil {
		return "", err
	}
	// Parse file sha
	var file GetContentsResponse
	dec := json.NewDecoder(resp.Body)
	if err := dec.Decode(&file); err != nil {
		return "", err
	}
	return file.Sha, nil
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
