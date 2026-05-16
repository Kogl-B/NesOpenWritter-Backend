# Optional container image — Railway will use Nixpacks unless this file is present.
# Keeping it here as an explicit, reproducible alternative.

FROM node:22-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml* .npmrc ./
COPY prisma ./prisma
RUN pnpm install --frozen-lockfile=false

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm prisma:generate && pnpm build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
EXPOSE 8080
CMD ["sh", "-c", "pnpm prisma:migrate:deploy && pnpm start"]
