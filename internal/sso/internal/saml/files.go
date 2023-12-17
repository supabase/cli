package saml

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/pkg/api"
)

var DefaultClient = http.DefaultClient

func ReadMetadataFile(fsys afero.Fs, path string) (string, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return "", errors.Errorf("failed to open metadata file: %w", err)
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return "", errors.Errorf("failed to read metadata file: %w", err)
	}

	if err := ValidateMetadata(data, path); err != nil {
		return "", err
	}

	return string(data), nil
}

func ReadAttributeMappingFile(fsys afero.Fs, path string) (*api.AttributeMapping, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return nil, errors.Errorf("failed to open attribute mapping: %w", err)
	}

	var mapping api.AttributeMapping
	dec := json.NewDecoder(file)
	if err := dec.Decode(&mapping); err != nil {
		return nil, errors.Errorf("failed to parse attribute mapping: %w", err)
	}

	return &mapping, nil
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

	if strings.ToLower(parsed.Scheme) != "https" {
		return errors.New("only HTTPS Metadata URLs are supported")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataURL, nil)
	if err != nil {
		return errors.Errorf("failed to initialise http request: %w", err)
	}

	req.Header.Add("Accept", "application/xml")

	resp, err := DefaultClient.Do(req)
	if err != nil {
		return errors.Errorf("failed to send http request: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return errors.Errorf("received HTTP %v when fetching metatada at %q", resp.Status, metadataURL)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return errors.Errorf("failed to read http response: %w", err)
	}

	return ValidateMetadata(data, metadataURL)
}
