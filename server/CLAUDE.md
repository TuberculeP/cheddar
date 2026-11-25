# Backend

> Express REST API under `/api` + Socket.io, TypeORM entities, session auth (local + Google OAuth).

Boot (`src/main.ts`): DB init -> migrations **only if production and Postgres** -> middlewares -> `/api` router -> `errorHandler` -> Vite middleware (dev) or static `dist/client` (prod) -> Socket.io.

## Architecture

```
src/
  main.ts                     # boot sequence above
  config/
    db.config.ts              # DataSource: Postgres if POSTGRES_URL, else SQLite
    cache.config.ts           # session store: Redis (prod) / SQLite (dev)
    passport.config.ts        # local + google-oauth20 strategies
    storage.config.ts         # Multer -> public/uploads, 10MB max
    entities/index.ts         # entity registry (User, Upload)
    entities/CLAUDE.md        # SQLite/Postgres-portable column types
  routes/
    index.ts                  # mounts /auth, /shared
    auth/                     # register/login/logout/check/config, Google, /me (GDPR)
    shared/uploads.ts         # POST /api/shared/uploads
  middleware/                 # auth (isAuth), validate, error, rateLimiter (see README.md)
  services/                   # business logic shared by routes (empty for now)
  utils/
    AppError.ts               # new AppError(message, statusCode = 400)
    asyncHandler.ts           # forwards async errors to errorHandler
    anonymizeUser.ts          # GDPR erasure, keeps the row for FKs
    uniqueConstraint.ts       # getConflictingUniqueField(err, fields) -> 409 messages
    username.ts               # generateUniqueUsername(base)
  events/event_handler.ts     # WebSocket event registry
  migrations/                 # Postgres migrations (prod only)
__tests__/                    # Jest (ts-jest, server/tsconfig.json)
```

## Response formats

- Errors: `{ message }` (AppError, chosen status), `{ message: "Validation failed", errors }` (400, Zod issues), `{ message: "Internal server error" }` (500).
- Success: no envelope, plain JSON. Paginated lists: `{ <items>, pagination: { page, limit, total, pages } }`, with `?page`, `?limit` (max 100) and `?search`. Reference: `routes/admin/users.ts`.

## Add a route

1. `routes/<x>/<x>.schemas.ts`: Zod schemas.
2. `routes/<x>/index.ts`: `Router()`, `isAuth` if protected, `validateBody(schema)`, handler wrapped in `asyncHandler`, `throw new AppError(msg, status)` for business errors.
3. Mount it in `routes/index.ts`: `router.use("/<x>", xRouter)`.

## Add an entity

1. `config/entities/X.ts` (uuid primary key, like `User.ts`). Column types must exist on both SQLite and Postgres: read `config/entities/CLAUDE.md` first (e.g. never `type: "datetime"`).
2. Add it to the array in `config/entities/index.ts` (not in `db.config.ts`).
3. Dev schema auto-syncs. For prod: `npm run migration:generate -- server/src/migrations/<Name>` (needs a reachable Postgres via `POSTGRES_URL`), then `migration:run` / `migration:revert`.

**GDPR invariant**: an entity holding user-linked personal data must be included in `GET /auth/me/export` (`routes/auth/index.ts`) and scrubbed or detached in `utils/anonymizeUser.ts`. See `docs/RGPD-CHECKLIST.md`.

## Add a WebSocket event group

1. `events/<x>.event.ts` exporting an `EventGroup`: `{ default: handler, <name>: handler }`, handler signature `({ event, data, ws }) => void`.
2. Register it in `eventGroupList` in `events/event_handler.ts` under key `<x>`. `default` listens on `<x>`, the others on `<x>:<name>`.

## Auth and uploads

- `GET /auth/config` returns `{ googleAuthEnabled }` (false when the Google env vars are missing). Google sign-up derives the username with `generateUniqueUsername`.
- `authLimiter` is applied to `/auth/login` and `/auth/register`. Passwords use bcrypt (10 rounds).
- Roles: `role` is a string column defaulting to `"ROLE_USER"`. Nothing checks it here (no admin back-office in this module): the host app decides what roles mean.
- Uploads: `storage.single("file")` -> `Upload` row linked to `req.user` -> responds with `{ url: "/public/uploads/<file>" }`.

## Gotchas

- SQLite always uses `synchronize: true`: migrations are written for Postgres. Never run migrations against SQLite.
- `req.user` is typed as the `User` entity via `src/@types/express/index.d.ts`.
- `errorHandler` logs the error but not `req.body`. Keep it that way (passwords, GDPR).
- `config/README.md` and `middleware/README.md` list GDPR items left for each project (2FA, roles, backups). Read them before touching auth or infra.
