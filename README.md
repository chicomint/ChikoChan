# <img src="chikki.ico" width="40" alt=""> ChikoChan

ChikoChan is a lightweight, multi-board imageboard written in Node.js and backed by MongoDB.<br>
Uploads are ordinary files in `data/src/`.

![ChikoChan board](Image/1.png)

## Quick start

Requirements:

- Node.js 22 or newer
- npm, included with Node.js
- MongoDB, with its connection string in `MONGO_URL` (or `MONGODB_URI`)

Edit `.env`:

```env
STORAGE="mongodb"
MONGO_URL="your-mongodb-connection-string"
DATA_DIR="./data"
```

Then run:

```sh
npm install
node .
```

Open <http://localhost:3000>.

## Run without MongoDB

For a quick local test, no database setup is needed:

```sh
npm install
npm run start:local
```

Local posts and uploads are kept in `data/`.

## Board-specific rules

Administrators can manage ordered rules for each board from **Admin → Boards → Rules**. Public rules are available at `/:board/rules`, `/:board/rules.html`, and—when the JSON API is enabled—`/:board/rules.json`. The global `/rules` page remains separate and is not replaced.

The defaults allow 20 rules per board and 512 characters per rule. Override `limits.maxBoardRules` and `limits.maxBoardRuleLength` in `config.json` when needed.

Existing JSON and MongoDB installations migrate non-destructively to the current schema version. Legacy string rules are converted to stable rule records; no post, board, or moderation data is deleted.

## Report moderation

Reports use configurable typed categories and a privacy-preserving keyed reporter fingerprint. ChikoChan never writes the reporter's raw IP address. The admin report queue can filter open/closed reports by board, record a resolution and optional moderator note, and reopen a report. The legacy dismiss action remains available but now closes and retains the report instead of deleting its history.

## Staff accounts and permissions

The environment administrator remains the root recovery account: leave the username blank on the staff login page and use `ADMIN_PASSWORD`. From **Admin → Staff**, it can create named root, administrator, moderator, and janitor accounts. Named administrators can manage moderators and janitors but cannot create peers, roots, or disable themselves.

- Root and administrator accounts are global.
- Moderators can review reports, delete posts, manage thread flags, and—when global—manage the current global ban list.
- Janitors can review reports and delete posts.
- Moderators and janitors can be global or restricted to selected boards. Both page data and mutation permissions are scoped server-side.

Named passwords are scrypt-hashed and must be 12–256 characters. Signed cookies contain only an account ID, session version, expiry, and nonce. Password, role, scope, and enabled-state changes revoke existing sessions. `ADMIN_SESSION_SECRET` is required for legacy and named sessions; keep `ADMIN_PASSWORD` configured until at least one named root account has been tested.

See [the LynxChan integration plan](docs/lynxchan-integration-plan.md) for the architecture comparison, security decisions, compatibility constraints, and phased roadmap.
