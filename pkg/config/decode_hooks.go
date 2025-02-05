package config

import (
	"os"
	"reflect"
	"regexp"

	"github.com/go-errors/errors"
)

var envPattern = regexp.MustCompile(`^env\((.*)\)$`)

const invalidFunctionsConfigFormat = `Invalid functions config format. Functions should be configured as:

[functions.<function-name>]
field = value

Example:
[functions.hello]
verify_jwt = true`

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

	// Check if any fields are defined directly under [functions] instead of [functions.<name>]
	if m, ok := data.(map[string]interface{}); ok {
		for _, value := range m {
			// Skip nil values and empty function configs as they're valid
			if value == nil {
				continue
			}
			// If it's already a function type, it's valid
			if _, isFunction := value.(function); isFunction {
				continue
			}
			// If the value is not a map, it means it's defined directly under [functions]
			if _, isMap := value.(map[string]interface{}); !isMap {
				return nil, errors.New(invalidFunctionsConfigFormat)
			}
		}
	}

	return data, nil
}
