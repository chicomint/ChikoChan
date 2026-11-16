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
npm start
```

Then open:

```text
http://localhost:3000
```
Follow the setup on the page. The configuration will be saved in a `.env` file. If you want to change or add more settings later, check `env.example.txt` for the available options.



(To skip the installer for local testing, you can still use):

```bash
npm run start:local
```



## Development

Start the server with Node.js watch mode:

```bash
npm run dev
```

Run tests:

```bash
npm test
```

Check the JavaScript files for syntax errors:

```bash
npm run check
```

## Maintenance update (schema 17)

This update keeps Express, the JSON/MongoDB repositories, existing staff roles and
moderation screens, TXT pages, and local/S3-compatible storage. See
[MAINTENANCE.md](MAINTENANCE.md) for behavior, verification, and deployment notes.

## Homepage editor and media safety update

See [IMPLEMENTATION.md](IMPLEMENTATION.md) for the visual homepage editor, news,
Miku theme, posting forms, validation results, and the moderation/storage integration
settings that must be configured before production use.
