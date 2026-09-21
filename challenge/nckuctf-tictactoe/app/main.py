from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from .game import EMPTY, choose_bot_move, is_full, is_legal_state, other, place, winner, winners

BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"
FLAG = os.environ.get("FLAG", "NCKUCTF{dev_flag_change_me}")
TERMINAL_HINT = "Open DevTools and inspect the Network tab. What exactly did the browser send?"


def normalize_base_path(value: str | None) -> str:
    """Return '' for root deployment, otherwise a normalized '/prefix'."""
    value = (value or "").strip()
    if not value or value == "/":
        return ""
    if not value.startswith("/"):
        value = f"/{value}"
    return value.rstrip("/")


def env_bool(name: str, default: bool = False) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def maybe_add_terminal_hint(payload: dict[str, object]) -> dict[str, object]:
    """Attach a server-side hint to 37% of losing or draw responses."""
    if secrets.randbelow(100) < 37:
        payload["hint"] = TERMINAL_HINT
    return payload


def bad_request(detail: str) -> HTTPException:
    return HTTPException(status_code=400, detail=detail)


def validate_request_state(
    board: str, player: str, *, check_board_legality: bool = False
) -> None:
    if len(board) != 9 or any(c not in {"X", "O", EMPTY} for c in board):
        raise bad_request("invalid board encoding")

    if player not in {"X", "O"}:
        raise bad_request("player must be X or O")

    x_count = board.count("X")
    o_count = board.count("O")

    # /api/play is called when it is the AI's turn, except that a
    # player-winning terminal state is also accepted so the server can award
    # the challenge flag. Keep this lightweight turn/count validation even
    # when strict board-legality checking is disabled.
    if player == "X" and x_count != o_count + 1:
        raise bad_request("not the AI's turn")
    if player == "O" and x_count != o_count:
        raise bad_request("not the AI's turn")

    # Optional semantic validation. When enabled, the board must be reachable
    # in a normal game where X starts, turns alternate, and play stops on win.
    if check_board_legality:
        if not is_legal_state(board):
            raise bad_request("illegal game state")
        if len(winners(board)) > 1:
            raise bad_request("both sides cannot win")


def create_app(
    base_path: str | None = None, check_board_legality: bool | None = None
) -> FastAPI:
    base_path = normalize_base_path(
        os.environ.get("BASE_PATH", "") if base_path is None else base_path
    )
    if check_board_legality is None:
        check_board_legality = env_bool("CHECK_BOARD_LEGALITY", False)

    app = FastAPI(
        title="Tic-Tac-Toe",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )

    static_path = f"{base_path}/static" if base_path else "/static"
    index_path = f"{base_path}/" if base_path else "/"
    api_path = f"{base_path}/api/play" if base_path else "/api/play"

    app.mount(static_path, StaticFiles(directory=STATIC_DIR), name="static")

    if base_path:
        @app.get(base_path, include_in_schema=False)
        def redirect_to_trailing_slash() -> RedirectResponse:
            # Relative assets and API URLs resolve correctly from /prefix/.
            return RedirectResponse(url=f"{base_path}/", status_code=307)

    @app.get(index_path, include_in_schema=False)
    def index() -> FileResponse:
        return FileResponse(STATIC_DIR / "index.html")

    @app.get(api_path, include_in_schema=False)
    def play(
        board: str = Query(..., min_length=9, max_length=9),
        player: str = Query(..., min_length=1, max_length=1),
    ):
        player = player.upper()
        validate_request_state(
            board, player, check_board_legality=check_board_legality
        )
        bot = other(player)

        current_winner = winner(board)
        if current_winner == player:
            # Intended challenge bug: this trusts the client-supplied board as the
            # current game state. The board is legal in generic Tic-Tac-Toe, but we
            # never prove that it is reachable from the bot's previous response.
            return {
                "board": board,
                "status": "win",
                "message": "Impossible. Yet the board says otherwise.",
                "flag": FLAG,
            }

        if current_winner == bot:
            return maybe_add_terminal_hint({
                "board": board,
                "status": "lose",
                "message": "The machine has already won.",
            })

        if is_full(board):
            return maybe_add_terminal_hint({
                "board": board,
                "status": "draw",
                "message": "Perfectly balanced. Try again.",
            })

        move = choose_bot_move(board, bot)
        board = place(board, move, bot)

        if winner(board) == bot:
            return maybe_add_terminal_hint({
                "board": board,
                "status": "lose",
                "move": move,
                "message": "Prediction complete. You lose.",
            })

        if is_full(board):
            return maybe_add_terminal_hint({
                "board": board,
                "status": "draw",
                "move": move,
                "message": "No winner. As expected.",
            })

        return {
            "board": board,
            "status": "continue",
            "move": move,
            "message": "Your move.",
        }

    return app


app = create_app()
