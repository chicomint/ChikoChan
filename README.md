# <img src="chikki.ico" width="40" alt=""> ChikoChan

ChikoChan is a lightweight, multi-board imageboard written in Node.js and backed by MongoDB.<br>
Uploads are ordinary files in `src/`.
![ChikoChan board](Image/1.png)

## Quick start

Requirements:

- Node.js 22 or newer; use an active LTS release
- npm, included with Node.js
- MongoDB, with its connection string in `MONGO_URL` (or `MONGODB_URI`)

Install and run:

```sh
git clone <your-chikochan-repository-url>
cd ChikoChan
npm install
export MONGO_URL='mongodb://127.0.0.1:27017/chikochan'
npm start
```

Open <http://localhost:3000>. The server creates the MongoDB collections and indexes on first start.

## Configuration

Configuration can be supplied through `config.json` and environment variables. Database credentials must only be supplied through the environment:

```sh
MONGO_URL=mongodb://user:password@host:27017/chikochan
# Fallback supported by many MongoDB hosts:
MONGODB_URI=mongodb://user:password@host:27017/chikochan
# Optional when the URI does not select a database:
MONGO_DB_NAME=chikochan
```

ChikoChan have the admin page, you can edit .env file by add:<br>
ADMIN_PASSWORD=replace-with-a-long-random-password<br>
ADMIN_SESSION_SECRET=replace-with-a-different-long-random-secret<br>
and you can access go into http://localhost:3000/admin 

## Migrate posts.json

Set the destination connection string, then run:

```sh
MONGO_URL='mongodb://...' npm run migrate:mongo
```

The script creates `posts.json.backup` before connecting, retains `posts.json`, skips IDs already present in MongoDB, and prints inserted/skipped totals. It is safe to run again.

## Railway

For the existing `caring-presence` project, use the app service name reported by `railway status` in place of `<app-service>`:

```sh
railway link --project caring-presence
railway add --database mongo
railway variable set 'MONGO_URL=${{MongoDB.MONGO_URL}}' --service <app-service> --skip-deploys
railway up --service <app-service>
railway logs --service <app-service> --lines 100
```

Run the migration with Railway's service variables available:

```sh
railway run --service <app-service> npm run migrate:mongo
```

Railway's normal service filesystem is ephemeral. MongoDB posts persist, but files uploaded into `src/` do not survive redeploys. Use a Railway Volume or external object storage before relying on uploads in production.
