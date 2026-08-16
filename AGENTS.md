# ChikoChan Project Notes

This is a lightweight, single/multi-board imageboard written in Node.js. MongoDB
is the default database; uploads are ordinary files in `src/`.

## Quick start

```sh
npm install
MONGO_URL=mongodb://127.0.0.1:27017/chikochan npm start
npm run dev      # node --watch
npm test         # node --test
npm run check    # node --check server.js app.js client.js
```

## Architecture

- `server.js` — entry point. Creates the app via `createApp()` and listens.
- `app.js` — `createApp(overrides)`. Defines all Express routes and middleware.
- `config.js` — `loadConfig(overrides)`. Merges defaults, `config.json`, env vars.
- `lib/mongo-store.js` — `MongoStore`. Default persistence and MongoDB indexes.
- `lib/store.js` — retained `JsonStore` plus normalization helpers for migration/tests.
- `lib/board.js` — `BoardService`. Business logic: create thread/reply, delete,
  report, ban, board management, search, latest posts.
- `lib/render.js` — `Renderer`. All HTML generation (board, thread, catalog,
  homepage, admin pages).
- `lib/api.js` — 4chan-style JSON API helpers.
- `lib/uploads.js` — `UploadManager`. Multer setup + image validation.
- `lib/admin-auth.js` — `AdminAuth`. Password login + signed session cookie.
- `lib/markup.js` — Comment formatting, greentext, quotes, backlinks.
- `lib/boards.js` — Board URI validation + grouping by category.
- `lib/utils.js` — Small helpers: escapeHTML, formatDate, password hashing, etc.
- `client.js` — Browser JS: theme toggle, password storage, quote previews,
  post hiding, image expansion.
- `style.css` — Site styles.

## Important routes

- `/` — Homepage. Shows site info, board directory, **latest posts**, stats.
- `/:boardUri/` — Board index.
- `/:boardUri/thread/:id` — Thread page.
- `/:boardUri/catalog` — Catalog view.
- `/thread/:id` — Thread page without board prefix.
- `/search` — Search posts (if enabled).
- `/feed.xml` — RSS feed (if enabled).
- `/admin` — Admin dashboard (requires `ADMIN_PASSWORD` + `ADMIN_SESSION_SECRET`).
- `/*.json` — 4chan-style API endpoints (if enabled).

## Recent changes

- **The `/latest` route was removed.** The latest-posts list now lives on the
  homepage (`/`). `app.js` passes `service.latestPosts(50, data)` to
  `renderer.home()`, and `lib/render.js` renders it inside a
  `.latest-posts-section` block.

## Common tasks

- Add/modify a board: use the admin panel at `/admin/boards`.
- Change site title/description: edit `config.js` defaults or create `config.json`.
- Edit site pages (Rules, News, Contact, About): edit the plain-text files in the
  `page/` directory (`rule.txt`, `news.txt`, `contact.txt`, `about.txt`). Each
  `*.txt` file becomes a route using its filename; `rule.txt` is mapped to `/rules`.
  Pages are loaded at startup, so restart the server after editing them.
- Enable admin: set `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` in `.env`.
- Change appearance: edit `style.css`.

## Notes

- Keep changes minimal; match the existing style and conventions.
- Always run `npm test` after changes.
- MongoDB is the source of truth in normal operation. Set `MONGO_URL` or
  `MONGODB_URI`; optionally set `MONGO_DB_NAME`.
- Run `npm run migrate:mongo` once to back up and idempotently import `posts.json`.
