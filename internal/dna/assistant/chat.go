package assistant

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"strings"

	"github.com/supabase/cli/internal/dna/langchain"
	"github.com/tmc/langchaingo/llms/openai"
)

func printWelcomeMessage() {
	fmt.Println("Welcome to DNA Assistant! Available commands:")
	fmt.Println("  exit    - Exit the chat session")
	fmt.Println("  help    - Show this help message")
	fmt.Println("  clear   - Clear the screen")
	fmt.Println("\nType your questions about database design, normalization, or Supabase.")
	fmt.Println("I'll use my knowledge base to provide detailed answers.")
	fmt.Println("\nType 'exit' when you're done.")
}

func handleCommand(cmd string) bool {
	switch cmd {
	case "exit":
		fmt.Println("Goodbye!")
		return true
	case "help":
		printWelcomeMessage()
	case "clear":
		fmt.Print("\033[H\033[2J")
	}
	return false
}

func Chat() error {
	apiKey := os.Getenv("DNA_API_KEY")
	if apiKey == "" {
		return fmt.Errorf("DNA_API_KEY environment variable not set")
	}

	// Initialize OpenAI LLM
	llm, err := openai.New()
	if err != nil {
		return fmt.Errorf("failed to initialize OpenAI: %w", err)
	}

	// Initialize RAG system
	rag, err := langchain.NewRAG(apiKey)
	if err != nil {
		return fmt.Errorf("failed to initialize RAG: %w", err)
	}

	printWelcomeMessage()

	scanner := bufio.NewScanner(os.Stdin)
	ctx := context.Background()

	for {
		fmt.Print("\nYou: ")
		if !scanner.Scan() {
			break
		}

		input := strings.TrimSpace(scanner.Text())
		if input == "" {
			continue
		}

		if handleCommand(input) {
			break
		}

		// Use RAG to get response
		response, err := rag.Query(ctx, input, llm)
		if err != nil {
			fmt.Printf("Error: %v\n", err)
			continue
		}

		fmt.Printf("\nAssistant: %s\n", response)
	}

	return scanner.Err()
}
