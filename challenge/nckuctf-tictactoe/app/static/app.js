const EMPTY = ".";

const boardEl = document.querySelector("#board");
const chooserEl = document.querySelector("#chooser");
const arenaEl = document.querySelector("#arena");
const playerMarkEl = document.querySelector("#playerMark");
const botMarkEl = document.querySelector("#botMark");
const stateTextEl = document.querySelector("#stateText");
const roundBadgeEl = document.querySelector("#roundBadge");
const gameTitleEl = document.querySelector("#gameTitle");
const resetButton = document.querySelector("#resetButton");
const flagModal = document.querySelector("#flagModal");
const flagValue = document.querySelector("#flagValue");
const copyFlag = document.querySelector("#copyFlag");
const hintCard = document.querySelector("#hintCard");
const hintText = document.querySelector("#hintText");

let board = EMPTY.repeat(9);
let player = null;
let bot = null;
let locked = true;
let finished = false;

function buildBoard() {
  boardEl.replaceChildren();
  for (let i = 0; i < 9; i += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cell";
    button.dataset.index = String(i);
    button.setAttribute("role", "gridcell");
    button.setAttribute("aria-label", `Cell ${i + 1}`);
    button.addEventListener("click", () => humanMove(i));
    boardEl.appendChild(button);
  }
  renderBoard();
}

function renderBoard(lastMove = null) {
  [...boardEl.children].forEach((cell, i) => {
    const value = board[i];
    cell.textContent = value === EMPTY ? "" : value;
    cell.dataset.mark = value === EMPTY ? "" : value;
    cell.disabled = locked || finished || value !== EMPTY;
    cell.classList.toggle("flash", i === lastMove);
  });
}

async function callServer() {
  locked = true;
  stateTextEl.textContent = "AI THINKING";
  roundBadgeEl.textContent = "SYNC";
  renderBoard();

  const params = new URLSearchParams({ board, player });

  try {
    const response = await fetch(`api/play?${params.toString()}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });

    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.detail || `HTTP ${response.status}`);
    }

    const previous = board;
    board = data.board;
    const changedIndex = [...board].findIndex((mark, i) => mark !== previous[i]);
    renderBoard(changedIndex >= 0 ? changedIndex : null);

    if (data.status === "continue") {
      locked = false;
      stateTextEl.textContent = "YOUR TURN";
      roundBadgeEl.textContent = "LIVE";
      renderBoard(data.move);
      return;
    }

    finished = true;
    locked = true;
    roundBadgeEl.textContent = "END";
    renderBoard();

    if (data.hint) {
      hintText.textContent = data.hint;
      hintCard.hidden = false;
    }

    if (data.status === "win") {
      stateTextEl.textContent = "YOU WIN";
      roundBadgeEl.textContent = "PWNED";
      showFlag(data.flag);
    } else if (data.status === "lose") {
      stateTextEl.textContent = "AI WINS";
    } else {
      stateTextEl.textContent = "DRAW";
    }
  } catch (error) {
    locked = false;
    stateTextEl.textContent = "REQUEST FAILED";
    roundBadgeEl.textContent = "ERR";
    renderBoard();
  }
}

function humanMove(index) {
  if (locked || finished || !player || board[index] !== EMPTY) return;

  board = board.slice(0, index) + player + board.slice(index + 1);
  renderBoard(index);
  window.setTimeout(callServer, 170);
}

async function startGame(mark) {
  player = mark;
  bot = mark === "X" ? "O" : "X";
  board = EMPTY.repeat(9);
  finished = false;

  playerMarkEl.textContent = player;
  botMarkEl.textContent = bot;
  gameTitleEl.textContent = "Beat the machine";
  chooserEl.hidden = true;
  arenaEl.hidden = false;
  roundBadgeEl.textContent = "LIVE";
  hintCard.hidden = true;
  hintText.textContent = "";
  buildBoard();

  if (player === "O") {
    await callServer();
  } else {
    locked = false;
    stateTextEl.textContent = "YOUR TURN";
    renderBoard();
  }
}

function resetGame() {
  player = null;
  bot = null;
  board = EMPTY.repeat(9);
  locked = true;
  finished = false;
  boardEl.replaceChildren();
  arenaEl.hidden = true;
  chooserEl.hidden = false;
  gameTitleEl.textContent = "Choose your mark";
  roundBadgeEl.textContent = "READY";
  flagModal.hidden = true;
  hintCard.hidden = true;
  hintText.textContent = "";
}

function showFlag(flag) {
  flagValue.textContent = flag;
  flagModal.hidden = false;
}

document.querySelectorAll(".mark-btn").forEach((button) => {
  button.addEventListener("click", () => startGame(button.dataset.mark));
});

resetButton.addEventListener("click", resetGame);
copyFlag.addEventListener("click", async () => {
  await navigator.clipboard.writeText(flagValue.textContent);
  copyFlag.textContent = "COPIED";
});

buildBoard();
