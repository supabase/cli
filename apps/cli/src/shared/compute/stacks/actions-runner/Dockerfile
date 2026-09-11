FROM public.ecr.aws/docker/library/ubuntu:24.04

# GitHub rejects runners that fall too far behind, and a JIT runner cannot
# self-update: bump this and push to move the pool onto a new release.
ARG RUNNER_VERSION=2.337.0

ENV DEBIAN_FRONTEND=noninteractive \
    RUNNER_HOME=/home/runner/actions-runner \
    RUNNER_WORK_DIR=/home/runner/_work \
    RUNNER_STATE_FILE=/home/runner/state.json

# Beyond what workflows reach for (curl, git, jq), these are the runner's own
# .NET dependencies, installed ahead of installdependencies.sh so they cache.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        gnupg \
        jq \
        libicu74 \
        libkrb5-3 \
        liblttng-ust1t64 \
        libssl3t64 \
        openssl \
        python3 \
        sudo \
        tar \
        unzip \
        util-linux \
        zip \
        zstd \
    && rm -rf /var/lib/apt/lists/*

# ubuntu:24.04 ships a stock uid-1000 `ubuntu` user; reclaim it for `runner`.
RUN userdel -r ubuntu 2>/dev/null || true \
    && useradd -m -s /bin/bash runner \
    && echo 'runner ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/runner \
    && chmod 0440 /etc/sudoers.d/runner

RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
        amd64) runner_arch=x64 ;; \
        arm64) runner_arch=arm64 ;; \
        *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    mkdir -p "$RUNNER_HOME"; \
    curl -fsSL -o /tmp/runner.tar.gz \
        "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz"; \
    tar -xzf /tmp/runner.tar.gz -C "$RUNNER_HOME"; \
    rm /tmp/runner.tar.gz; \
    "$RUNNER_HOME/bin/installdependencies.sh"; \
    mkdir -p "$RUNNER_WORK_DIR"; \
    chown -R runner:runner /home/runner

COPY entrypoint.sh /srv/entrypoint.sh
COPY health.py /srv/health.py
RUN chmod 0755 /srv/entrypoint.sh /srv/health.py

USER runner
WORKDIR /home/runner

CMD ["/srv/entrypoint.sh"]
