# NesOpenWritter — backend

API-сервис для OpenWritter. Стек: **Fastify 5 + Prisma 5 + PostgreSQL 16 + Better-Auth 1**, деплой на Railway.

## Реализованные этапы

- **Этап 0** — каркас, `/health`, Docker, Railway-конфиг
- **Этап 1** — auth (email+password, Google OAuth), Project + Character CRUD

## Структура

```
backend/
├── src/
│   ├── server.ts                # entry: build app + listen + graceful shutdown
│   ├── app.ts                   # Fastify instance + plugins + error handler
│   ├── plugins/
│   │   └── auth.ts              # /api/auth/* mount + req.user/session + requireAuth
│   ├── routes/
│   │   ├── health.ts            # GET /health
│   │   ├── me.ts                # GET /api/me
│   │   ├── projects.ts          # /api/projects CRUD
│   │   └── characters.ts        # /api/projects/:projectId/characters CRUD
│   └── lib/
│       ├── env.ts               # Zod-валидация process.env
│       ├── logger.ts            # pino config (dev: pretty)
│       ├── prisma.ts            # PrismaClient singleton
│       ├── auth.ts              # Better-Auth config
│       └── schemas.ts           # Zod-схемы входов
├── prisma/
│   ├── schema.prisma            # User/Session/Account/Verification + Project + Character
│   └── migrations/
├── docker-compose.yml           # local Postgres on :5434
├── Dockerfile
├── railway.toml
└── .env.example
```

## Эндпоинты

| Метод | Путь | Auth | Описание |
|---|---|---|---|
| `GET` | `/health` | нет | liveness probe |
| `*` | `/api/auth/*` | — | Better-Auth handler (`/sign-up/email`, `/sign-in/email`, `/sign-out`, OAuth callbacks...) |
| `GET` | `/api/me` | да | текущий пользователь |
| `GET` | `/api/projects` | да | список проектов пользователя |
| `POST` | `/api/projects` | да | создать проект |
| `GET` | `/api/projects/:id` | да | получить проект |
| `PATCH` | `/api/projects/:id` | да | частичное обновление |
| `DELETE` | `/api/projects/:id` | да | удалить (каскадно сносит characters) |
| `GET` | `/api/projects/:projectId/characters` | да | список персонажей |
| `POST` | `/api/projects/:projectId/characters` | да | создать персонажа |
| `GET` | `/api/projects/:projectId/characters/:characterId` | да | получить |
| `PATCH` | `/api/projects/:projectId/characters/:characterId` | да | частичное обновление |
| `DELETE` | `/api/projects/:projectId/characters/:characterId` | да | удалить |

Все защищённые роуты возвращают **401** без валидного cookie. Изоляция проверяется по `ownerId` — другой пользователь видит **404** для чужих ресурсов.

## Запуск локально

Требуется Node 22+, pnpm 9+, Docker (для локального Postgres).

```bash
cd backend
pnpm install
pnpm db:up                       # docker-compose: Postgres на localhost:5434
cp .env.example .env             # задать BETTER_AUTH_SECRET (32+ байт)
pnpm prisma:generate
pnpm prisma:migrate              # применить миграции к локальной БД
pnpm dev                         # tsx watch → :8080
```

Проверка:

```bash
curl http://localhost:8080/health
# {"status":"ok","uptime":...,"timestamp":"..."}

# Sign-up + создать проект:
EMAIL="me@test.local"
curl -c /tmp/c.txt -X POST http://localhost:8080/api/auth/sign-up/email \
  -H "Content-Type: application/json" -H "Origin: http://localhost:5173" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\",\"name\":\"Me\"}"
curl -b /tmp/c.txt -X POST http://localhost:8080/api/projects \
  -H "Content-Type: application/json" -H "Origin: http://localhost:5173" \
  -d '{"name":"My Novel"}'
```

### Команды

```bash
pnpm typecheck       # tsc --noEmit
pnpm build           # tsc → dist/
pnpm start           # node dist/server.js (production-like)
pnpm dev             # tsx watch
pnpm db:up           # docker-compose up -d (Postgres)
pnpm db:down         # docker-compose down
pnpm db:wipe         # down + удалить volume (полный сброс БД)
pnpm prisma:generate # сгенерировать Prisma Client
pnpm prisma:migrate  # prisma migrate dev (создать/применить миграции)
pnpm prisma:deploy   # prisma migrate deploy (для прода)
pnpm prisma:studio   # GUI на :5555
pnpm lint
pnpm format
```

## Деплой на Railway

1. Railway-проект → **+ Create** → **Database** → **PostgreSQL**
2. Сервис бэка → **Variables** → reference `${{Postgres.DATABASE_URL}}` (не хардкодить!)
3. Задать в Variables:
   - `BETTER_AUTH_SECRET` (32+ байт, `openssl rand -base64 32`)
   - `BETTER_AUTH_URL` (публичный URL сервиса после первого деплоя)
   - `CORS_ORIGIN` (URL фронта на Vercel)
   - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — опционально
4. `railway.toml` уже настраивает: healthcheck `/health`, перед стартом — `pnpm prisma:deploy`.
5. **Root Directory = `.`** (этот репо backend-only после `pnpm push:backend` из монорепо).

## Auth: cookies + CORS

Better-Auth работает на **HttpOnly cookies**, поэтому фронт должен делать `fetch` с `credentials: 'include'`, а CORS — с `credentials: true` и явным origin (`*` запрещён).

В продакшене cookies автоматически становятся `Secure; SameSite=None` (для cross-site fetch между Vercel и Railway).

## Связанные репозитории

| Репо | Назначение |
|---|---|
| [NesOpenWritter](https://github.com/Kogl-B/NesOpenWritter) | Frontend (Vite + React), деплой на Vercel |
| [NesOpenWritter-Backend](https://github.com/Kogl-B/NesOpenWritter-Backend) | Этот сервис, деплой на Railway |
| `@kogl-b/openwritter-shared` | Общие TS-типы/Zod-схемы (GitHub Packages, отдельный репо) |
