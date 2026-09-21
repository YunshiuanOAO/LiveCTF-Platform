"""Che55.com - rigged chess vs engine + VIP cannon (Pao) CTF challenge."""
import copy
import json
import os
import random
import string
import urllib.parse
import urllib.request

import chess
from flask import Flask, jsonify, request, send_from_directory, make_response

app = Flask(__name__, static_folder="static", static_url_path="/static")

FLAG = os.environ.get("FLAG", "flag{che55_c4nn0n_p4o_m4te_e2xe8}")
STOCKFISH_URL = os.environ.get("STOCKFISH_URL", "https://stockfish.online/api/s/v2.php")
STOCKFISH_DEPTH = int(os.environ.get("STOCKFISH_DEPTH", "15"))
STOCKFISH_TIMEOUT = float(os.environ.get("STOCKFISH_TIMEOUT", "10"))

# In-memory games: game_id -> dict(board=chess.Board, cannons={square:int color}, vip_used=bool, status, history)
GAMES = {}

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
    chess.KING: 20000,
}
CANNON_VALUE = 550


def new_game_id(n=16):
    return "".join(random.choice(string.ascii_letters + string.digits) for _ in range(n))


def is_vip():
    return request.cookies.get("user") == "vip"


def cannons_of(board_state, color):
    return [sq for sq, c in board_state["cannons"].items() if c == color]


def occupied(board, cannons, sq):
    """Any piece (normal or cannon) occupies sq."""
    if sq in cannons:
        return True
    return board.piece_at(sq) is not None


def piece_color_at(board, cannons, sq):
    if sq in cannons:
        return cannons[sq]
    p = board.piece_at(sq)
    if p is None:
        return None
    return p.color


def attacked_by_cannon(board, cannons, target, by_color):
    """Xiangqi Pao attack: same rank/file, exactly one screen between."""
    tf = chess.square_file(target)
    tr = chess.square_rank(target)
    for csq in cannons_of({"cannons": cannons}, by_color):
        cf = chess.square_file(csq)
        cr = chess.square_rank(csq)
        if cf == tf:
            step = 1 if tr > cr else -1
            screens = 0
            r = cr + step
            while r != tr:
                sq = chess.square(cf, r)
                if occupied(board, cannons, sq):
                    screens += 1
                r += step
            if screens == 1:
                return True
        elif cr == tr:
            step = 1 if tf > cf else -1
            screens = 0
            f = cf + step
            while f != tf:
                sq = chess.square(f, cr)
                if occupied(board, cannons, sq):
                    screens += 1
                f += step
            if screens == 1:
                return True
    return False


def in_check(board, cannons, color):
    king = board.king(color)
    if king is None:
        return True
    if board.is_attacked_by(not color, king):
        return True
    if attacked_by_cannon(board, cannons, king, not color):
        return True
    return False


def cannon_pseudo_moves(board, cannons, src, include_king_capture=True):
    """Generate Xiangqi-cannon pseudo moves from src. src must hold a cannon."""
    color = cannons.get(src)
    if color is None:
        return []
    moves = []
    f0 = chess.square_file(src)
    r0 = chess.square_rank(src)
    for df, dr in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        # Phase 1: non-capturing rook slides before the screen
        f, r = f0 + df, r0 + dr
        screen_found = False
        while 0 <= f <= 7 and 0 <= r <= 7:
            sq = chess.square(f, r)
            if not screen_found:
                if not occupied(board, cannons, sq):
                    moves.append((src, sq, False))
                else:
                    screen_found = True
            else:
                # Phase 2: after screen, first piece must be capture
                if occupied(board, cannons, sq):
                    target_color = piece_color_at(board, cannons, sq)
                    if target_color is not None and target_color != color:
                        p = board.piece_at(sq)
                        is_king = p is not None and p.piece_type == chess.KING
                        if is_king and not include_king_capture:
                            pass
                        else:
                            moves.append((src, sq, True))
                    break  # only first piece beyond screen is reachable
            f += df
            r += dr
    return moves


def all_white_cannon_targets(board, cannons, src):
    return [dst for _, dst, _ in cannon_pseudo_moves(board, cannons, src)]


def legal_normal_moves_filtered(board, cannons, color):
    """python-chess legal moves further filtered against cannon checks."""
    out = []
    # iterate over a snapshot to avoid mutation issues
    for m in list(board.legal_moves):
        if board.turn != color:
            continue
        # simulate
        b2 = board.copy()
        b2.push(m)
        if in_check(b2, cannons, color):
            continue
        out.append(m)
    return out


def all_legal_moves_for(board, cannons, color):
    """All legal moves for color: filtered normal moves + legal cannon moves."""
    moves = []  # list of ("normal", chess.Move) or ("cannon", src, dst, is_capture)
    if board.turn != color:
        # allow cannon moves even if turn mismatch? No - strict turn.
        pass
    for m in legal_normal_moves_filtered(board, cannons, color):
        moves.append(("normal", m))
    if board.turn == color:
        for src in cannons_of({"cannons": cannons}, color):
            for s, d, is_cap in cannon_pseudo_moves(board, cannons, src):
                # simulate cannon move
                b2 = board.copy()
                c2 = dict(cannons)
                captured_king = False
                p = b2.piece_at(d)
                if p is not None and p.piece_type == chess.KING and p.color != color:
                    captured_king = True
                # apply
                if d in c2:
                    del c2[d]
                b2.remove_piece_at(d)
                del c2[s]
                c2[d] = color
                if captured_king:
                    moves.append(("cannon", s, d, is_cap))
                    continue
                if in_check(b2, c2, color):
                    continue
                moves.append(("cannon", s, d, is_cap))
    return moves


def evaluate(board, cannons):
    score = 0
    for sq, piece in board.piece_map().items():
        v = PIECE_VALUES[piece.piece_type]
        # tiny center bonus for pawns/knights
        score += v if piece.color == chess.BLACK else -v
    for sq, color in cannons.items():
        score += CANNON_VALUE if color == chess.BLACK else -CANNON_VALUE
    # mobility micro-term
    try:
        mob = len(list(board.legal_moves))
        score += mob if board.turn == chess.BLACK else -mob
    except Exception:
        pass
    return score  # positive favors black (engine)


def engine_pick_move(board, cannons, depth=3):
    """Use the stockfish.online API for standard chess; fall back for the custom cannon variant."""
    if not cannons:
        try:
            move = online_stockfish_pick_move(board)
            if move is not None:
                return ("normal", move)
        except Exception as exc:
            app.logger.warning("Stockfish API unavailable, using built-in engine: %s", exc)
    return custom_engine_pick_move(board, cannons, depth)


def online_stockfish_pick_move(board):
    """Query stockfish.online for the best UCI move from a FEN. Returns a chess.Move or None."""
    params = {"fen": board.fen(), "depth": STOCKFISH_DEPTH}
    url = STOCKFISH_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=STOCKFISH_TIMEOUT) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if not data.get("success"):
        raise RuntimeError("stockfish.online: %s" % data.get("error", "unknown error"))
    tokens = (data.get("bestmove") or "").strip().split()
    if "bestmove" in tokens:
        idx = tokens.index("bestmove")
        uci = tokens[idx + 1] if idx + 1 < len(tokens) else ""
    else:
        uci = tokens[0] if tokens else ""
    if uci in ("", "0000"):
        return None
    return chess.Move.from_uci(uci)


def custom_engine_pick_move(board, cannons, depth=3):
    """Alpha-beta negamax from black's perspective. Returns ('normal', Move) or ('cannon', s, d)."""
    moves = all_legal_moves_for(board, cannons, chess.BLACK)
    if not moves:
        return None
    # order: captures first
    def order_key(mv):
        if mv[0] == "normal":
            m = mv[1]
            return 1 if board.piece_at(m.to_square) else 0
        else:
            _, s, d = mv[0], mv[1], mv[2]
            return 1 if occupied(board, cannons, d) else 0
    moves.sort(key=order_key, reverse=True)

    best = None
    best_score = -10**12
    alpha = -10**12
    for mv in moves:
        b2 = board.copy()
        c2 = dict(cannons)
        apply_move_to_state(b2, c2, chess.BLACK, mv)
        # after black move, white to move; check terminal
        if b2.king(chess.WHITE) is None:
            score = 10**9  # black captured white king (shouldn't happen)
        else:
            score = -negamax(b2, c2, depth - 1, -10**12, -alpha, chess.WHITE)
        # small noise to vary play
        score += random.randint(-4, 4)
        if score > best_score:
            best_score = score
            best = mv
        alpha = max(alpha, score)
    return best


def negamax(board, cannons, depth, alpha, beta, turn):
    # terminal: king missing
    if board.king(chess.WHITE) is None:
        return 10**9 if turn == chess.BLACK else -10**9
    if board.king(chess.BLACK) is None:
        return 10**9 if turn == chess.WHITE else -10**9
    # checkmate / stalemate on normal board (approx; cannon mates handled by search leaves)
    if board.is_checkmate():
        # side to move is mated
        return -10**8 - depth if turn == board.turn else 10**8 + depth
    if board.is_stalemate() or board.is_insufficient_material() or board.is_seventyfive_moves():
        return 0
    if depth <= 0:
        ev = evaluate(board, cannons)
        return ev if turn == chess.BLACK else -ev

    moves = all_legal_moves_for(board, cannons, turn)
    if not moves:
        # no legal moves: mated or stalemate (including cannon check)
        if in_check(board, cannons, turn):
            return -10**8 - depth
        return 0
    # cap branching for speed
    if len(moves) > 40:
        # keep captures + random sample
        caps = [m for m in moves if _is_capture(board, cannons, m)]
        others = [m for m in moves if m not in caps]
        random.shuffle(others)
        moves = caps + others[:40 - len(caps)]
    best = -10**12
    for mv in moves:
        b2 = board.copy()
        c2 = dict(cannons)
        apply_move_to_state(b2, c2, turn, mv)
        val = -negamax(b2, c2, depth - 1, -beta, -alpha, not turn)
        best = max(best, val)
        alpha = max(alpha, val)
        if alpha >= beta:
            break
    return best


def _is_capture(board, cannons, mv):
    if mv[0] == "normal":
        m = mv[1]
        return board.piece_at(m.to_square) is not None
    else:
        return occupied(board, cannons, mv[2])


def apply_move_to_state(board, cannons, color, mv):
    """Apply mv (tuple form) to board+cannons in place. Assumes legality checked."""
    if mv[0] == "normal":
        board.push(mv[1])
    else:
        _, s, d, _is_cap = mv
        if d in cannons:
            del cannons[d]
        board.remove_piece_at(d)
        del cannons[s]
        cannons[d] = color
        board.turn = not color


def board_to_payload(board, cannons):
    grid = {}
    for sq, piece in board.piece_map().items():
        grid[chess.square_name(sq)] = piece.symbol()
    for sq, color in cannons.items():
        grid[chess.square_name(sq)] = "C" if color == chess.WHITE else "c"
    return grid


def game_status(board, cannons):
    # king captured cases
    if board.king(chess.BLACK) is None:
        return "white_wins_king_captured"
    if board.king(chess.WHITE) is None:
        return "black_wins_king_captured"
    moves_w = all_legal_moves_for(board, cannons, board.turn) if board.turn == chess.WHITE else None
    moves_b = all_legal_moves_for(board, cannons, board.turn) if board.turn == chess.BLACK else None
    cur_moves = moves_w if board.turn == chess.WHITE else moves_b
    if cur_moves is not None and len(cur_moves) == 0:
        if in_check(board, cannons, board.turn):
            return "white_wins_mate" if board.turn == chess.BLACK else "black_wins_mate"
        return "draw_stalemate"
    if board.is_insufficient_material() and not cannons:
        return "draw_material"
    return "ongoing"


@app.route("/")
def index():
    resp = make_response(send_from_directory("static", "index.html"))
    if not request.cookies.get("user"):
        resp.set_cookie("user", "guest")
    return resp


@app.route("/api/me")
def me():
    return jsonify({"user": request.cookies.get("user", "guest"), "vip": is_vip()})


@app.route("/api/new_game", methods=["POST"])
def new_game():
    gid = new_game_id()
    board = chess.Board()
    GAMES[gid] = {
        "board": board,
        "cannons": {},
        "vip_used": False,
        "history": [],
        "status": "ongoing",
    }
    resp = make_response(jsonify({
        "game_id": gid,
        "board": board_to_payload(board, {}),
        "fen": board.fen(),
        "turn": "white",
        "status": "ongoing",
    }))
    if not request.cookies.get("user"):
        resp.set_cookie("user", "guest")
    return resp


@app.route("/api/state")
def state():
    gid = request.args.get("game_id", "")
    g = GAMES.get(gid)
    if not g:
        return jsonify({"error": "無效的對局 ID"}), 404
    board = g["board"]
    cannons = g["cannons"]
    st = game_status(board, cannons)
    g["status"] = st
    return jsonify({
        "board": board_to_payload(board, cannons),
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "status": st,
        "vip": is_vip(),
        "vip_used": g["vip_used"],
        "history": g["history"][-20:],
        "in_check": in_check(board, cannons, board.turn),
    })


@app.route("/api/legal_moves")
def legal_moves():
    gid = request.args.get("game_id", "")
    square = request.args.get("square", "").strip().lower()
    g = GAMES.get(gid)
    if not g:
        return jsonify({"error": "無效的對局 ID"}), 404
    try:
        src = chess.parse_square(square)
    except Exception:
        return jsonify({"error": "無效的棋盤座標"}), 400
    board = g["board"]
    cannons = g["cannons"]
    if board.turn != chess.WHITE:
        return jsonify({"moves": []})
    dests = []
    if src in cannons and cannons[src] == chess.WHITE:
        for s, d, _cap in cannon_pseudo_moves(board, cannons, src):
            b2 = board.copy()
            c2 = dict(cannons)
            p = b2.piece_at(d)
            captured_king = p is not None and p.piece_type == chess.KING and p.color == chess.BLACK
            if d in c2:
                del c2[d]
            b2.remove_piece_at(d)
            del c2[s]
            c2[d] = chess.WHITE
            if captured_king:
                dests.append(chess.square_name(d))
                continue
            if not in_check(b2, c2, chess.WHITE):
                dests.append(chess.square_name(d))
        return jsonify({"moves": dests})
    # normal piece
    for m in legal_normal_moves_filtered(board, cannons, chess.WHITE):
        if m.from_square == src:
            # filter promotion display duplicates
            dests.append(chess.square_name(m.to_square))
    return jsonify({"moves": sorted(set(dests))})


@app.route("/api/move", methods=["POST"])
def move():
    data = request.get_json(force=True, silent=True) or {}
    gid = data.get("game_id", "")
    frm = (data.get("from") or "").strip().lower()
    to = (data.get("to") or "").strip().lower()
    promo = (data.get("promotion") or "q").strip().lower()
    g = GAMES.get(gid)
    if not g:
        return jsonify({"error": "無效的對局 ID"}), 404
    board = g["board"]
    cannons = g["cannons"]
    if g["status"] not in ("ongoing",):
        # recompute in case
        st = game_status(board, cannons)
        g["status"] = st
        if st != "ongoing":
            return jsonify({"error": "對局已結束", "status": st}), 400
    if board.turn != chess.WHITE:
        return jsonify({"error": "還沒輪到你"}), 400
    try:
        s = chess.parse_square(frm)
        d = chess.parse_square(to)
    except Exception:
        return jsonify({"error": "無效的棋盤座標"}), 400

    white_move = None
    white_san = ""
    # cannon move?
    if s in cannons and cannons[s] == chess.WHITE:
        found = None
        for cs, cd, is_cap in cannon_pseudo_moves(board, cannons, s):
            if cd == d:
                found = (cs, cd, is_cap)
                break
        if not found:
            return jsonify({"error": "炮的走法不合法"}), 400
        # king-safety (unless capturing king -> instant win)
        p = board.piece_at(d)
        captured_king = p is not None and p.piece_type == chess.KING and p.color == chess.BLACK
        if not captured_king:
            b2 = board.copy()
            c2 = dict(cannons)
            if d in c2:
                del c2[d]
            b2.remove_piece_at(d)
            del c2[s]
            c2[d] = chess.WHITE
            if in_check(b2, c2, chess.WHITE):
                return jsonify({"error": "走棋後國王仍被將軍"}), 400
        white_move = ("cannon", s, d, found[2])
        white_san = f"C{frm}x{to}" if found[2] else f"C{frm}-{to}"
        # apply
        if d in cannons:
            del cannons[d]
        cap = board.piece_at(d)
        board.remove_piece_at(d)
        del cannons[s]
        cannons[d] = chess.WHITE
        board.turn = chess.BLACK
        if captured_king:
            g["history"].append(f"White {white_san} captures KING")
            g["status"] = "white_wins_king_captured"
            return jsonify({
                "board": board_to_payload(board, cannons),
                "turn": "white",
                "status": g["status"],
                "white_move": white_san,
                "black_move": None,
                "flag": FLAG,
                "message": "炮直接吃掉黑王！這是你的 Flag。",
            })
    else:
        # normal move: find matching legal move (handle promotion)
        cands = [m for m in legal_normal_moves_filtered(board, cannons, chess.WHITE)
                 if m.from_square == s and m.to_square == d]
        if not cands:
            return jsonify({"error": "不合法的走法"}), 400
        chosen = cands[0]
        # pick promotion piece if multiple
        if len(cands) > 1:
            pmap = {"q": chess.QUEEN, "r": chess.ROOK, "b": chess.BISHOP, "n": chess.KNIGHT}
            want = pmap.get(promo, chess.QUEEN)
            for m in cands:
                if m.promotion == want:
                    chosen = m
                    break
        try:
            white_san = board.san(chosen)
        except Exception:
            white_san = f"{frm}-{to}"
        board.push(chosen)
        white_move = ("normal", chosen)

    g["history"].append(f"White {white_san}")

    # did white win?
    st = game_status(board, cannons)
    if st.startswith("white_wins"):
        g["status"] = st
        return jsonify({
            "board": board_to_payload(board, cannons),
            "turn": "white",
            "status": st,
            "white_move": white_san,
            "black_move": None,
            "flag": FLAG,
            "message": "將死！你擊敗了引擎，這是你的 Flag。",
        })
    if st.startswith("draw"):
        g["status"] = st
        return jsonify({"board": board_to_payload(board, cannons), "turn": "black",
                        "status": st, "white_move": white_san, "black_move": None})

    # engine (black) replies
    eng = engine_pick_move(board, cannons, depth=3)
    black_san = None
    if eng is None:
        st2 = game_status(board, cannons)
        g["status"] = st2
        if st2.startswith("white_wins"):
            return jsonify({"board": board_to_payload(board, cannons), "turn": "white",
                            "status": st2, "white_move": white_san, "black_move": None,
                            "flag": FLAG, "message": "將死！這是你的 Flag。"})
        return jsonify({"board": board_to_payload(board, cannons), "turn": "white" if board.turn == chess.WHITE else "black",
                        "status": st2, "white_move": white_san, "black_move": None})
    if eng[0] == "normal":
        try:
            black_san = board.san(eng[1])
        except Exception:
            black_san = board.uci(eng[1])
        board.push(eng[1])
    else:
        _, es, ed, _cap = eng
        cap = board.piece_at(ed)
        ccap = ed in cannons
        if cap is not None and cap.piece_type == chess.KING and cap.color == chess.WHITE:
            # engine captures white king (should be mate) - user loses
            if ed in cannons:
                del cannons[ed]
            board.remove_piece_at(ed)
            del cannons[es]
            cannons[ed] = chess.BLACK
            board.turn = chess.WHITE
            g["history"].append(f"Black C{chess.square_name(es)}x{chess.square_name(ed)} captures KING")
            g["status"] = "black_wins_king_captured"
            return jsonify({"board": board_to_payload(board, cannons), "turn": "white",
                            "status": g["status"], "white_move": white_san,
                            "black_move": f"C{chess.square_name(es)}x{chess.square_name(ed)}",
                            "message": "引擎將死了你，你輸了。"})
        if ed in cannons:
            del cannons[ed]
        board.remove_piece_at(ed)
        del cannons[es]
        cannons[ed] = chess.BLACK
        board.turn = chess.WHITE
        black_san = f"C{chess.square_name(es)}x{chess.square_name(ed)}" if (cap or ccap) else f"C{chess.square_name(es)}-{chess.square_name(ed)}"
    g["history"].append(f"Black {black_san}")

    st2 = game_status(board, cannons)
    g["status"] = st2
    msg = None
    if st2.startswith("black_wins"):
        msg = "引擎將死了你，你輸了。（公平對局中，引擎從不落敗……除非規則改變。）"
    return jsonify({
        "board": board_to_payload(board, cannons),
        "fen": board.fen(),
        "turn": "white" if board.turn == chess.WHITE else "black",
        "status": st2,
        "white_move": white_san,
        "black_move": black_san,
        "message": msg,
    })


@app.route("/api/vip_replace", methods=["POST"])
def vip_replace():
    # INTENDED VULN: VIP checked only via client-controlled cookie
    if not is_vip():
        return jsonify({"error": "僅限 VIP。（提示：誰決定你是不是 VIP？）"}), 403
    data = request.get_json(force=True, silent=True) or {}
    gid = data.get("game_id", "")
    square = (data.get("square") or "").strip().lower()
    g = GAMES.get(gid)
    if not g:
        return jsonify({"error": "無效的對局 ID"}), 404
    if g["vip_used"]:
        return jsonify({"error": "本局已使用過替換卡"}), 400
    board = g["board"]
    cannons = g["cannons"]
    if board.ply() != 0:
        return jsonify({"error": "炮兵卡僅能在開局時使用，本局已開始"}), 400
    try:
        sq = chess.parse_square(square)
    except Exception:
        return jsonify({"error": "無效的棋盤座標"}), 400
    if sq in cannons:
        return jsonify({"error": "該棋子已經是炮"}), 400
    p = board.piece_at(sq)
    if p is None or p.color != chess.WHITE:
        return jsonify({"error": "請選擇你自己的棋子"}), 400
    if p.piece_type == chess.KING:
        return jsonify({"error": "不能替換你的國王"}), 400
    board.remove_piece_at(sq)
    cannons[sq] = chess.WHITE
    g["vip_used"] = True
    g["history"].append(f"VIP: {square} -> Cannon(Pao)")
    
    # 檢查 e2 炮是否可直接吃黑王 (e8)
    flag = None
    if square == "e2":
        # 炮在 e2，黑王在 e8，中間恰好一子 (e7 黑兵) -> 直接將死
        if board.piece_at(chess.E7) and board.piece_at(chess.E7).piece_type == chess.PAWN and board.piece_at(chess.E7).color == chess.BLACK:
            if board.king(chess.BLACK) == chess.E8:
                flag = FLAG
    
    st = game_status(board, cannons)
    if flag:
        g["status"] = "white_wins_vip"
        return jsonify({
            "board": board_to_payload(board, cannons),
            "status": g["status"],
            "flag": flag,
            "message": "你的砲瞄準了我的國王！我的王躲不開，也沒有任何棋子可以擋住你的攻擊。是你贏了，這是你的 Flag: " + flag,
        })
    
    # don't auto-end; replacing into check is allowed - white still to move
    return jsonify({
        "board": board_to_payload(board, cannons),
        "status": g["status"],
        "message": f"已將 {square} 替換成炮。它可像城堡直線移動，吃子時必須恰好跳過一枚棋子。試試 C e2×e8……",
    })


@app.route("/<path:_p>")
def fallback(_p):
    return send_from_directory("static", "index.html")


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000)
