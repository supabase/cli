# Runs the repository's quality checks on a merged tree; mise provisions the tools its mise.toml pins.
FROM node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY --from=jdxcode/mise@sha256:43da01dfa58171bbe62bd033b557007b2268d61ec06d24378e6d06307faa6f1e /usr/local/bin/mise /usr/local/bin/mise
