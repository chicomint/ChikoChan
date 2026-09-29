# <img src="chikki.ico" width="40" alt=""> ChikoChan
![ChikoChan board](Image/owwww.png)
A lightweight and simple imageboard built with Node.js.
ChikoChan supports multiple boards, file uploads, and can run locally without needing a database server.

## Getting Started

### Requirements

- Node.js 22 or newer
- npm
- Git

### Installation

Clone the repository:

```bash
git clone https://github.com/chicomint/ChikoChan.git
cd ChikoChan
```

Install the dependencies:

```bash
npm install
```

Start ChikoChan:

```bash
npm run start:local
```

Then open:

```text
http://localhost:3000
```

That's it.

Local posts and uploads will be stored inside the `data/` folder.

## Using MongoDB

MongoDB is optional. You only need it if you want to use MongoDB instead of the built-in local storage.

Copy `env.example.txt` to a new file named `.env` and change:

```env
STORAGE=mongodb
MONGO_URL="your-mongodb-connection-string"
DATA_DIR="./data"
```

Then start normally:

```bash
npm start
```

## Admin Panel

The admin panel is disabled by default.

To enable it, add these to your `.env` file:

```env
ADMIN_PASSWORD="your-password"
ADMIN_SESSION_SECRET="your-secret"
```

Make sure you use your own secure values.

## Development

Start the server with Node.js watch mode:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Check the main JavaScript files for syntax errors:

```bash
npm run check
```

