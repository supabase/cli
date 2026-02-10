# 0010. Process Manager Architecture

**Status**: proposed
**Date**: 2026-02-10

## Problem Statement

ADR 0004 identifies the process manager as "significant infrastructure to build and maintain" for the local-first workflow. `PLAN_PROCESS_COMPOSE.md` exists as an implementation plan but isn't part of the ADR system.

The plan ports a subset of process-compose (Go) to TypeScript. Scope includes: HTTP API server, log output, start/stop/status/shutdown. Explicitly excludes: TUI, WebSocket streaming, scaling, namespaces, scheduling, hot-reload.

## Key Decisions to Cover

- **Why port process-compose to TypeScript** instead of: (a) using the Go binary directly, (b) using Docker Compose, (c) building from scratch without process-compose's model
- **Process lifecycle**: YAML config format, dependency resolution (`depends_on` with `process_healthy` / `process_completed_successfully`), readiness probes (exec, HTTP GET)
- **Signal handling**: How SIGTERM/SIGINT propagate to child processes, graceful shutdown ordering
- **HTTP API**: Endpoints, what `supa dev` calls, how the TUI (React-Ink) connects to it
- **Logging**: Per-process log files, log rotation, how logs surface in the TUI
- **Health checks**: Probe types, intervals, failure thresholds, restart policies
- **Embedded binaries vs Docker containers**: How native binaries and Docker containers coexist

## Related Decisions

- [ADR 0004](0004-cli-design-goals-and-workflows.md): CLI Design Goals — local-first workflow, `supa dev` orchestrator
- [ADR 0007](0007-realtime-progress-in-command-handlers.md): Real-time Progress — progress reporting from process manager phases

## See Also

- [PLAN_PROCESS_COMPOSE.md](../../PLAN_PROCESS_COMPOSE.md): Detailed implementation plan
