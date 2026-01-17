// Package mail provides an embedded SMTP server for local email testing.
// It stores received emails as .eml files on disk, organized by recipient mailbox.
package mail

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/emersion/go-smtp"
)

// DefaultMailPath is the default path for storing emails if SUPABASE_MAIL_PATH is not set.
const DefaultMailPath = ".supabase/mail"

// Server provides an embedded SMTP server for local email testing.
type Server struct {
	smtpServer *smtp.Server
	storage    *Storage
	listener   net.Listener
	host       string
	port       uint16
	mu         sync.Mutex
	running    bool
}

// EmailSummary contains summary information about an email.
type EmailSummary struct {
	ID        string    `json:"id"`
	From      string    `json:"from"`
	To        []string  `json:"to"`
	Subject   string    `json:"subject"`
	Date      time.Time `json:"date"`
	Size      int64     `json:"size"`
}

// Email contains the full email content and metadata.
type Email struct {
	EmailSummary
	TextBody string   `json:"text_body"`
	HTMLBody string   `json:"html_body"`
	Raw      []byte   `json:"raw"`
}

// Config holds configuration for the mail server.
type Config struct {
	// Host is the hostname to bind the SMTP server to.
	Host string
	// Port is the port to bind the SMTP server to.
	Port uint16
	// StoragePath is the directory to store emails in.
	// If empty, uses SUPABASE_MAIL_PATH env var or DefaultMailPath.
	StoragePath string
}

// NewServer creates a new mail server with the given configuration.
func NewServer(cfg Config) (*Server, error) {
	storagePath := cfg.StoragePath
	if storagePath == "" {
		storagePath = os.Getenv("SUPABASE_MAIL_PATH")
	}
	if storagePath == "" {
		storagePath = DefaultMailPath
	}

	// Convert to absolute path if relative
	if !filepath.IsAbs(storagePath) {
		cwd, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("failed to get working directory: %w", err)
		}
		storagePath = filepath.Join(cwd, storagePath)
	}

	storage, err := NewStorage(storagePath)
	if err != nil {
		return nil, fmt.Errorf("failed to create storage: %w", err)
	}

	host := cfg.Host
	if host == "" {
		host = "127.0.0.1"
	}

	port := cfg.Port
	if port == 0 {
		port = 54325
	}

	s := &Server{
		storage: storage,
		host:    host,
		port:    port,
	}

	return s, nil
}

// Start starts the SMTP server and blocks until the context is cancelled.
func (s *Server) Start(ctx context.Context) error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return fmt.Errorf("server is already running")
	}

	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		s.mu.Unlock()
		return fmt.Errorf("failed to listen on %s: %w", addr, err)
	}
	s.listener = listener

	backend := &smtpBackend{storage: s.storage}
	s.smtpServer = smtp.NewServer(backend)
	s.smtpServer.Addr = addr
	s.smtpServer.Domain = "localhost"
	s.smtpServer.AllowInsecureAuth = true
	s.smtpServer.MaxMessageBytes = 25 * 1024 * 1024 // 25 MB
	s.smtpServer.MaxRecipients = 100
	s.smtpServer.ReadTimeout = 60 * time.Second
	s.smtpServer.WriteTimeout = 60 * time.Second

	s.running = true
	s.mu.Unlock()

	// Start serving in a goroutine
	errCh := make(chan error, 1)
	go func() {
		errCh <- s.smtpServer.Serve(listener)
	}()

	// Wait for context cancellation or server error
	select {
	case <-ctx.Done():
		s.Stop()
		return ctx.Err()
	case err := <-errCh:
		s.mu.Lock()
		s.running = false
		s.mu.Unlock()
		return err
	}
}

// Stop stops the SMTP server.
func (s *Server) Stop() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return nil
	}

	var err error
	if s.smtpServer != nil {
		err = s.smtpServer.Close()
	}
	if s.listener != nil {
		s.listener.Close()
	}
	s.running = false
	return err
}

// Addr returns the address the server is listening on.
func (s *Server) Addr() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.listener != nil {
		return s.listener.Addr().String()
	}
	return fmt.Sprintf("%s:%d", s.host, s.port)
}

// ListMailboxes returns a list of all mailbox addresses that have received emails.
func (s *Server) ListMailboxes() ([]string, error) {
	return s.storage.ListMailboxes()
}

// ListEmails returns a list of email summaries for the given mailbox.
func (s *Server) ListEmails(mailbox string) ([]EmailSummary, error) {
	return s.storage.ListEmails(mailbox)
}

// GetEmail returns the full email content for the given mailbox and email ID.
func (s *Server) GetEmail(mailbox, id string) (*Email, error) {
	return s.storage.GetEmail(mailbox, id)
}

// DeleteEmail deletes the email with the given ID from the mailbox.
func (s *Server) DeleteEmail(mailbox, id string) error {
	return s.storage.DeleteEmail(mailbox, id)
}

// DeleteMailbox deletes all emails in the given mailbox.
func (s *Server) DeleteMailbox(mailbox string) error {
	return s.storage.DeleteMailbox(mailbox)
}
