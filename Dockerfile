# ParetoCo Render image
# The production solver is a packaged 64-bit Windows executable. Render runs
# Linux containers, so Wine is installed and used to execute that same binary.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       wine \
       wine64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install only the dependencies used by the integrated Featherless features.
COPY ai_features/package.json ai_features/package-lock.json ./ai_features/
RUN npm ci --omit=dev --prefix ./ai_features

COPY package.json package-lock.json ./
COPY server.js ./
COPY ui/ ./ui/
COPY ai_features/ ./ai_features/
COPY paretoco-engine-release/ ./paretoco-engine-release/
COPY benchmarks/ ./benchmarks/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    PARETOCO_REQUIRE_NATIVE=true \
    PARETOCO_ENGINE=/app/paretoco-engine-release/paretoco-engine.exe \
    WINEDEBUG=-all \
    WINEARCH=win64 \
    WINEPREFIX=/tmp/paretoco-wine

EXPOSE 10000

# Initialize a writable 64-bit Wine prefix, then start the Node bridge.
CMD ["sh", "-c", "mkdir -p \"$WINEPREFIX\"; wineboot -u >/dev/null 2>&1 || true; exec node server.js"]
