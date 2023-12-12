package utils

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/BurntSushi/toml"
	"github.com/go-errors/errors"
	"github.com/joho/godotenv"
	"gopkg.in/yaml.v2"
)

const (
	OutputEnv    = "env"
	OutputJson   = "json"
	OutputPretty = "pretty"
	OutputToml   = "toml"
	OutputYaml   = "yaml"

	// OutputMetadata is used with certain SSO commands only.
	OutputMetadata = "metadata"
)

var (
	OutputDefaultAllowed = []string{
		OutputPretty,
		OutputJson,
		OutputToml,
		OutputYaml,
	}
)

func EncodeOutput(format string, w io.Writer, value any) error {
	switch format {
	case OutputEnv:
		mapvalue, ok := value.(map[string]string)
		if !ok {
			return errors.Errorf("value is not a map[string]string and can't be encoded as an environment file")
		}

		out, err := godotenv.Marshal(mapvalue)
		if err != nil {
			return errors.Errorf("failed to marshal env map: %w", err)
		}

		if _, err := fmt.Fprintln(w, out); err != nil {
			return errors.Errorf("failed to write encoded output: %w", err)
		}

	case OutputJson:
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")

		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output json: %w", err)
		}

	case OutputYaml:
		enc := yaml.NewEncoder(w)
		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output yaml: %w", err)
		}

	case OutputToml:
		enc := toml.NewEncoder(w)
		if err := enc.Encode(value); err != nil {
			return errors.Errorf("failed to output toml: %w", err)
		}

	default:
		return errors.Errorf("Unsupported output encoding %q", format)
	}
	return nil
}
