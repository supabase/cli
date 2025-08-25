package utils

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"

	"github.com/go-errors/errors"
	"github.com/spf13/afero"
	"github.com/supabase/cli/internal/utils/credentials"
	"github.com/zalando/go-keyring"
)

var (
	AccessTokenPattern = regexp.MustCompile(`^sbp_(oauth_)?[a-f0-9]{40}$`)
	ErrInvalidToken    = errors.New("Invalid access token format. Must be like `sbp_0102...1920`.")
	ErrMissingToken    = errors.Errorf("Access token not provided. Supply an access token by running %s or setting the SUPABASE_ACCESS_TOKEN environment variable.", Aqua("supabase login"))
	ErrNotLoggedIn     = errors.New("You were not logged in, nothing to do.")
)

const AccessTokenKey = "access-token"

func LoadAccessTokenFS(fsys afero.Fs) (string, error) {
	accessToken, err := loadAccessToken(fsys)
	if err != nil {
		return "", err
	}
	if !AccessTokenPattern.MatchString(accessToken) {
		return "", errors.New(ErrInvalidToken)
	}
	return accessToken, nil
}

func loadAccessToken(fsys afero.Fs) (string, error) {
	logger := GetDebugLogger()
	// Env takes precedence
	if accessToken := os.Getenv("SUPABASE_ACCESS_TOKEN"); accessToken != "" {
		fmt.Fprintln(logger, "Using access token from env var...")
		return accessToken, nil
	}
	// Load from current profile
	if accessToken, err := credentials.StoreProvider.Get(CurrentProfile.Name); err == nil {
		fmt.Fprintln(logger, "Using access token for profile:", CurrentProfile.Name)
		return accessToken, nil
	}
	// Load from legacy key for backwards compatibility
	if accessToken, err := credentials.StoreProvider.Get(AccessTokenKey); err == nil {
		fmt.Fprintln(logger, "Using access token from credentials store...")
		return accessToken, nil
	}
	// Fallback to token file
	return fallbackLoadToken(fsys)
}

func fallbackLoadToken(fsys afero.Fs) (string, error) {
	path, err := getAccessTokenPath()
	if err != nil {
		return "", err
	}
	accessToken, err := afero.ReadFile(fsys, path)
	if errors.Is(err, os.ErrNotExist) {
		return "", errors.New(ErrMissingToken)
	} else if err != nil {
		return "", errors.Errorf("failed to read access token file: %w", err)
	}
	fmt.Fprintln(GetDebugLogger(), "Using access token from file:", path)
	return string(accessToken), nil
}

func SaveAccessToken(accessToken string, fsys afero.Fs) error {
	// Validate access token
	if !AccessTokenPattern.MatchString(accessToken) {
		return errors.New(ErrInvalidToken)
	}
	// Save to current profile
	if err := credentials.StoreProvider.Set(CurrentProfile.Name, accessToken); err != nil {
		fmt.Fprintln(GetDebugLogger(), err)
	} else {
		return nil
	}
	// Fallback to token file
	return fallbackSaveToken(accessToken, fsys)
}

func fallbackSaveToken(accessToken string, fsys afero.Fs) error {
	path, err := getAccessTokenPath()
	if err != nil {
		return err
	}
	if err := MkdirIfNotExistFS(fsys, filepath.Dir(path)); err != nil {
		return err
	}
	if err := afero.WriteFile(fsys, path, []byte(accessToken), 0600); err != nil {
		return errors.Errorf("failed to save access token file: %w", err)
	}
	return nil
}

func DeleteAccessToken(fsys afero.Fs) error {
	// Always delete the fallback token file to handle legacy CLI
	if err := fallbackDeleteToken(fsys); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Always delete from legacy keyring
	if err := credentials.StoreProvider.Delete(AccessTokenKey); err != nil && !errors.Is(err, keyring.ErrNotFound) {
		fmt.Fprintln(GetDebugLogger(), err)
	}
	// Delete profile from native credentials store
	if err := credentials.StoreProvider.Delete(CurrentProfile.Name); err != nil {
		if errors.Is(err, credentials.ErrNotSupported) ||
			errors.Is(err, keyring.ErrUnsupportedPlatform) ||
			errors.Is(err, keyring.ErrNotFound) {
			return errors.New(ErrNotLoggedIn)
		}
		return errors.Errorf("failed to delete access token from keyring: %w", err)
	}
	return nil
}

func fallbackDeleteToken(fsys afero.Fs) error {
	path, err := getAccessTokenPath()
	if err != nil {
		return err
	}
	if err := fsys.Remove(path); err != nil {
		return errors.Errorf("failed to remove access token file: %w", err)
	}
	return nil
}

func getAccessTokenPath() (string, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return "", errors.Errorf("failed to get $HOME directory: %w", err)
	}
	// TODO: fallback to workdir
	return filepath.Join(home, ".supabase", AccessTokenKey), nil
}
