from __future__ import annotations

from functools import lru_cache
from typing import Iterable

EMPTY = "."
MARKS = ("X", "O")
WIN_LINES: tuple[tuple[int, int, int], ...] = (
    (0, 1, 2),
    (3, 4, 5),
    (6, 7, 8),
    (0, 3, 6),
    (1, 4, 7),
    (2, 5, 8),
    (0, 4, 8),
    (2, 4, 6),
)
CORNERS = (0, 2, 6, 8)
SIDES = (1, 3, 5, 7)
CENTER = 4
OPPOSITE_CORNERS = ((0, 8), (2, 6), (6, 2), (8, 0))


def other(mark: str) -> str:
    return "O" if mark == "X" else "X"


def winners(board: str) -> set[str]:
    result: set[str] = set()
    for a, b, c in WIN_LINES:
        if board[a] != EMPTY and board[a] == board[b] == board[c]:
            result.add(board[a])
    return result


def winner(board: str) -> str | None:
    ws = winners(board)
    if len(ws) == 1:
        return next(iter(ws))
    return None


def is_full(board: str) -> bool:
    return EMPTY not in board


def place(board: str, idx: int, mark: str) -> str:
    if board[idx] != EMPTY:
        raise ValueError("cell is occupied")
    return board[:idx] + mark + board[idx + 1 :]


def empty_cells(board: str) -> Iterable[int]:
    return (i for i, cell in enumerate(board) if cell == EMPTY)


def _reachable_legal_states() -> frozenset[str]:
    """All states reachable by normal Tic-Tac-Toe rules.

    X moves first, players alternate, and play stops immediately after a win.
    """
    seen: set[str] = set()

    def walk(board: str, turn: str) -> None:
        if board in seen:
            return
        seen.add(board)
        if winner(board) is not None or is_full(board):
            return
        for idx in empty_cells(board):
            walk(place(board, idx, turn), other(turn))

    walk(EMPTY * 9, "X")
    return frozenset(seen)


LEGAL_STATES = _reachable_legal_states()


def is_legal_state(board: str) -> bool:
    return board in LEGAL_STATES


def immediate_winning_moves(board: str, mark: str) -> list[int]:
    moves: list[int] = []
    for idx in empty_cells(board):
        if winner(place(board, idx, mark)) == mark:
            moves.append(idx)
    return moves


def fork_moves(board: str, mark: str) -> list[int]:
    """Moves that create at least two distinct immediate wins next turn."""
    moves: list[int] = []
    for idx in empty_cells(board):
        next_board = place(board, idx, mark)
        if len(immediate_winning_moves(next_board, mark)) >= 2:
            moves.append(idx)
    return moves


def choose_bot_move(board: str, bot: str) -> int:
    """Deterministic perfect-play strategy for a 3x3 board.

    Priority follows the standard human-solvable strategy: win, block, fork,
    block fork, center, opposite corner, corner, side.
    """
    human = other(bot)

    # 1. Win now.
    wins = immediate_winning_moves(board, bot)
    if wins:
        return wins[0]

    # 2. Block an immediate human win.
    blocks = immediate_winning_moves(board, human)
    if blocks:
        return blocks[0]

    # 3. Create a fork.
    forks = fork_moves(board, bot)
    if forks:
        return forks[0]

    # 4. Block the human's fork.
    human_forks = fork_moves(board, human)
    if len(human_forks) == 1:
        return human_forks[0]
    if len(human_forks) > 1:
        # With multiple fork threats, blocking one square is not enough. Make a
        # threat of our own so the human is forced to answer it. After that
        # forced answer, there must be at most one immediate human win, which
        # can be blocked on our next turn.
        for idx in empty_cells(board):
            candidate = place(board, idx, bot)
            threats = immediate_winning_moves(candidate, bot)
            if len(threats) != 1:
                continue
            forced_reply = threats[0]
            forced_board = place(candidate, forced_reply, human)
            if len(immediate_winning_moves(forced_board, human)) <= 1:
                return idx

        # Textbook fallback for the opposite-corners shape.
        for idx in SIDES:
            if board[idx] == EMPTY:
                return idx

    # 5. Center.
    if board[CENTER] == EMPTY:
        return CENTER

    # 6. Opposite corner.
    for human_corner, opposite in OPPOSITE_CORNERS:
        if board[human_corner] == human and board[opposite] == EMPTY:
            return opposite

    # 7. Empty corner.
    for idx in CORNERS:
        if board[idx] == EMPTY:
            return idx

    # 8. Empty side.
    for idx in SIDES:
        if board[idx] == EMPTY:
            return idx

    raise ValueError("no legal moves available")
