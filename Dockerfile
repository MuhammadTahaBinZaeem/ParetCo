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
COPY server.js start.js ./
COPY ui/ ./ui/
COPY ai_features/ ./ai_features/
COPY paretoco-engine-release/ ./paretoco-engine-release/
COPY benchmarks/ ./benchmarks/

# Keep one known-good native fixture in the production image. start.js runs it
# asynchronously after boot so Render logs prove whether Wine can execute the
# exact packaged solver independently of web-generated input files.
COPY tests/fixtures/generated/run_0/ ./tests/fixtures/generated/run_0/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    PARETOCO_REQUIRE_NATIVE=true \
    PARETOCO_ENGINE=/app/paretoco-engine-release/paretoco-engine.exe \
    WINEDEBUG=-all,err+all \
    PARETOCO_WINEDEBUG=-all,err+all \
    WINEARCH=win64 \
    WINEPREFIX=/tmp/paretoco-wine

EXPOSE 10000

# Initialize a writable 64-bit Wine prefix, then start the diagnostic bootstrap.
CMD ["sh", "-c", "mkdir -p \"$WINEPREFIX\"; wineboot -u >/dev/null 2>&1 || true; exec node start.js"]
