FROM debian:bookworm-slim AS untrunc-build
WORKDIR /tmp
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    g++ \
    git \
    make \
    yasm \
    && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 5 https://github.com/anthwlock/untrunc /tmp/untrunc \
    && git -C /tmp/untrunc checkout 9d86ec9ef2ffed1bf8131abe80742c0574db52b6 \
    && make -C /tmp/untrunc FF_VER=3.3.9

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm ci

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update && apt-get install -y --no-install-recommends \
    imagemagick \
    libheif1 \
    poppler-utils \
    ffmpeg \
    mkvtoolnix \
    ca-certificates \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=untrunc-build /tmp/untrunc/untrunc /usr/local/bin/untrunc

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/lib ./lib
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
RUN npm prune --omit=dev
RUN mkdir -p /app/data/jobs

VOLUME ["/app/data"]
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
