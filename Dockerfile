# NesOpenWritter backend — multi-stage Dockerfile for Railway
# syntax=docker/dockerfile:1.7

FROM node:22-alpine AS base
RUN corepack enable pnpm
WORKDIR /app

# ---- deps (cached) ----------------------------------------------------------
FROM base AS deps
COPY package.json pnpm-lock.yaml* ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile=false
RUN pnpm prisma generate

# ---- build ------------------------------------------------------------------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/prisma ./prisma
COPY . .
RUN pnpm build
RUN pnpm prune --prod

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
RUN apk add --no-cache openssl
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/package.json ./package.json

EXPOSE 8080
# Use node_modules/.bin/prisma directly — pnpm is not available in runtime image.
CMD ["sh", "-c", "./node_modules/.bin/prisma migrate deploy && node dist/server.js"]
