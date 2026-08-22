# ChikoChan Agent Guide

## Project purpose

ChikoChan is a lightweight, multi-board imageboard inspired by classic 4chan/Vichan layouts. It is intentionally simple and server-rendered. Preserve the compact, old-school imageboard appearance; do not redesign it as a modern card-based social network.

Core features include:

- Boards, threads, replies, post numbers, quoting, and inline backlinks.
- JPG, PNG, GIF, and WEBP uploads with thumbnail display and click-to-expand behavior.
- Greentext, spoilers, tripcodes, word filters, and server-generated `#fortune` results.
- Homepage Latest Images and Latest Posts panels.
- Catalog, search, feed, JSON compatibility endpoints, reporting, deletion, bans, and admin board management.
- MongoDB for hosted sites and a JSON file store for local testing.

## Technology and structure

This project uses Node.js 22+, Express 5, MongoDB, Multer, plain browser JavaScript, and plain CSS. There is no frontend framework, template engine, bundler, or build step. Modules use CommonJS.

- `server.js`: process entry point and graceful shutdown.
- `app.js`: Express application setup, middleware, routes, health checks, and request handlers.
- `config.js` and `config.json`: defaults, site options, feature flags, limits, filters, fortunes, and environment loading.
- `lib/board.js`: imageboard service/domain operations such as posting, references, backlinks, latest content, moderation, and board actions.
- `lib/store.js`: JSON storage implementation and shared data normalization helpers.
- `lib/mongo-store.js`: MongoDB implementation of the same storage contract.
- `lib/render.js`: all server-rendered HTML pages and post/thread markup.
- `lib/markup.js`: safe comment formatting for quotes, greentext, spoilers, and trusted fortune rendering.
- `lib/uploads.js`: upload validation, file naming, dimensions, deletion, and storage.
- `lib/api.js`: 4chan-style JSON response formatting.
- `lib/admin-auth.js`: admin authentication and sessions.
- `client.js`: small browser behaviors such as themes, quoting, quote previews, hiding posts, and image expansion.
- `style.css`: all site themes, classic post layout, homepage panels, responsive behavior, and image sizing.
- `page/*.txt`: simple static site pages.
- `test/*.test.js`: Node test runner coverage for HTTP behavior, stores, configuration, security, and boards.

## Running the project

Install dependencies:

```sh
npm install
```

Run without MongoDB:

```sh
npm run start:local
```

This always selects JSON storage and keeps posts and uploads in the ignored `data/` directory.

Run with settings from `.env`:

```sh
node .
```

Important environment variables:

- `STORAGE=json` or `STORAGE=mongodb`.
- `MONGO_URL` or `MONGODB_URI` for MongoDB.
- `MONGO_DB_NAME` to select the MongoDB database explicitly.
- `DATA_DIR=./data` locally. Uploaded files live in `DATA_DIR/src` and are served at `/src/:filename`.
- `TRUST_PROXY=1` only behind a trusted hosting proxy.
- `ADMIN_PASSWORD` and `ADMIN_SESSION_SECRET` must both be set to enable admin login. They must be different secrets.

Never print, commit, replace, or expose values from `.env`. Do not use `/data` on a normal local machine because it may be unwritable; use `./data`. A hosted deployment may use `/data` only when a writable persistent volume is mounted there.

The user deliberately does not want Docker or Railway configuration files in this repository. Do not add them unless the user explicitly changes that decision.

## Required behavior and design rules

### Posts and layout

- Keep replies as compact, square-cornered classic imageboard boxes that wrap their contents rather than stretching across the page.
- Keep header information together: subject, name, tripcode/ID, time, post number, inline backlinks, Reply, View thread, hide control, and thread status.
- Backlinks belong inline in the post header. Do not restore a separate `Replies:` section below posts.
- Quote links such as `>>123` must remain clickable and compatible with hover previews.
- Attached images float naturally beside post text. Thumbnail and expanded images must preserve aspect ratio, must not overlap text, and must not overflow the viewport.
- Keep desktop styling classic and compact while maintaining usable mobile wrapping.

### Latest content

- The homepage Latest Images and Latest Posts panels must reuse the existing service data.
- Latest Images links must open the originating post, use valid existing uploads, and avoid duplicate image entries.
- Do not force the two panels to equal height; each panel should end after its own content.
- Board order is persistent and controlled by the admin Up/Down actions. The homepage must preserve that order for both categories and boards within each category.

### Fortune security

- `#fortune` is detected and selected on the server.
- A genuine fortune is stored separately as trusted post metadata and rendered with the `.fortune` element.
- User comment text must always be escaped and must never create an authentic fortune element through typed HTML, CSS, or fortune-looking greentext.
- Normal greentext must continue working.

### Storage consistency

- `JsonStore` and `MongoStore` expose the same data contract. Changes to posts, references, backlinks, boards, moderation, or metadata generally need equivalent handling in both stores.
- Preserve legacy JSON normalization and migration behavior.
- Do not store raw IP addresses. Existing moderation code uses keyed hashes.
- Uploaded files are separate from post records. File deletion and post deletion must keep storage and backlinks consistent.

### Compatibility and safety

- Preserve existing HTML routes, board-prefixed routes, legacy post fields, and JSON API endpoints unless the user explicitly requests a breaking change.
- Escape all user-controlled output. Do not add raw user HTML or inline user CSS.
- Preserve CSRF/admin protections, rate limits, reporting, deletion passwords, bans, sticky/locked/cyclic controls, and board isolation.
- Reuse the existing renderer, service, store, CSS, and client code instead of introducing duplicate systems or a new framework.

## Code style

- Use `'use strict';`, CommonJS `require`, two-space indentation, single quotes in JavaScript, and semicolons.
- Prefer small helpers and existing utilities over repeated logic.
- Keep dependencies minimal. Do not introduce a frontend framework or build tool for a small UI change.
- Keep CSS selectors tied to the existing markup and theme variables.

## Verification

Before handing off any code change, run:

```sh
npm run check
npm test
git diff --check
```

For UI changes, also verify relevant pages at desktop and mobile widths. At minimum check:

- Homepage panels with different amounts of content.
- Threads and replies with and without images.
- Portrait, landscape, and large expanded images.
- Long comments and many inline backlinks.
- Quote links and hover previews.
- Genuine `#fortune`, a manually typed fake fortune, and normal greentext.

Do not declare the work complete when tests are failing or unresolved Git conflict markers remain.
