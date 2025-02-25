package langchain

import (
	"context"
	"fmt"
	"time"

	"github.com/tmc/langchaingo/llms"
	"github.com/tmc/langchaingo/llms/openai"
	"github.com/tmc/langchaingo/schema"
)

// Metrics tracks usage and performance metrics
type Metrics struct {
	Tokens        int
	PromptTokens  int
	ResponseTime  time.Duration
	TotalRequests int
	Errors        int
}

// Provider wraps LangChain functionality with metrics
type Provider struct {
	llm     llms.LLM
	metrics *Metrics
}

// NewProvider creates a new LangChain provider with the given API key
func NewProvider(apiKey string) (*Provider, error) {
	llm, err := openai.NewChat(openai.WithToken(apiKey))
	if err != nil {
		return nil, fmt.Errorf("failed to create LangChain client: %w", err)
	}

	return &Provider{
		llm:     llm,
		metrics: &Metrics{},
	}, nil
}

// GetResponse generates a response using LangChain with metrics
func (p *Provider) GetResponse(ctx context.Context, messages []schema.ChatMessage) (string, error) {
	start := time.Now()
	p.metrics.TotalRequests++

	completion, err := p.llm.Call(ctx, messages)
	if err != nil {
		p.metrics.Errors++
		return "", fmt.Errorf("LangChain call failed: %w", err)
	}

	p.metrics.ResponseTime = time.Since(start)
	// Note: Token counting would be implemented here

	return completion, nil
}

// GetMetrics returns the current metrics
func (p *Provider) GetMetrics() Metrics {
	return *p.metrics
}
