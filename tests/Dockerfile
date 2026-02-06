FROM ubuntu:24.04

RUN apt-get update && apt-get install -y \
    curl git ruby build-essential \
    && rm -rf /var/lib/apt/lists/*

RUN useradd -ms /bin/bash postgres && \
    usermod -aG sudo postgres
USER postgres
WORKDIR /home/postgres

# https://docs.brew.sh/Installation#alternative-installs
RUN mkdir homebrew && curl -L https://github.com/Homebrew/brew/tarball/main | tar xz --strip-components 1 -C homebrew

RUN git config --global user.name 'Qiao' && \
    git config --global user.email 'qiao@supabase.io' && \
    /home/postgres/homebrew/bin/brew tap-new qiao/homebrew-tap

ADD --chown=postgres https://raw.githubusercontent.com/supabase/homebrew-tap/refs/heads/native-beta/supabase-beta.rb \
    /home/postgres/homebrew/Library/Taps/qiao/homebrew-tap/Formula/supabase-beta.rb

RUN /home/postgres/homebrew/bin/brew install qiao/tap/supabase-beta

ENV LD_LIBRARY_PATH=/home/postgres/homebrew/Cellar/supabase-beta/2.75.3/lib
ENTRYPOINT ["/home/postgres/homebrew/Cellar/supabase-beta/2.75.3/share/supabase-cli/bin/supabase-postgres-init.sh"]
