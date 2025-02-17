package config

import (
	"os"
	"reflect"
	"regexp"

	"github.com/go-errors/errors"
)

var envPattern = regexp.MustCompile(`^env\((.*)\)$`)

// LoadEnvHook is a mapstructure decode hook that loads environment variables
// from strings formatted as env(VAR_NAME).
func LoadEnvHook(f reflect.Kind, t reflect.Kind, data interface{}) (interface{}, error) {
	if f != reflect.String {
		return data, nil
	}
	value := data.(string)
	if matches := envPattern.FindStringSubmatch(value); len(matches) > 1 {
		if env := os.Getenv(matches[1]); len(env) > 0 {
			value = env
		}
	}
	return value, nil
}

const invalidFunctionsConfigFormat = `Invalid functions config format. Functions should be configured as:

[functions.<function-name>]
field = value

Example:
[functions.hello]
verify_jwt = true`

// ValidateFunctionsHook is a mapstructure decode hook that validates the functions config format.
func ValidateFunctionsHook(f reflect.Type, t reflect.Type, data interface{}) (interface{}, error) {
	// Only handle FunctionConfig type
	if t != reflect.TypeOf(FunctionConfig{}) {
		return data, nil
	}

	// Check if source is not a map
	if f.Kind() != reflect.Map {
		return nil, errors.New(invalidFunctionsConfigFormat)
	}

	return data, nil
}
