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
