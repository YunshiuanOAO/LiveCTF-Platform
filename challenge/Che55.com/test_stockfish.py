from unittest.mock import patch

import chess

from app import engine_pick_move


def test_engine_routing():
    board = chess.Board()
    board.push_uci("e2e4")
    with patch("app.online_stockfish_pick_move", return_value=chess.Move.from_uci("e7e5")):
        assert engine_pick_move(board, {}) == ("normal", chess.Move.from_uci("e7e5"))
    with patch("app.custom_engine_pick_move", return_value="custom") as fallback:
        assert engine_pick_move(board, {chess.E2: chess.WHITE}) == "custom"
        fallback.assert_called_once()
    with patch("app.online_stockfish_pick_move", return_value=None) as api, \
         patch("app.custom_engine_pick_move", return_value="fallback") as fallback2:
        assert engine_pick_move(board, {}) == "fallback"
        api.assert_called_once()
        fallback2.assert_called_once()
    with patch("app.online_stockfish_pick_move", side_effect=RuntimeError("offline")), \
         patch("app.custom_engine_pick_move", return_value="offline-fallback") as fallback3:
        assert engine_pick_move(board, {}) == "offline-fallback"
        fallback3.assert_called_once()


if __name__ == "__main__":
    test_engine_routing()
    print("stockfish routing: ok")