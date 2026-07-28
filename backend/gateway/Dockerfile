# GrubGroup Gateway (Node/Express/Socket.IO) — run with Bun.
# Debian slim (NOT alpine): Prisma's query engine needs glibc + OpenSSL.
FROM oven/bun:1-slim

WORKDIR /app

# Install deps first for better layer caching. Copy the Prisma schema too — the
# `postinstall: prisma generate` step reads schema.prisma (it does NOT touch the
# DB, so no DATABASE_URL is needed at build time).
COPY package.json bun.lock ./
COPY prisma ./prisma
RUN bun install --frozen-lockfile

# App code
COPY server.js ./
COPY src ./src

# Fly overrides via the PORT env / fly.toml internal_port; 4000 is the default.
ENV PORT=4000
EXPOSE 4000

CMD ["bun", "server.js"]
