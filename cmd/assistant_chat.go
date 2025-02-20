package cmd

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/fatih/color"
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

		switch input {
		case "exit", "quit":
			handleChatResponse("exit")
			s.isActive = false
			continue
		case "help":
			handleChatResponse("help")
			continue
		case "clear":
			s.history = s.history[:1] // Keep only the system message
			fmt.Fprintln(color.Output, bannerColor.Sprint("Chat history cleared."))
			continue
		default:
			if err := s.handleMessage(input); err != nil {
				fmt.Fprintf(color.Output, "%s%v%s\n",
					separator,
					errorColor.Sprint(err),
					separator)
			}
		}
	}

	return nil
}

func (s *ChatSession) handleMessage(input string) error {
	// Keep only connection string debug
	// Add user message to history
	s.history = append(s.history, openai.ChatCompletionMessage{
		Role:    openai.ChatMessageRoleUser,
		Content: input,
	})

	// Get response from OpenAI
	resp, err := s.client.CreateChatCompletion(
		context.Background(),
		openai.ChatCompletionRequest{
			Model:       defaultConfig.Model,
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
			},
		},
	)
	if err != nil {
		return fmt.Errorf("error getting response: %w", err)
	}

	// Handle tool calls if any
	if resp.Choices[0].Message.ToolCalls != nil {
		for _, toolCall := range resp.Choices[0].Message.ToolCalls {
			fmt.Fprintln(color.Output, toolSeparator)
			toolColor.Fprintf(color.Output, "Using tool: %s\n", toolCall.Function.Name)

			result, err := handleToolCall(&toolCall.Function)
			if err != nil {
				return fmt.Errorf("error handling tool call: %w", err)
			}

			toolColor.Fprintln(color.Output, result.Result)
			fmt.Fprintln(color.Output, toolSeparator)

			// Add the tool call to history
			s.history = append(s.history, openai.ChatCompletionMessage{
				Role:    openai.ChatMessageRoleAssistant,
				Content: "Analyzing schema...",
				ToolCalls: []openai.ToolCall{
					{
						ID:   toolCall.ID,
						Type: toolCall.Type,
						Function: openai.FunctionCall{
							Name:      toolCall.Function.Name,
							Arguments: toolCall.Function.Arguments,
						},
					},
				},
			})

			// Add the tool response to history
			s.history = append(s.history, openai.ChatCompletionMessage{
				Role:       openai.ChatMessageRoleTool,
				Content:    result.Result,
				Name:       toolCall.Function.Name,
				ToolCallID: toolCall.ID,
			})

			// Instead of recursing with empty string, get a new completion
			resp, err := s.client.CreateChatCompletion(
				context.Background(),
				openai.ChatCompletionRequest{
					Model:       defaultConfig.Model,
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
					},
				},
			)
			if err != nil {
				return fmt.Errorf("error getting response after tool call: %w", err)
			}

			// Add the final response to history
			s.history = append(s.history, resp.Choices[0].Message)
			fmt.Fprintln(color.Output, separator)
			assistantColor.Fprintln(color.Output, resp.Choices[0].Message.Content)
			fmt.Fprintln(color.Output, separator)
			return nil
		}
	}

	// Normal response handling
	assistantMsg := resp.Choices[0].Message
	s.history = append(s.history, assistantMsg)
	fmt.Fprintln(color.Output, separator)
	assistantColor.Fprintln(color.Output, assistantMsg.Content)
	fmt.Fprintln(color.Output, separator)

	return nil
}
