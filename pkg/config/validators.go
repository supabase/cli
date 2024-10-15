package config

import (
	"net/url"
	"os"
	"path/filepath"

	"github.com/go-errors/errors"
	"github.com/go-playground/validator/v10"
)

// Custom validation function
func envOrString(fl validator.FieldLevel) bool {
	value := fl.Field().String()
	if value == "" {
		// Empty strings are invalid
		return false
	}

	matches := envPattern.FindStringSubmatch(value)
	if len(matches) == 2 {
		// The string is in the form env(SOMETHING)
		envVar := matches[1]
		envValue := os.Getenv(envVar)
		if envValue == "" {
			// Environment variable is not set
			return false
		}
		// Environment variable is set
		return true
	}

	// The string is a regular non-empty string
	return true
}

func projectIDValidator(fl validator.FieldLevel) bool {
	value := fl.Field().String()
	sanitized := sanitizeProjectId(value)
	if sanitized != value {
		// Optionally, update the value (though modifying the field is not recommended in validators)
		return false
	}
	return true
}
func dbMajorVersionValidator(fl validator.FieldLevel) bool {
	version := fl.Field().Uint()
	// Reject version 12
	return version != 12
}

func bucketNameValidator(fl validator.FieldLevel) bool {
	name := fl.Field().String()
	return bucketNamePattern.MatchString(name)
}

func fileExistsValidator(fl validator.FieldLevel) bool {
	path := fl.Field().String()
	if path == "" {
		return false
	}
	_, err := os.Stat(filepath.Clean(path))
	return err == nil
}

func validateHookURI(uri, hookName string) error {
	parsed, err := url.Parse(uri)
	if err != nil {
		return errors.Errorf("failed to parse template url: %w", err)
	}
	if !(parsed.Scheme == "http" || parsed.Scheme == "https" || parsed.Scheme == "pg-functions") {
		return errors.Errorf("Invalid HTTP hook config: auth.hook.%v should be a Postgres function URI, or a HTTP or HTTPS URL", hookName)
	}
	return nil
}

func hookValidator(fl validator.FieldLevel) bool {
	hook := fl.Field().Interface().(hookConfig)
	if !hook.Enabled {
		return true // No validation needed
	}
	if hook.URI == "" {
		return false
	}
	hookName := fl.StructFieldName()
	if err := validateHookURI(hook.URI, hookName); err != nil {
		return false
	}
	// Secrets are checked via env_or_string
	return true
}

func thirdPartyValidator(fl validator.FieldLevel) bool {
	tpa := fl.Field().Interface().(thirdParty)
	enabledCount := 0

	if tpa.Firebase.Enabled {
		enabledCount++
		if tpa.Firebase.ProjectID == "" {
			return false
		}
	}
	if tpa.Auth0.Enabled {
		enabledCount++
		if tpa.Auth0.Tenant == "" {
			return false
		}
	}
	if tpa.Cognito.Enabled {
		enabledCount++
		if tpa.Cognito.UserPoolID == "" || tpa.Cognito.UserPoolRegion == "" {
			return false
		}
	}

	return enabledCount <= 1
}

func functionSlugValidator(fl validator.FieldLevel) bool {
	slug := fl.Field().String()
	return funcSlugPattern.MatchString(slug)
}
