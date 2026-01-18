# Embedded Mail Server

An embedded SMTP server for local email testing in the Supabase CLI. This package replaces the Docker-based inbucket/mailpit container, allowing users to test email functionality without running Docker.

## Features

- **SMTP Server**: Receives emails sent by local services (auth confirmations, password resets, etc.)
- **File-based Storage**: Emails stored as `.eml` files that can be opened in any email client
- **Simple API**: List mailboxes, read emails, delete emails programmatically
- **Zero Dependencies on Docker**: Runs natively in the CLI process
- **Integrated with `supabase start`**: Default email provider for local development

## Usage with Supabase CLI

The embedded mail server is the **default** email provider when running `supabase start`. No additional configuration is needed.

```bash
# Start Supabase with embedded mail server (default)
supabase start

# Emails are stored in .supabase/mail/
# Stop with Ctrl+C or from another terminal:
supabase stop
```

### Switching to Docker-based Mailpit

If you prefer the Docker-based Mailpit (with web UI), set the provider in `config.toml`:

```toml
[inbucket]
enabled = true
provider = "mailpit"  # Use Docker-based Mailpit instead of embedded
port = 54324          # Web UI port
```

## Configuration

### Environment Variable

Set `SUPABASE_MAIL_PATH` to customize where emails are stored:

```bash
export SUPABASE_MAIL_PATH=/path/to/mail/storage
```

If not set, emails are stored in `.supabase/mail` relative to the current working directory.

### Programmatic Configuration

```go
server, err := mail.NewServer(mail.Config{
    Host:        "127.0.0.1",  // Default: 127.0.0.1
    Port:        54325,        // Default: 54325
    StoragePath: "/custom/path", // Default: $SUPABASE_MAIL_PATH or .supabase/mail
})
```

## Usage

### Starting the Server

```go
package main

import (
    "context"
    "log"

    "github.com/supabase/cli/pkg/mail"
)

func main() {
    // Create server with default config
    server, err := mail.NewServer(mail.Config{})
    if err != nil {
        log.Fatal(err)
    }

    // Start server (blocks until context is cancelled)
    ctx, cancel := context.WithCancel(context.Background())
    defer cancel()

    go func() {
        if err := server.Start(ctx); err != nil && err != context.Canceled {
            log.Printf("Server error: %v", err)
        }
    }()

    // Server is now running on 127.0.0.1:54325
    log.Printf("Mail server listening on %s", server.Addr())

    // ... your application logic ...

    // Stop server
    cancel()
}
```

### Sending Test Emails

Configure your application to send emails to the local SMTP server:

```
SMTP Host: 127.0.0.1
SMTP Port: 54325
Authentication: None required
TLS: Disabled
```

For Supabase Auth (GoTrue), set these environment variables:

```bash
GOTRUE_SMTP_HOST=127.0.0.1
GOTRUE_SMTP_PORT=54325
GOTRUE_SMTP_USER=
GOTRUE_SMTP_PASS=
GOTRUE_SMTP_ADMIN_EMAIL=admin@localhost
```

### Reading Emails via API

```go
// List all mailboxes (recipient addresses)
mailboxes, err := server.ListMailboxes()
// Returns: ["user@example.com", "another@example.com"]

// List emails in a mailbox
emails, err := server.ListEmails("user@example.com")
// Returns: []EmailSummary with ID, From, To, Subject, Date, Size

// Get full email content
email, err := server.GetEmail("user@example.com", emails[0].ID)
// Returns: *Email with TextBody, HTMLBody, Raw, and all summary fields

// Delete an email
err = server.DeleteEmail("user@example.com", emails[0].ID)

// Delete entire mailbox
err = server.DeleteMailbox("user@example.com")
```

## Storage Format

Emails are stored as standard `.eml` files organized by recipient:

```
$SUPABASE_MAIL_PATH/
├── user@example.com/
│   ├── 1704067200000000000-1.eml
│   └── 1704067260000000000-2.eml
└── admin@example.com/
    └── 1704067300000000000-1.eml
```

### File Naming

- Format: `{unix-nano-timestamp}-{counter}.eml`
- Example: `1704067200000000000-1.eml`

### Viewing Emails

The `.eml` format is a standard email format. You can:

1. **Open directly** in email clients (Outlook, Thunderbird, Apple Mail)
2. **View as text** - they're human-readable RFC 5322 formatted files
3. **Use the API** - programmatically read via `GetEmail()`

## API Reference

### Types

```go
// Config holds configuration for the mail server.
type Config struct {
    Host        string // Hostname to bind (default: "127.0.0.1")
    Port        uint16 // Port to bind (default: 54325)
    StoragePath string // Storage directory (default: $SUPABASE_MAIL_PATH or .supabase/mail)
}

// EmailSummary contains summary information about an email.
type EmailSummary struct {
    ID      string    `json:"id"`
    From    string    `json:"from"`
    To      []string  `json:"to"`
    Subject string    `json:"subject"`
    Date    time.Time `json:"date"`
    Size    int64     `json:"size"`
}

// Email contains the full email content and metadata.
type Email struct {
    EmailSummary
    TextBody string `json:"text_body"`
    HTMLBody string `json:"html_body"`
    Raw      []byte `json:"raw"`
}
```

### Server Methods

| Method | Description |
|--------|-------------|
| `NewServer(Config) (*Server, error)` | Create a new mail server |
| `Start(context.Context) error` | Start the SMTP server (blocks) |
| `Stop() error` | Stop the SMTP server |
| `Addr() string` | Get the server's listening address |
| `ListMailboxes() ([]string, error)` | List all recipient mailboxes |
| `ListEmails(mailbox string) ([]EmailSummary, error)` | List emails in a mailbox |
| `GetEmail(mailbox, id string) (*Email, error)` | Get full email by ID |
| `DeleteEmail(mailbox, id string) error` | Delete an email |
| `DeleteMailbox(mailbox string) error` | Delete all emails in a mailbox |

## Dependencies

- [github.com/emersion/go-smtp](https://github.com/emersion/go-smtp) - SMTP server implementation
- [github.com/jhillyerd/enmime](https://github.com/jhillyerd/enmime) - MIME email parsing

## Testing

Run the package tests:

```bash
go test -v ./pkg/mail/...
```

The test suite includes:
- Unit tests for storage operations
- Unit tests for email parsing
- Integration tests for SMTP functionality

## Comparison with Docker-based Solution

| Feature | Embedded Server | Docker (mailpit) |
|---------|-----------------|------------------|
| Docker required | No | Yes |
| Startup time | Instant | Seconds |
| Resource usage | Minimal | Container overhead |
| Web UI | No | Yes |
| File access | Direct `.eml` files | Via API only |
| POP3 support | No | Yes |

## Future Improvements

- [ ] Optional web UI for viewing emails
- [ ] Email retention/cleanup policies
- [ ] Support for attachments in API responses
