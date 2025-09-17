package utils

import (
	"encoding/json"
	"fmt"
	"io"

	"github.com/BurntSushi/toml"
	"github.com/charmbracelet/glamour"
	"github.com/charmbracelet/glamour/styles"
	"github.com/go-errors/errors"
	"github.com/joho/godotenv"
	"gopkg.in/yaml.v3"
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

var OutputFormat = EnumFlag{
	Allowed: []string{
		OutputEnv,
		OutputPretty,
		OutputJson,
		OutputToml,
		OutputYaml,
	},
	Value: OutputPretty,
}

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

func RenderTable(markdown string) error {
	r, err := glamour.NewTermRenderer(
		glamour.WithStandardStyle(styles.AsciiStyle),
		glamour.WithWordWrap(-1),
	)
	if err != nil {
		return errors.Errorf("failed to initialise terminal renderer: %w", err)
	}
	out, err := r.Render(markdown)
	if err != nil {
		return errors.Errorf("failed to render markdown: %w", err)
	}
	fmt.Print(out)
	return nil
}
