package saml

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"unicode/utf8"

	"github.com/spf13/afero"
	"github.com/supabase/cli/pkg/api"
)

var DefaultClient = http.DefaultClient

func ReadMetadataFile(fsys afero.Fs, path string) (string, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return "", err
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return "", err
	}

	if err := ValidateMetadata(data, path); err != nil {
		return "", err
	}

	return string(data), nil
}

func ReadAttributeMappingFile(fsys afero.Fs, path string) (*api.AttributeMapping, error) {
	file, err := fsys.Open(path)
	if err != nil {
		return nil, err
	}

	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}

	var mapping api.AttributeMapping

	if err := json.Unmarshal(data, &mapping); err != nil {
		return nil, err
	}

	return &mapping, nil
}

func ValidateMetadata(data []byte, source string) error {
	if !utf8.Valid(data) {
		return fmt.Errorf("SAML Metadata XML at %q is not UTF-8 encoded", source)
	}

	return nil
}

func ValidateMetadataURL(ctx context.Context, metadataURL string) error {
	parsed, err := url.ParseRequestURI(metadataURL)
	if err != nil {
		return err
	}

	if strings.ToLower(parsed.Scheme) != "https:" {
		return errors.New("Only HTTPS Metadata URLs are supported.")
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, metadataURL, nil)
	if err != nil {
		return err
	}

	req.Header.Add("Accept", "application/xml")

	resp, err := DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("Received HTTP %v when fetching metatada at %q.", resp.Status, metadataURL)
	}

	data, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}

	if err := ValidateMetadata(data, metadataURL); err != nil {
		return err
	}

	return nil
}
