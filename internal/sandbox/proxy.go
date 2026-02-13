package sandbox

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"
)

// ProxyConfig holds the configuration for the reverse proxy.
type ProxyConfig struct {
	ListenPort         int
	GoTruePort         int
	PostgRESTPort      int
	PostgRESTAdminPort int
	ServiceRoleKey     string
	ServiceRoleJWT     string
	AnonKey            string
	AnonJWT            string
}

// RunProxy starts the reverse proxy server and blocks until shutdown signal.
// This is the entry point called by the _proxy CLI command.
func RunProxy(config *ProxyConfig) error {
	mux := http.NewServeMux()

	// Health check endpoint
	mux.HandleFunc("/health", healthHandler)

	// Auth open endpoints (no auth transformation)
	// These must be registered before /auth/v1/ to take precedence
	mux.Handle("/auth/v1/verify", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))
	mux.Handle("/auth/v1/verify/", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))
	mux.Handle("/auth/v1/callback", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))
	mux.Handle("/auth/v1/callback/", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))
	mux.Handle("/auth/v1/authorize", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))
	mux.Handle("/auth/v1/authorize/", newProxyHandler(config, config.GoTruePort, "/auth/v1", false))

	// Auth protected endpoints (with auth transformation)
	mux.Handle("/auth/v1/", newProxyHandler(config, config.GoTruePort, "/auth/v1", true))

	// REST API (with auth transformation)
	mux.Handle("/rest/v1/", newProxyHandler(config, config.PostgRESTPort, "/rest/v1", true))

	// REST Admin API (no auth transformation)
	mux.Handle("/rest-admin/v1/", newProxyHandler(config, config.PostgRESTAdminPort, "/rest-admin/v1", false))

	// Wrap with CORS middleware
	handler := corsMiddleware(mux)

	server := &http.Server{
		Addr:    fmt.Sprintf("127.0.0.1:%d", config.ListenPort),
		Handler: handler,
	}

	// Set up signal handling for graceful shutdown
	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-sigChan
		fmt.Fprintln(os.Stderr, "Shutting down proxy...")
		server.Shutdown(context.Background())
	}()

	// Start listening
	ln, err := net.Listen("tcp", server.Addr)
	if err != nil {
		return fmt.Errorf("failed to listen on %s: %w", server.Addr, err)
	}

	fmt.Fprintf(os.Stderr, "Proxy listening on %s\n", server.Addr)
	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		return err
	}

	return nil
}

// newProxyHandler creates a reverse proxy handler for a backend service.
func newProxyHandler(config *ProxyConfig, targetPort int, stripPrefix string, transformAuth bool) http.Handler {
	target := &url.URL{
		Scheme: "http",
		Host:   fmt.Sprintf("127.0.0.1:%d", targetPort),
	}

	proxy := httputil.NewSingleHostReverseProxy(target)

	// Customize the director to handle path rewriting and headers
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)

		// Strip the prefix from the path
		// e.g., /auth/v1/token -> /token
		if stripPrefix != "" {
			req.URL.Path = strings.TrimPrefix(req.URL.Path, stripPrefix)
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
			// Also update RawPath if set
			if req.URL.RawPath != "" {
				req.URL.RawPath = strings.TrimPrefix(req.URL.RawPath, stripPrefix)
				if req.URL.RawPath == "" {
					req.URL.RawPath = "/"
				}
			}
		}

		// Add proxy headers
		clientIP := getClientIP(req)
		req.Header.Set("X-Real-IP", clientIP)

		if prior := req.Header.Get("X-Forwarded-For"); prior != "" {
			req.Header.Set("X-Forwarded-For", prior+", "+clientIP)
		} else {
			req.Header.Set("X-Forwarded-For", clientIP)
		}

		req.Header.Set("X-Forwarded-Proto", "http")

		// Transform Authorization header if needed
		if transformAuth {
			transformAuthorization(req, config)
		}
	}

	// Customize error handler
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		fmt.Fprintf(os.Stderr, "Proxy error: %v\n", err)
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte(fmt.Sprintf("Proxy error: %v", err)))
	}

	return proxy
}

// transformAuthorization applies the apikey to JWT transformation.
// This replicates the logic from nginx.conf.tmpl.
func transformAuthorization(req *http.Request, config *ProxyConfig) {
	auth := req.Header.Get("Authorization")
	apikey := req.Header.Get("apikey")

	// If Authorization header exists and is NOT a legacy "Bearer sb_*" token, keep it
	if auth != "" && !strings.HasPrefix(auth, "Bearer sb_") {
		return
	}

	// Map apikey to JWT
	switch apikey {
	case config.ServiceRoleKey:
		req.Header.Set("Authorization", "Bearer "+config.ServiceRoleJWT)
	case config.AnonKey:
		req.Header.Set("Authorization", "Bearer "+config.AnonJWT)
	default:
		// If apikey is present but not recognized, pass it through as Authorization
		if apikey != "" {
			req.Header.Set("Authorization", apikey)
		}
	}
}

// corsMiddleware wraps a handler with CORS headers.
// This replicates the CORS configuration from nginx.conf.tmpl.
func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Set CORS headers on all responses
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, apikey, X-Client-Info")
		w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Range")
		w.Header().Set("Access-Control-Max-Age", "86400")

		// Handle preflight requests
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// healthHandler returns 200 OK for health checks.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain")
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("OK"))
}

// getClientIP extracts the client IP from the request.
func getClientIP(req *http.Request) string {
	// RemoteAddr has the format "IP:port"
	ip, _, err := net.SplitHostPort(req.RemoteAddr)
	if err != nil {
		return req.RemoteAddr
	}
	return ip
}
