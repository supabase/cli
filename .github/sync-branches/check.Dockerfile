# Runs the repository's quality checks on a merged tree; mise provisions the tools its mise.toml pins.
FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=jdxcode/mise@sha256:43da01dfa58171bbe62bd033b557007b2268d61ec06d24378e6d06307faa6f1e /usr/local/bin/mise /usr/local/bin/mise
