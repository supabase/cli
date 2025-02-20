package cmd

import (
	"github.com/joho/godotenv"
	"github.com/sashabaranov/go-openai"
	"github.com/spf13/cobra"
	"github.com/tmc/langchaingo/jsonschema"
)

var assistantCmd = &cobra.Command{
	Use:   "assistant",
	Short: "DNA CLI assistant for database design and normalization",
	Long: `Database Normalization Assistant (DNA) helps with database design and normalization.
It provides interactive guidance for schema design, normalization, and best practices.`,
}

func init() {
	// Load .env file if it exists
	godotenv.Load()

	rootCmd.AddCommand(assistantCmd)

	// Add subcommands
	assistantCmd.AddCommand(newAssistantChatCmd())
	assistantCmd.AddCommand(newAssistantDoctorCmd())
	assistantCmd.AddCommand(newAssistantSchemaCmd())
}

// Environment variables
const (
	EnvDNAProvider    = "DNA_PROVIDER"
	EnvDNAAPIKey      = "DNA_API_KEY"
	EnvDNAModel       = "DNA_MODEL"
	EnvDNATemperature = "DNA_TEMPERATURE"

	// Add Postgres connection constants
	EnvPGHost     = "PGHOST"
	EnvPGPort     = "PGPORT"
	EnvPGDatabase = "PGDATABASE"
	EnvPGUser     = "PGUSER"
	EnvPGPassword = "PGPASSWORD"
)

// Default values
var defaultConfig = struct {
	Provider    string
	Model       string
	Temperature float32
}{
	Provider:    "openai",
	Model:       "gpt-4",
	Temperature: 0.7,
}

var functions = []openai.FunctionDefinition{
	{
		Name:        "search_supabase_docs",
		Description: "Search Supabase documentation",
		Parameters: jsonschema.Definition{
			Type: jsonschema.Object,
			Properties: map[string]jsonschema.Definition{
				"query": {
					Type:        jsonschema.String,
					Description: "The search query",
				},
				"topic": {
					Type:        jsonschema.String,
					Description: "Optional topic to filter results",
				},
			},
		},
	},
	{
		Name: "analyze_schema",
		// ... existing schema analysis function
	},
	{
		Name:        "get_cli_help",
		Description: "Get help information for DNA CLI commands",
		Parameters: jsonschema.Definition{
			Type: jsonschema.Object,
			Properties: map[string]jsonschema.Definition{
				"command": {
					Type:        jsonschema.String,
					Description: "The command to get help for (e.g., 'db', 'assistant'). Empty for root help.",
				},
			},
		},
	},
}

func newAssistantSchemaCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "schema",
		Short: "Get schema information about your database",
		RunE: func(cmd *cobra.Command, args []string) error {
			return nil // TODO: Implement schema command
		},
	}
}
