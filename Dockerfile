# CI supplies static musl binaries, so multi-arch buildx only assembles layers.
#
# This is the BASE variant: no Chromium, so `/.runtime/*` returns 503.
# `Dockerfile.runtime-api` layers Chromium on top to enable the runtime API.
#
# Published by `.github/workflows/ci.yml`.

FROM alpine:latest

ARG TARGETARCH

RUN apk add --no-cache git curl bash tini openssh-client

ENV SB_HOSTNAME=0.0.0.0 \
    SB_FOLDER=/space \
    SB_PORT=3000

EXPOSE 3000
HEALTHCHECK CMD curl --fail "http://localhost:$SB_PORT/.instance" || exit 1

# Remove stock accounts so arbitrary PUID/PGID values cannot collide.
RUN echo "" > /etc/group && echo "root:x:0:0:root:/root:/bin/sh" > /etc/passwd

# Drops privileges to PUID/PGID (defaulting to the owner of $SB_FOLDER) and
# runs /space/CONTAINER_BOOT.md if present.
ADD ./docker-entrypoint.sh /docker-entrypoint.sh

COPY silverbullet-${TARGETARCH} /silverbullet
RUN chmod +x /silverbullet /docker-entrypoint.sh

# Extra args (e.g. `--user me:letmein`) are appended to the binary invocation.
ENTRYPOINT ["/sbin/tini", "--", "/docker-entrypoint.sh"]
