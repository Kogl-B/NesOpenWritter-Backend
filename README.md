# NesOpenWritter — backend

API-сервис для OpenWritter. Стек: **Fastify 5 + Prisma 5 + PostgreSQL 16 + Better-Auth 1**, деплой на Railway.

## Реализованные этапы

- **Этап 0** — каркас, `/health`, Docker, Railway-конфиг
- **Этап 1** — auth (email+password, Google OAuth), Project + Character CRUD
- **Этап 2** — Item, Location, TimelineEvent, Chapter, Tag + связи (relations, genealogy, event-character, event-item, character-positions, polymorphic tag-links)
- **Этап 3** — Cloudflare R2 presigned-upload, MapElement (marker/line/area + LOD), MapDrawing (heavy JSON + pagination)
- **Этап 4** — Chapter content autosave PATCH, scene mentions (replace + reverse-lookup), chapters reorder (batch transaction), revisions (snapshot/restore)
- **Этап 6** — глобальный поиск (по character/item/location/event/chapter/tag), user settings (`Json`), frontend logs endpoint (→ pino), Sentry (опционально через `SENTRY_DSN`)
- **Этап 5** пропущен — это фронтовая работа (PWA + responsive, бэк не касается)

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
│   │   ├── characters.ts        # characters + relations + genealogy + positions list
│   │   ├── items.ts             # items + item timeline points
│   │   ├── locations.ts         # locations (hierarchical)
│   │   ├── events.ts            # events + event-character/item + position write
│   │   ├── chapters.ts          # chapters + scenes
│   │   └── tags.ts              # tags + polymorphic assign/unassign
│   └── lib/
│       ├── env.ts               # Zod-валидация process.env
│       ├── logger.ts            # pino config (dev: pretty)
│       ├── prisma.ts            # PrismaClient singleton
│       ├── auth.ts              # Better-Auth config
│       ├── access.ts            # assertProjectOwnership, toJson helpers
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
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/characters/:characterId` | да | получить/изменить/удалить |
| `GET\|POST` | `/api/projects/:projectId/character-relations` | да | связи (friend/enemy/lover/...) |
| `PATCH\|DELETE` | `/api/projects/:projectId/character-relations/:relationId` | да | |
| `GET\|POST` | `/api/projects/:projectId/genealogy` | да | родительские связи |
| `DELETE` | `/api/projects/:projectId/genealogy/:edgeId` | да | |
| `GET\|POST` | `/api/projects/:projectId/items` | да | предметы |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/items/:itemId` | да | |
| `GET\|POST` | `/api/projects/:projectId/items/:itemId/timeline` | да | item timeline points (история владения) |
| `PATCH\|DELETE` | `.../timeline/:pointId` | да | |
| `GET\|POST` | `/api/projects/:projectId/locations` | да | локации (поддерживают `parentLocationId`) |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/locations/:locationId` | да | |
| `GET\|POST` | `/api/projects/:projectId/events` | да | timeline events |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/events/:eventId` | да | |
| `GET\|POST` | `/api/projects/:projectId/events/:eventId/characters` | да | event-character (role) |
| `PATCH\|DELETE` | `.../events/:eventId/characters/:characterId` | да | |
| `GET\|POST` | `/api/projects/:projectId/events/:eventId/items` | да | event-item |
| `PATCH\|DELETE` | `.../events/:eventId/items/:itemId` | да | |
| `GET` | `/api/projects/:projectId/character-positions` | да | список позиций на карте по событиям |
| `POST` | `/api/projects/:projectId/character-positions` | да | (uniq `characterId+eventId`) |
| `PATCH\|DELETE` | `.../character-positions/:positionId` | да | |
| `GET\|POST` | `/api/projects/:projectId/chapters` | да | chapters + scenes (древовидно) |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/chapters/:chapterId` | да | |
| `GET\|POST` | `/api/projects/:projectId/tags` | да | tags (uniq name на проект) |
| `PATCH\|DELETE` | `/api/projects/:projectId/tags/:tagId` | да | |
| `POST` | `/api/projects/:projectId/tags/:tagId/assign` | да | привязать тег к entity (character/item/location/event/chapter/scene) |
| `DELETE` | `/api/projects/:projectId/tags/:tagId/assign/:entityType/:entityId` | да | отвязать |
| `GET` | `/api/projects/:projectId/tag-links/:entityType/:entityId` | да | все теги entity (с join на tag) |
| `GET\|POST` | `/api/projects/:projectId/map-elements` | да | marker/line/area, `?lod=N` фильтр |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/map-elements/:elementId` | да | |
| `GET\|POST` | `/api/projects/:projectId/map-drawings` | да | summary-list, `?page=&pageSize=&layer=` |
| `GET\|PATCH\|DELETE` | `/api/projects/:projectId/map-drawings/:drawingId` | да | full payload по id |
| `POST` | `/api/projects/:projectId/uploads/presign` | да | presigned PUT URL для R2 (10 min TTL); 503 без R2-cred |
| `PATCH` | `/api/projects/:projectId/chapters/:chapterId/content` | да | autosave: только content + wordCount |
| `POST` | `/api/projects/:projectId/chapters/reorder` | да | batch: `[{id,parentId,orderIndex}]` в одной transaction |
| `GET\|PUT` | `/api/projects/:projectId/chapters/:chapterId/mentions` | да | scene mentions: PUT replace |
| `GET` | `/api/projects/:projectId/scene-mentions/:entityType/:entityId` | да | reverse-lookup (где упоминается) |
| `GET\|POST` | `/api/projects/:projectId/chapters/:chapterId/revisions` | да | список ревизий / snapshot текущего content |
| `GET\|DELETE` | `.../revisions/:revisionId` | да | |
| `POST` | `.../revisions/:revisionId/restore` | да | вернуть content из ревизии |
| `GET` | `/api/projects/:projectId/search?q=&types=&limit=` | да | глобальный ILIKE-поиск по всем сущностям |
| `PATCH` | `/api/me/settings` | да | user settings (JSON) |
| `POST` | `/api/projects/:projectId/logs` | да | batch frontend logs → pino |

Все защищённые роуты возвращают **401** без валидного cookie. Изоляция проверяется по `ownerId` (для проектов) либо через `assertProjectOwnership` (для всех подресурсов) — другой пользователь видит **404** для чужих ресурсов. Cross-project references (например, link `eventId` из чужого проекта к character) возвращают **400**.

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
