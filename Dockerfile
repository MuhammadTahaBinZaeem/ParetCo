# ParetoCo production image
# The packaged native solver is a 64-bit Windows executable; Render runs Linux,
# so Wine executes the exact same binary without modifying it.
FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       wine \
       wine64 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY ai_features/package.json ai_features/package-lock.json ./ai_features/
RUN npm ci --omit=dev --prefix ./ai_features

COPY package.json package-lock.json ./
COPY server.js ./
COPY server/ ./server/
COPY ui/ ./ui/
COPY ai_features/ ./ai_features/
COPY paretoco-engine-release/ ./paretoco-engine-release/
COPY benchmarks/ ./benchmarks/

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    PARETOCO_REQUIRE_NATIVE=true \
    PARETOCO_ENGINE=/app/paretoco-engine-release/paretoco-engine.exe \
    PARETOCO_WINEDEBUG=-all,err+all \
    PARETOCO_NATIVE_TIMEOUT_MS=60000 \
    PARETOCO_NATIVE_VERIFY_TIMEOUT_MS=35000 \
    PARETOCO_UNSAT_MAX_TESTS=16 \
    PARETOCO_MAX_REQUEST_BODY_BYTES=2097152 \
    WINEARCH=win64 \
    WINEPREFIX=/tmp/paretoco-wine

EXPOSE 10000

# Wine prefix setup is environment initialization, not application source mutation.
# The Node process starts directly from the checked-in modular server source.
CMD ["sh", "-c", "mkdir -p \"$WINEPREFIX\"; wineboot -u >/dev/null 2>&1 || true; exec node server.js"]
