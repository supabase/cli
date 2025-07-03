package saml

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/pkg/fetcher"
)

var DefaultClient = http.DefaultClient

func ReadMetadataFile(fsys afero.Fs, path string) (string, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return "", errors.Errorf("failed to open metadata file: %w", err)
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return "", errors.Errorf("failed to read metadata file: %w", err)
	}

	if err := ValidateMetadata(data, path); err != nil {
		return "", err
	}

	return string(data), nil
}

func ReadAttributeMappingFile(fsys afero.Fs, path string, mapping any) error {
	file, err := fsys.Open(path)
	if err != nil {
		return errors.Errorf("failed to open attribute mapping: %w", err)
	}
	defer file.Close()

	dec := json.NewDecoder(file)
	if err := dec.Decode(mapping); err != nil {
		return errors.Errorf("failed to parse attribute mapping: %w", err)
	}

	return nil
}

func ValidateMetadata(data []byte, source string) error {
	if !utf8.Valid(data) {
		return errors.Errorf("SAML Metadata XML at %q is not UTF-8 encoded", source)
	}

	return nil
}

func ValidateMetadataURL(ctx context.Context, metadataURL string) error {
	parsed, err := url.ParseRequestURI(metadataURL)
	if err != nil {
		return errors.Errorf("failed to parse metadata uri: %w", err)
	}

	if !strings.EqualFold(parsed.Scheme, "https") {
		return errors.New("only HTTPS Metadata URLs are supported")
	}

	client := fetcher.NewFetcher("",
		fetcher.WithHTTPClient(&http.Client{
			Timeout: 10 * time.Second,
		}),
		fetcher.WithRequestEditor(func(req *http.Request) {
			req.Header.Add("Accept", "application/xml")
		}),
		fetcher.WithExpectedStatus(http.StatusOK),
	)
	resp, err := client.Send(ctx, http.MethodGet, metadataURL, nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return errors.Errorf("failed to read http response: %w", err)
	}

	return ValidateMetadata(data, metadataURL)
}
