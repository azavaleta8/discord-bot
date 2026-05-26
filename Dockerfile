# Debian-slim (not Alpine): native audio modules (@discordjs/opus, sodium-native)
# compile reliably against glibc. Node 22: @discordjs/voice 0.19+ requires >=22.12.
FROM node:22-bookworm-slim

# FFmpeg for OGG/Opus encoding; build toolchain for native module compilation.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci

# Build the TypeScript sources.
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

ENV NODE_ENV=production

# The host injects PORT at runtime; the keep-alive server binds 0.0.0.0:$PORT.
CMD ["node", "dist/index.js"]
