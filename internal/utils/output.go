package utils

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/BurntSushi/toml"
	"github.com/joho/godotenv"
	"gopkg.in/yaml.v2"
)

const (
	OutputEnv    = "env"
	OutputJson   = "json"
	OutputPretty = "pretty"
	OutputToml   = "toml"
	OutputYaml   = "yaml"
)

func OutputFlag(allowEnv bool) EnumFlag {
	var allowed []string

	if allowEnv {
		allowed = append(allowed, OutputEnv)
	}

	allowed = append(
		allowed,
		OutputJson,
		OutputPretty,
		OutputToml,
		OutputYaml,
	)

	return EnumFlag{
		Allowed: allowed,
		Value:   OutputPretty,
	}
}

func EncodeOutput(format string, w io.Writer, value any) error {
	switch format {
	case OutputEnv:
		mapvalue, ok := value.(map[string]string)
		if !ok {
			return fmt.Errorf("value is not a map[string]string and can't be encoded as an environment file")
		}

		out, err := godotenv.Marshal(mapvalue)
		if err != nil {
			return err
		}

		_, err = fmt.Fprintln(w, out)
		return err

	case OutputJson:
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")

		return enc.Encode(value)

	case OutputYaml:
		return yaml.NewEncoder(w).Encode(value)

	case OutputToml:
		return toml.NewEncoder(w).Encode(value)

	default:
		return fmt.Errorf("Unsupported output encoding %q", format)
	}

	return nil
}
