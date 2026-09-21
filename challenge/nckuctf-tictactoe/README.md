# NCKUCTF Tic-Tac-Toe Challenge

A deliberately vulnerable stateless Tic-Tac-Toe web challenge.

The visible game pits the player against a deterministic perfect-play AI. The
client sends the entire board to the backend through a GET request. By default,
the backend validates only the board encoding and turn/count relationship; full
Tic-Tac-Toe history legality checking is optional. In either mode, the server
does not verify that the state actually follows from the AI's previous response.
That trust-boundary mistake is the intended vulnerability.

## Run

```bash
docker build -t nckuctf-tictactoe .
docker run --rm -p 8000:8000 \
  -e 'FLAG=NCKUCTF{put_the_real_flag_here}' \
  -e 'BASE_PATH=' \
  -e 'CHECK_BOARD_LEGALITY=false' \
  nckuctf-tictactoe
```

Then open `http://localhost:8000/`.

For a Cloudflare Tunnel path such as `/ox`, set:

```bash
-e 'BASE_PATH=/ox'
```

and open `https://your-host.example/ox/`. A request to `/ox` is redirected to
`/ox/` so relative static/API URLs resolve under the same prefix.

Or with Docker Compose, which serves at `/` by default:

```bash
docker compose up --build
```

To mount the same image under a subpath, override `BASE_PATH` at runtime:

```bash
BASE_PATH=/ox docker compose up --build
```

You can use any prefix, for example `BASE_PATH=/web/ox`.

## Production notes

- Set the real flag only through the `FLAG` environment variable.
- `BASE_PATH` is optional and defaults to `/`. Set `BASE_PATH=/ox` (or any
  other prefix) only when the reverse proxy forwards that public path unchanged.
- `CHECK_BOARD_LEGALITY=false` is the default. Set it to `true` to require the
  supplied board to be reachable in an ordinary Tic-Tac-Toe game that stops
  immediately after a win. Encoding, player, and turn/count checks remain on
  in both modes.
- `/docs`, `/redoc`, and `/openapi.json` are disabled.
- Losing or draw API responses have a 37% chance to include a server-generated hint directing players to DevTools → Network.
- The application is intentionally stateless. Do **not** add server-side game
  sessions unless you also preserve the intended vulnerability another way.
- The image runs as an unprivileged user.
- `docker-compose.yml` uses a read-only root filesystem and `no-new-privileges`.

## Intended API

At the domain root:

```text
GET /api/play?board=X.O..OX..&player=X
```

With `BASE_PATH=/ox`:

```text
GET /ox/api/play?board=X.O..OX..&player=X
```

Board encoding:

- `X`: X mark
- `O`: O mark
- `.`: empty cell
- exactly 9 characters, row-major order

`player` is the mark controlled by the human (`X` or `O`). X always moves first.
The browser calls the API only when it is the AI's turn.

## Intended solve

Observe the GET request in DevTools → Network and notice that the browser supplies the
entire board. Forge a human-winning board with the expected X/O turn counts.
With `CHECK_BOARD_LEGALITY=true`, the forged board must additionally be reachable
in an ordinary legal Tic-Tac-Toe game. In both modes, it does not need to be
reachable while playing honestly against this perfect AI.

For example, as X:

```text
X X X
O O .
. . .
```

encodes as:

```text
XXXOO....
```

It is a legal generic terminal state, but the AI would never allow X's third
mark because it would block the threat. Therefore:

```bash
curl 'http://localhost:8000/api/play?board=XXXOO....&player=X'
```

returns the flag.

## Tests

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements-dev.txt
pytest -q
```

The tests exhaustively explore every possible human move sequence against the
deterministic AI, for both human-X and human-O, and assert that the human can
never win through the normal game.

## Visual direction

The UI is original, using the referenced sites only as visual direction:
terminal/code notation inspired by NCKUCTF and large typographic cards / bold
layout inspired by SITCON Camp 2026. No assets from either site are copied.
