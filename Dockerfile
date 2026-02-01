FROM supabase/postgres:17.6.1.075

ARG TARGETARCH

WORKDIR /app
COPY dist/supabase_linux_${TARGETARCH}/supabase /usr/local/bin/
CMD ["supabase", "start", "--native"]
# CMD ["sleep", "600"]

STOPSIGNAL SIGINT
