# NesOpenWritter — backend

API-сервис для OpenWritter. Стек: **Fastify 5 + Prisma 5 + PostgreSQL 16**, деплой на Railway.

Этап 0 (текущий): минимальный сервер с `/health` и заготовка Prisma-схемы под Better-Auth. Domain-роуты добавятся в Этапе 1 (`docs/WEB_MIGRATION_PLAN.md`).

## Структура

```
backend/
├── src/
│   ├── server.ts        # entry point: build app + listen
│   ├── app.ts           # Fastify instance + plugins
│   ├── routes/
│   │   └── health.ts    # GET /health
│   ├── lib/
│   │   ├── env.ts       # Zod-валидация process.env
│   │   └── logger.ts    # pino
│   └── plugins/         # будущие Fastify-плагины (requireAuth, ...)
├── prisma/
│   └── schema.prisma    # User/Session/Account/Verification (Better-Auth)
├── Dockerfile
├── railway.toml
├── .env.example
├── package.json
└── tsconfig.json
```

## Запуск локально

Требуется Node 22+, pnpm 9+, PostgreSQL 16 (локально или через Docker).

```bash
cd backend
pnpm install
cp .env.example .env             # задать DATABASE_URL, BETTER_AUTH_SECRET
pnpm prisma:generate              # сгенерировать Prisma Client
pnpm prisma:migrate               # применить миграции к локальной БД
pnpm dev                          # tsx watch → :8080
```

Проверка:

```bash
curl http://localhost:8080/health
# {"status":"ok","uptime":1.234,"timestamp":"2026-..."}
```

### Прочие команды

```bash
pnpm typecheck       # tsc --noEmit
pnpm build           # tsc → dist/
pnpm start           # node dist/server.js (production-like)
pnpm prisma:deploy   # применить миграции в продакшен (railway.toml использует это)
pnpm lint
pnpm format
```

## Деплой на Railway

- В Railway-проекте: **Root Directory = `.`** (этот репо — backend-only после `pnpm push:backend` из корня монорепо).
- Postgres-аддон → `DATABASE_URL` подставляется автоматически.
- Остальные env-vars из [`.env.example`](.env.example) задать в Variables.
- `railway.toml` указывает healthcheck `/health` и `pnpm prisma:deploy` перед стартом.

## Связанные репозитории

| Репо | Назначение |
|---|---|
| [NesOpenWritter](https://github.com/Kogl-B/NesOpenWritter) | Frontend (Vite + React), деплой на Vercel |
| [NesOpenWritter-Backend](https://github.com/Kogl-B/NesOpenWritter-Backend) | Этот сервис (Fastify + Prisma), деплой на Railway |
| `@kogl-b/openwritter-shared` | Общие TS-типы/Zod-схемы (GitHub Packages, отдельный репо) |
