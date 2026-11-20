const DIAGONALS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];

function inside(r, c) {
  return r >= 0 && r < 8 && c >= 0 && c < 8;
}

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => piece ? { color: piece.color, king: Boolean(piece.king) } : null));
}

function cloneGame(game) {
  return {
    ...game,
    board: cloneBoard(game.board),
    players: (game.players || []).map((player) => ({ ...player })),
    lastMove: game.lastMove ? JSON.parse(JSON.stringify(game.lastMove)) : null,
    mustContinue: game.mustContinue ? { ...game.mustContinue } : null
  };
}

function makeInitialBoard() {
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = { color: "b", king: false };
    }
  }
  for (let r = 5; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if ((r + c) % 2 === 1) board[r][c] = { color: "w", king: false };
    }
  }
  return board;
}

function captureOptions(board, r, c, piece) {
  const options = [];
  if (!piece.king) {
    for (const [dr, dc] of DIAGONALS) {
      const enemyR = r + dr;
      const enemyC = c + dc;
      const landingR = r + dr * 2;
      const landingC = c + dc * 2;
      if (!inside(landingR, landingC) || !inside(enemyR, enemyC)) continue;
      const enemy = board[enemyR][enemyC];
      if (enemy && enemy.color !== piece.color && !board[landingR][landingC]) {
        options.push({ r: landingR, c: landingC, captured: { r: enemyR, c: enemyC } });
      }
    }
    return options;
  }

  for (const [dr, dc] of DIAGONALS) {
    let rr = r + dr;
    let cc = c + dc;
    while (inside(rr, cc) && !board[rr][cc]) {
      rr += dr;
      cc += dc;
    }
    if (!inside(rr, cc) || board[rr][cc].color === piece.color) continue;
    const captured = { r: rr, c: cc };
    rr += dr;
    cc += dc;
    while (inside(rr, cc) && !board[rr][cc]) {
      options.push({ r: rr, c: cc, captured });
      rr += dr;
      cc += dc;
    }
  }
  return options;
}

function capturesForPiece(board, startR, startC, piece) {
  const results = [];

  function explore(currentBoard, r, c, movingPiece, path, captures) {
    const options = captureOptions(currentBoard, r, c, movingPiece);
    if (!options.length) {
      if (captures.length) {
        results.push({
          from: { r: startR, c: startC },
          path,
          captures
        });
      }
      return;
    }

    for (const option of options) {
      const nextBoard = cloneBoard(currentBoard);
      const nextPiece = { ...movingPiece };
      nextBoard[r][c] = null;
      nextBoard[option.captured.r][option.captured.c] = null;
      if (!nextPiece.king && ((nextPiece.color === "w" && option.r === 0) ||
          (nextPiece.color === "b" && option.r === 7))) {
        nextPiece.king = true;
      }
      nextBoard[option.r][option.c] = nextPiece;
      explore(
        nextBoard,
        option.r,
        option.c,
        nextPiece,
        path.concat([{ r: option.r, c: option.c }]),
        captures.concat([{ r: option.captured.r, c: option.captured.c }])
      );
    }
  }

  explore(cloneBoard(board), startR, startC, piece, [], []);
  return results;
}

function normalMovesForPiece(board, r, c, piece) {
  const moves = [];
  if (piece.king) {
    for (const [dr, dc] of DIAGONALS) {
      let rr = r + dr;
      let cc = c + dc;
      while (inside(rr, cc) && !board[rr][cc]) {
        moves.push({ from: { r, c }, path: [{ r: rr, c: cc }], captures: [] });
        rr += dr;
        cc += dc;
      }
    }
    return moves;
  }

  const forward = piece.color === "w" ? -1 : 1;
  for (const dc of [-1, 1]) {
    const rr = r + forward;
    const cc = c + dc;
    if (inside(rr, cc) && !board[rr][cc]) {
      moves.push({ from: { r, c }, path: [{ r: rr, c: cc }], captures: [] });
    }
  }
  return moves;
}

export function getCheckersMoves(game, color = game.turn) {
  if (!game || !Array.isArray(game.board) || game.board.length !== 8) return [];
  const captures = [];
  const normalMoves = [];
  const only = game.mustContinue && game.turn === color ? game.mustContinue : null;

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = game.board[r][c];
      if (!piece || piece.color !== color) continue;
      if (only && (only.r !== r || only.c !== c)) continue;
      const jumps = capturesForPiece(game.board, r, c, piece);
      captures.push(...jumps);
      if (!only && !jumps.length) normalMoves.push(...normalMovesForPiece(game.board, r, c, piece));
    }
  }
  if (captures.length) return captures;
  if (only) return [];
  return normalMoves;
}

export function createCheckersGame(players) {
  if (!Array.isArray(players) || players.length !== 2) {
    throw new Error("Для партии нужны ровно два реальных игрока.");
  }
  const mapped = players.map((player, index) => ({
    telegramId: String(player.telegramId ?? player.telegram_id),
    name: String(player.name ?? player.display_name ?? "Игрок"),
    color: index === 0 ? "w" : "b",
    isOwner: Boolean(player.isOwner)
  }));
  if (!mapped[0].telegramId || !mapped[1].telegramId || mapped[0].telegramId === mapped[1].telegramId) {
    throw new Error("В комнате должны быть два разных игрока.");
  }
  return {
    board: makeInitialBoard(),
    players: mapped,
    turn: "w",
    turnTelegramId: mapped[0].telegramId,
    status: "playing",
    winner: null,
    lastMove: null,
    mustContinue: null,
    updatedAt: new Date().toISOString()
  };
}

export function applyCheckersStep(sourceGame, telegramId, fromValue, toValue) {
  const game = cloneGame(sourceGame);
  const userId = String(telegramId);
  if (game.status !== "playing") {
    const error = new Error("Партия уже завершена.");
    error.statusCode = 409;
    throw error;
  }
  if (String(game.turnTelegramId) !== userId) {
    const error = new Error("Сейчас ход другого игрока.");
    error.statusCode = 409;
    throw error;
  }

  function coordinate(value) {
    if (!value || !Number.isInteger(Number(value.r)) || !Number.isInteger(Number(value.c))) return null;
    const r = Number(value.r);
    const c = Number(value.c);
    return inside(r, c) ? { r, c } : null;
  }

  const from = coordinate(fromValue);
  const to = coordinate(toValue);
  if (!from || !to) {
    const error = new Error("Выбери клетку на шашечной доске.");
    error.statusCode = 400;
    throw error;
  }
  const piece = game.board[from.r][from.c];
  if (!piece || piece.color !== game.turn) {
    const error = new Error("Выбери свою шашку.");
    error.statusCode = 400;
    throw error;
  }

  const move = getCheckersMoves(game, game.turn).find((candidate) =>
    candidate.from.r === from.r && candidate.from.c === from.c &&
    candidate.path.length > 0 && candidate.path[0].r === to.r && candidate.path[0].c === to.c
  );
  if (!move) {
    const error = new Error(game.mustContinue
      ? "Продолжи обязательное взятие той же шашкой."
      : "Этот ход запрещён. Выбери подсвеченную клетку.");
    error.statusCode = 400;
    throw error;
  }

  const moving = { ...piece };
  game.board[from.r][from.c] = null;
  let captured = null;
  if (move.captures.length) {
    captured = move.captures[0];
    game.board[captured.r][captured.c] = null;
  }
  if (!moving.king && ((moving.color === "w" && to.r === 0) ||
      (moving.color === "b" && to.r === 7))) {
    moving.king = true;
  }
  game.board[to.r][to.c] = moving;
  game.lastMove = { from, to, captured };
  game.updatedAt = new Date().toISOString();

  const moverColor = game.turn;
  if (move.captures.length && captureOptions(game.board, to.r, to.c, moving).length) {
    game.mustContinue = { r: to.r, c: to.c };
    return game;
  }

  game.mustContinue = null;
  const nextColor = moverColor === "w" ? "b" : "w";
  const nextPlayer = game.players.find((player) => player.color === nextColor);
  const nextMoves = getCheckersMoves({ ...game, turn: nextColor, mustContinue: null }, nextColor);
  if (nextMoves.length === 0) {
    game.status = "finished";
    game.winner = moverColor;
    game.turnTelegramId = null;
    return game;
  }

  game.turn = nextColor;
  game.turnTelegramId = nextPlayer?.telegramId || null;
  return game;
}
