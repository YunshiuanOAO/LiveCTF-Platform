// Che55.com - vanilla.js frontend. No framework, no build step.
let gameId = null;
let board = {};       // {"e2": "P", "e7": "p", ...} C = white cannon
let selected = null;
let legalCache = [];
let flipped = false;
let boardUi = null;

const PIECE_CODE = {
  K: "wK", Q: "wQ", R: "wR", B: "wB", N: "wN", P: "wP", C: "wR",
  k: "bK", q: "bQ", r: "bR", b: "bB", n: "bN", p: "bP", c: "bR",
};

function cannonImage(piece) {
  const color = piece === "C" ? "#a51f18" : "#202624";
  const glyph = piece === "C" ? "炮" : "砲";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
    <defs>
      <radialGradient id="wood" cx="38%" cy="30%" r="70%"><stop stop-color="#fff3cf"/><stop offset=".7" stop-color="#e8c98d"/><stop offset="1" stop-color="#c99d5e"/></radialGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="4" stdDeviation="3" flood-color="#24170d" flood-opacity=".55"/></filter>
    </defs>
    <g filter="url(#shadow)">
      <circle cx="50" cy="47" r="41" fill="url(#wood)" stroke="#6f4827" stroke-width="3"/>
      <circle cx="50" cy="47" r="35" fill="none" stroke="${color}" stroke-width="2.4"/>
      <circle cx="50" cy="47" r="31" fill="none" stroke="${color}" stroke-width="1" opacity=".45"/>
      <text x="50" y="65" text-anchor="middle" font-family="Noto Serif TC,Songti TC,PMingLiU,serif" font-size="49" font-weight="900" fill="${color}">${glyph}</text>
    </g>
  </svg>`;
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

async function refreshMe() {
  try {
    const r = await fetch("/api/me");
    const j = await r.json();
    document.getElementById("meBadge").textContent = "玩家：" + (j.user === "guest" ? "訪客" : j.user);
    document.getElementById("vipBadge").textContent = j.vip ? "VIP：是" : "VIP：否";
  } catch (e) { /* ignore */ }
}

async function newGame() {
  const r = await fetch("/api/new_game", { method: "POST" });
  const j = await r.json();
  gameId = j.game_id;
  board = j.board;
  selected = null;
  document.getElementById("gameBadge").textContent = "對局：" + gameId.slice(0, 8);
  hideEnd();
  render();
  refreshMe();
}

function render(animate = true) {
  const position = {};
  for (const [square, piece] of Object.entries(board)) {
    position[square] = PIECE_CODE[piece];
  }
  boardUi.orientation(flipped ? "black" : "white");
  boardUi.position(position, animate);
  decorateBoard();
}

function decorateBoard() {
  document.querySelectorAll("#board [data-square]").forEach((square) => {
    const name = square.dataset.square;
    square.classList.toggle("sel", selected === name);
    square.classList.toggle("dest", legalCache.includes(name) && !board[name]);
    square.classList.toggle("cap", legalCache.includes(name) && !!board[name]);
    if (board[name] === "C" || board[name] === "c") {
      const image = square.querySelector("img");
      if (image) image.src = cannonImage(board[name]);
    }
  });
}

// End-of-game: circle the mated/captured king with an X and show a Win/Lose overlay.
function showEnd(markerSquare, result) {
  const ov = document.getElementById("gameOver");
  if (!ov) return;
  ov.innerHTML =
    '<div class="title">' + (result === "win" ? "You Win" : "You Lose") + "</div>" +
    '<div class="hint">按「＋ 開始新局」再來一局</div>';
  ov.className = "game-over " + (result === "win" ? "win" : "lose");
  ov.hidden = false;
  if (markerSquare) {
    const el = document.querySelector('#board [data-square="' + markerSquare + '"]');
    if (el) el.classList.add("mate");
  }
}

function hideEnd() {
  const ov = document.getElementById("gameOver");
  if (ov) ov.hidden = true;
  document.querySelectorAll("#board [data-square].mate").forEach((el) => el.classList.remove("mate"));
}

// status: "white_wins_*" => You Win (black king mated), "black_wins_*" => You Lose (own king mated).
function handleGameEnd(j, whiteTo) {
  const st = j.status || "";
  let result = null;
  let marker = null;
  if (st.startsWith("white_wins")) result = "win";
  else if (st.startsWith("black_wins")) result = "lose";
  else return;
  if (st.includes("king_captured")) {
    // king is off the board; the target of the capturing move holds its square
    if (result === "win") {
      marker = whiteTo;
    } else {
      const mv = j.black_move || "";
      const tgt = mv.slice(-2);
      marker = /^[a-h][1-8]$/.test(tgt) ? tgt : null;
    }
  } else {
    // mate / vip: the losing king is still on the board
    const king = result === "win" ? "k" : "K";
    for (const sq of Object.keys(board)) {
      if (board[sq] === king) { marker = sq; break; }
    }
  }
  showEnd(marker, result);
}

async function onSquare(name) {
  if (!gameId) return;
  if (selected && legalCache.includes(name)) {
    await doMove(selected, name);
    return;
  }
  // select own piece?
  const p = board[name];
  const isWhite = p && (p === p.toUpperCase() || p === "C");
  if (isWhite) {
    selected = name;
    await loadLegal(name);
    render();
  } else if (selected) {
    selected = null; legalCache = []; render();
  }
}

async function loadLegal(name) {
  const r = await fetch("/api/legal_moves?game_id=" + gameId + "&square=" + name);
  const j = await r.json();
  legalCache = j.moves || [];
}

async function doMove(from, to, dragged = false) {
  const promo = document.getElementById("promo").value;
  selected = null;
  legalCache = [];
  if (!dragged) boardUi.move(from + "-" + to, false);
  decorateBoard();
  const r = await fetch("/api/move", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_id: gameId, from, to, promotion: promo }),
  });
  const j = await r.json();
  if (j.error) { render(false); return; }
  board = j.board;
  if (j.flag) {
    const guide = document.getElementById("winGuide");
    if (guide) guide.innerHTML = j.message;
  }
  render();
  handleGameEnd(j, to);
}

async function doVipReplace(square) {
  document.getElementById("vipMsg").textContent = "正在替換 " + square + "……";
  const r = await fetch("/api/vip_replace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ game_id: gameId, square }),
  });
  const j = await r.json();
  if (j.error) {
    document.getElementById("vipMsg").textContent = "替換失敗：" + j.error;
    return;
  }
  board = j.board;
  if (j.flag) {
    const guide = document.getElementById("winGuide");
    if (guide) guide.innerHTML = j.message;
  } else {
    document.getElementById("vipMsg").textContent = j.message;
  }
  selected = null; legalCache = [];
  render();
  handleGameEnd(j, null);
  refreshMe();
}

boardUi = Chessboard("board", {
  draggable: true,
  position: {},
  moveSpeed: 450,
  snapSpeed: 0,
  snapbackSpeed: 0,
  appearSpeed: 300,
  pieceTheme: "https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png",
  onDragStart: (source) => {
    const piece = board[source];
    return !!gameId && !!piece && piece === piece.toUpperCase();
  },
  onDrop: (source, target) => {
    if (target === "offboard" || source === target) return "snapback";
    doMove(source, target, true);
  },
  onMoveEnd: decorateBoard,
});

// chessboardjs replaces #board's contents on init, so the win/lose overlay
// must be injected into the container afterwards.
{
  const ov = document.createElement("div");
  ov.id = "gameOver";
  ov.className = "game-over";
  ov.hidden = true;
  document.getElementById("board").appendChild(ov);
}

document.getElementById("board").addEventListener("click", (event) => {
  const square = event.target.closest("[data-square]");
  if (square) onSquare(square.dataset.square);
});
window.addEventListener("resize", boardUi.resize);
document.getElementById("btnNew").addEventListener("click", newGame);
document.getElementById("btnFlip").addEventListener("click", () => { flipped = !flipped; render(); });
document.getElementById("btnVip").addEventListener("click", () => doVipReplace("e2"));

refreshMe();
render();
