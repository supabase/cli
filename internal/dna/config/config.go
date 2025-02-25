package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/BurntSushi/toml"
	"github.com/spf13/afero"
)

// Config holds the DNA assistant configuration
type Config struct {
	APIKey      string  `toml:"api_key"`
	Provider    string  `toml:"provider"`
	Model       string  `toml:"model"`
	Temperature float32 `toml:"temperature"`
}

const (
	// DefaultConfigPath is the default location for the DNA config file
	DefaultConfigPath = "dna.config.toml"
)

// Default configuration values
var DefaultConfig = Config{
	Provider:    "openai",
	Model:       "gpt-4",
	Temperature: 0.7,
}

// Load reads the configuration from the config file and environment variables
func Load(fs afero.Fs) (*Config, error) {
	config := DefaultConfig

	// Try to load from config file
	configPath := getConfigPath()
	if exists, _ := afero.Exists(fs, configPath); exists {
		if _, err := toml.DecodeFile(configPath, &config); err != nil {
			return nil, fmt.Errorf("error reading config file: %w", err)
		}
	}

	// Override with environment variables if set
	if apiKey := os.Getenv("DNA_API_KEY"); apiKey != "" {
		config.APIKey = apiKey
	}
	if provider := os.Getenv("DNA_PROVIDER"); provider != "" {
		config.Provider = provider
	}
	if model := os.Getenv("DNA_MODEL"); model != "" {
		config.Model = model
	}

	// Validate config
	if err := config.Validate(); err != nil {
		return nil, err
	}

	return &config, nil
}

// Save writes the configuration to the config file
func (c *Config) Save(fs afero.Fs) error {
	configPath := getConfigPath()

	// Create directory if it doesn't exist
	configDir := filepath.Dir(configPath)
	if err := fs.MkdirAll(configDir, 0755); err != nil {
		return fmt.Errorf("error creating config directory: %w", err)
	}

	// Create or truncate config file
	f, err := fs.Create(configPath)
	if err != nil {
		return fmt.Errorf("error creating config file: %w", err)
	}
	defer f.Close()

	// Write config
	if err := toml.NewEncoder(f).Encode(c); err != nil {
		return fmt.Errorf("error writing config file: %w", err)
	}

	return nil
}

// Validate checks if the configuration is valid
func (c *Config) Validate() error {
	if c.APIKey == "" {
		return fmt.Errorf("API key is required. Set it in %s or use DNA_API_KEY environment variable", DefaultConfigPath)
	}
	if c.Provider == "" {
		return fmt.Errorf("provider is required")
	}
	if c.Model == "" {
		return fmt.Errorf("model is required")
	}
	return nil
}

func getConfigPath() string {
	if path := os.Getenv("DNA_CONFIG_PATH"); path != "" {
		return path
	}
	return DefaultConfigPath
}
