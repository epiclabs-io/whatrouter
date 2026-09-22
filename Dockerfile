# WhatRouter — Hermes Relay connector for WhatsApp.
#
#   docker build -t whatrouter:local .
#   docker run --rm -v "$PWD/config.yaml:/data/config.yaml:ro" whatrouter:local check-config
#   docker run --rm -it -v whatrouter-data:/data whatrouter:local pair
#   docker run -d -p 8466:8466 -v whatrouter-data:/data whatrouter:local
#
# The config lives in the volume at /data/config.yaml ($WHATROUTER_CONFIG).

# --------------------------------------------------------------------- build
FROM node:24-bookworm-slim AS build

WORKDIR /app

# Dependencies first so the layer survives source edits.
# No --ignore-scripts: esbuild (Vite) wants its install script. npm 11.19+
# defers the two unapproved ones and says so; both are no-ops here (Baileys'
# preinstall only checks the Node major, protobufjs' postinstall only warns
# about version schemes), so the tree is complete either way. Add
# `--allow-scripts @whiskeysockets/baileys --allow-scripts protobufjs` to
# silence the warning. sharp comes from its prebuilt @img/sharp-linux-*
# optional package, so no python/make/g++ is needed in this image.
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY . .
RUN npm run build

# ------------------------------------------------------------------- runtime
FROM node:24-bookworm-slim AS runtime

# Pass --build-arg SOURCE_URL=<repo url> to stamp the source into the image.
ARG SOURCE_URL=""
LABEL org.opencontainers.image.title="whatrouter" \
      org.opencontainers.image.description="Hermes Relay connector for WhatsApp: one WhatsApp account multiplexed to N Hermes instances" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="$SOURCE_URL"

# ffmpeg: transcodes agent voice replies to ogg/opus so they arrive as real
#         WhatsApp voice notes instead of audio attachments.
# tini:   PID 1 that forwards SIGTERM to node and reaps zombies.
# ffmpeg is most of the image (~465 MB): Debian's build hard-depends on
# libmfx1/mesa/llvm. Dropping it would cost native voice notes; a static
# ffmpeg or an alpine base is the only way lower, both with their own costs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates tini \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/config.example.yaml ./config.example.yaml

ENV NODE_ENV=production \
    WHATROUTER_CONFIG=/data/config.yaml

# wa-auth/, whatrouter.sqlite and media/ live here.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8466

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8466/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["tini", "--", "node", "dist/whatrouter.js"]
CMD ["serve"]
