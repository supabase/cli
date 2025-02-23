package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
	"github.com/joho/godotenv"
	"github.com/sashabaranov/go-openai"
	"github.com/spf13/cobra"
)

type ChatSession struct {
	client   *openai.Client
	history  []openai.ChatCompletionMessage
	isActive bool
}

func newAssistantChatCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "chat",
		Short: "Start an interactive chat session with the DNA assistant",
		RunE: func(cmd *cobra.Command, args []string) error {
			return startChatSession()
		},
	}
}

func init() {
	// Load environment variables from .env file
	if err := godotenv.Load(); err != nil {
		fmt.Println("Warning: .env file not found, using default values")
	}

	// Initialize colors and other settings
	assistantColor = color.New(color.FgGreen)
	toolColor = color.New(color.FgYellow)
	separator = strings.Repeat("=", 50)
	toolSeparator = strings.Repeat("-", 30)

	// Check for required API key
	if os.Getenv("DNA_API_KEY") == "" {
		fmt.Println("DNA_API_KEY not set. Please set your API key: export DNA_API_KEY=your_api_key")
		os.Exit(1)
	}
}

func startChatSession() error {
	apiKey := os.Getenv(EnvDNAAPIKey)
	if apiKey == "" {
		return fmt.Errorf("DNA_API_KEY not set. Please set your API key: export DNA_API_KEY=your_api_key")
	}

	session := &ChatSession{
		client: openai.NewClient(apiKey),
		history: []openai.ChatCompletionMessage{
			{
				Role: openai.ChatMessageRoleSystem,
				Content: `You are a Database Normalization Assistant (DNA) for Supabase.
You help developers design and normalize their database schemas.
You provide guidance on:
1. Database design best practices
2. Normalization (1NF, 2NF, 3NF)
3. Supabase-specific features and optimizations
4. Schema analysis and improvements

Always explain your reasoning and provide examples when relevant.`,
			},
		},
		isActive: true,
	}

	printWelcomeMessage()
	return session.chatLoop()
}

func printWelcomeMessage() {
	fmt.Fprint(color.Output, helpText)
}

func (s *ChatSession) chatLoop() error {
	reader := bufio.NewReader(os.Stdin)

	for s.isActive {
		fmt.Fprint(color.Output, prompt)
		input, err := reader.ReadString('\n')
		if err != nil {
			return fmt.Errorf("error reading input: %w", err)
		}

		input = strings.TrimSpace(input)
		if input == "" {
			continue
		}

		// First check hard-coded commands
		switch input {
		case "exit", "quit":
			handleChatResponse("exit")
			s.isActive = false
			continue
		case "help":
			handleChatResponse("help")
			continue
		case "clear":
			s.history = s.history[:1]
			fmt.Fprintln(color.Output, bannerColor.Sprint("Chat history cleared."))
			continue
		}

		// Then check for tool-specific commands
		if strings.HasPrefix(input, "analyze") ||
			strings.HasPrefix(input, "verify") ||
			strings.HasPrefix(input, "search") {
			if err := s.handleToolCommand(input); err != nil {
				fmt.Fprintf(color.Output, "%s%v%s\n",
					separator,
					errorColor.Sprint(err),
					separator)
			}
			continue
		}

		// Finally, treat as chat message
		if err := s.handleMessage(input); err != nil {
			fmt.Fprintf(color.Output, "%s%v%s\n",
				separator,
				errorColor.Sprint(err),
				separator)
		}
	}

	return nil
}

func (s *ChatSession) handleToolCommand(input string) error {
	// Parse command and arguments
	parts := strings.Fields(input)
	if len(parts) < 2 {
		return fmt.Errorf("invalid command format")
	}

	cmd := parts[0]
	args := parts[1:]

	// Handle direct tool calls
	switch cmd {
	case "analyze":
		return s.handleDirectAnalyze(args)
	case "verify":
		return s.handleDirectVerify(args)
	case "search":
		return s.handleDirectSearch(args)
	default:
		return fmt.Errorf("unknown command: %s", cmd)
	}
}

func (s *ChatSession) handleMessage(input string) error {
	// Add user message to history
	s.history = append(s.history, openai.ChatCompletionMessage{
		Role:    openai.ChatMessageRoleUser,
		Content: input,
	})

	// Keep getting responses until we get a normal message
	for {
		resp, err := s.client.CreateChatCompletion(
			context.Background(),
			openai.ChatCompletionRequest{
				Model:       openai.GPT4Turbo1106,
				Messages:    s.history,
				Temperature: defaultConfig.Temperature,
				Tools: []openai.Tool{
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "search_supabase_docs",
							Description: "Search Supabase documentation for relevant information",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"query": map[string]interface{}{
										"type":        "string",
										"description": "The search query for the documentation",
									},
									"topic": map[string]interface{}{
										"type":        "string",
										"enum":        []string{"database", "auth", "storage", "edge-functions", "realtime"},
										"description": "The specific topic to search within",
									},
								},
								"required": []string{"query"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "analyze_schema",
							Description: "Analyze database schema including tables, columns, and security policies",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"table": map[string]interface{}{
										"type":        "string",
										"description": "The specific table to analyze, or 'all' to list tables",
									},
								},
								"required": []string{"table"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "analyze_functions",
							Description: "Analyze stored procedures and functions in the database",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"name": map[string]interface{}{
										"type":        "string",
										"description": "The specific function to analyze, or 'all' to list functions",
									},
									"schema": map[string]interface{}{
										"type":        "string",
										"enum":        []string{"public", "auth", "storage", "graphql", "graphql_public"},
										"description": "The schema to search in",
										"default":     "public",
									},
								},
								"required": []string{"name"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "get_cli_help",
							Description: "Get help information for DNA CLI commands",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"command": map[string]interface{}{
										"type":        "string",
										"description": "The command to get help for (e.g., 'db', 'assistant'). Empty for root help.",
									},
								},
								"required": []string{"command"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "create_migration",
							Description: "Create a new empty migration file",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"name": map[string]interface{}{
										"type":        "string",
										"description": "Name for the migration (will be prefixed with timestamp)",
									},
								},
								"required": []string{"name"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "write_migration",
							Description: "Write SQL content to a migration file",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"version": map[string]interface{}{
										"type":        "string",
										"description": "Migration version/timestamp",
									},
									"sql": map[string]interface{}{
										"type":        "string",
										"description": "SQL content to write to the migration file",
									},
								},
								"required": []string{"version", "sql"},
							},
						},
					},
					{
						Type: "function",
						Function: &openai.FunctionDefinition{
							Name:        "apply_migrations",
							Description: "Apply pending migrations to the database",
							Parameters: map[string]interface{}{
								"type": "object",
								"properties": map[string]interface{}{
									"include_all": map[string]interface{}{
										"type":        "boolean",
										"description": "Include all migrations not found on remote history table",
										"default":     false,
									},
								},
							},
						},
					},
				},
			},
		)
		if err != nil {
			// Reset to initial state on error
			s.history = []openai.ChatCompletionMessage{
				{
					Role: openai.ChatMessageRoleSystem,
					Content: `You are a Database Normalization Assistant (DNA) for Supabase.
You help developers design and normalize their database schemas.
You provide guidance on:
1. Database design best practices
2. Normalization (1NF, 2NF, 3NF)
3. Supabase-specific features and optimizations
4. Schema analysis and improvements

Always explain your reasoning and provide examples when relevant.`,
				},
			}
			fmt.Println("Chat history has been reset due to an error.")
			return fmt.Errorf("error getting response: %w", err)
		}

		// If response has no content, reset and return error
		if resp.Choices[0].Message.Content == "" && resp.Choices[0].Message.ToolCalls == nil {
			s.history = []openai.ChatCompletionMessage{
				{
					Role: openai.ChatMessageRoleSystem,
					Content: `You are a Database Normalization Assistant (DNA) for Supabase.
You help developers design and normalize their database schemas.
You provide guidance on:
1. Database design best practices
2. Normalization (1NF, 2NF, 3NF)
3. Supabase-specific features and optimizations
4. Schema analysis and improvements

Always explain your reasoning and provide examples when relevant.`,
				},
			}
			fmt.Println("Chat history has been reset due to empty response.")
			return fmt.Errorf("received empty response from assistant")
		}

		// If no tool calls, we're done
		if resp.Choices[0].Message.ToolCalls == nil {
			s.history = append(s.history, resp.Choices[0].Message)
			fmt.Fprintln(color.Output, separator)
			assistantColor.Fprintln(color.Output, resp.Choices[0].Message.Content)
			fmt.Fprintln(color.Output, separator)
			return nil
		}

		// Handle tool calls
		for _, toolCall := range resp.Choices[0].Message.ToolCalls {
			fmt.Fprintln(color.Output, toolSeparator)
			toolColor.Fprintf(color.Output, "Using tool: %s\n", toolCall.Function.Name)

			result, err := handleToolCall(&toolCall.Function)
			if err != nil {
				return fmt.Errorf("error handling tool call: %w", err)
			}

			toolColor.Fprintln(color.Output, result.Result)
			fmt.Fprintln(color.Output, toolSeparator)

			// Check for null content before adding to history
			toolCallMessage := openai.ChatCompletionMessage{
				Role:      openai.ChatMessageRoleAssistant,
				Content:   "Using tool...",
				ToolCalls: []openai.ToolCall{toolCall},
			}
			toolResponseMessage := openai.ChatCompletionMessage{
				Role:       openai.ChatMessageRoleTool,
				Content:    result.Result,
				Name:       toolCall.Function.Name,
				ToolCallID: toolCall.ID,
			}

			// Only append if content is not empty
			if toolCallMessage.Content != "" {
				s.history = append(s.history, toolCallMessage)
			}
			if toolResponseMessage.Content != "" {
				s.history = append(s.history, toolResponseMessage)
			}
		}
		// Loop continues to get next response
	}
}

// Direct tool handlers
func (s *ChatSession) handleDirectAnalyze(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("table name required")
	}
	result, err := handleToolCall(&openai.FunctionCall{
		Name:      "analyze_schema",
		Arguments: fmt.Sprintf(`{"table":"%s"}`, args[0]),
	})
	if err != nil {
		return err
	}
	toolColor.Fprintln(color.Output, result.Result)
	return nil
}

func (s *ChatSession) handleDirectVerify(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("file name required")
	}
	// TODO: Implement verify logic
	return fmt.Errorf("verify not implemented yet")
}

func (s *ChatSession) handleDirectSearch(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("search query required")
	}
	result, err := handleToolCall(&openai.FunctionCall{
		Name:      "search_supabase_docs",
		Arguments: fmt.Sprintf(`{"query":"%s"}`, args[0]),
	})
	if err != nil {
		return err
	}
	toolColor.Fprintln(color.Output, result.Result)
	return nil
}

// Add a new command to reset the chat
func (s *ChatSession) handleCommand(cmd string, args []string) error {
	switch cmd {
	case "reset":
		s.history = []openai.ChatCompletionMessage{
			{
				Role: openai.ChatMessageRoleSystem,
				Content: `You are a Database Normalization Assistant (DNA) for Supabase.
You help developers design and normalize their database schemas.
You provide guidance on:
1. Database design best practices
2. Normalization (1NF, 2NF, 3NF)
3. Supabase-specific features and optimizations
4. Schema analysis and improvements

Always explain your reasoning and provide examples when relevant.`,
			},
		}
		fmt.Println("Chat history has been reset.")
		return nil
		// ... other commands ...
	}
	return nil
}
