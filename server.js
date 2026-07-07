// パーティゲーム・プラットフォーム
// 構成: server.js(玄関) + lib/(共通土台) + games/<type>/(ゲーム) + public/(画面)
const http = require("http");
const fs = require("fs");
const path = require("path");
const QRCode = require("qrcode");
const { PORT, rid, sendJSON, readBody, bestLanIP, isCloud, baseUrl } = require("./lib/util");
const roomsLib = require("./lib/rooms");

// ---------- ゲーム登録（新しいゲームはここに1行足す） ----------
const GAMES = {
  bingo: require("./games/bingo"),
};

roomsLib.load(GAMES);

// ---------- 静的ファイル ----------
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml" };
const PUBLIC_DIR = path.join(__dirname, "public");
function serveStatic(res, file) {
  const full = path.normalize(path.join(PUBLIC_DIR, file));
  if (!full.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

function redirect(res, to) {
  res.writeHead(302, { Location: to });
  res.end();
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- 旧URL互換（ビンゴ単体だった頃のリンク/QR） ---
  if (p === "/host") return redirect(res, "/bingo/host");
  if (p === "/join") return redirect(res, "/bingo/join" + url.search);

  // --- ページ ---
  if (p === "/") return serveStatic(res, "index.html");
  const page = p.match(/^\/([a-z0-9_-]+)\/(host|join)$/);
  if (page && GAMES[page[1]]) return serveStatic(res, `${page[1]}/${page[2]}.html`);

  // --- 共通API ---
  // ゲーム一覧（ランチャー用）
  if (p === "/api/games" && req.method === "GET") {
    const list = Object.values(GAMES).map((g) => ({
      type: g.type, title: g.title, icon: g.icon, description: g.description,
      hostUrl: `/${g.type}/host`,
    }));
    return sendJSON(res, 200, { games: list });
  }

  // ルーム作成
  if (p === "/api/rooms" && req.method === "POST") {
    const body = await readBody(req);
    const game = GAMES[body.gameType];
    if (!game) return sendJSON(res, 400, { error: "不明なゲームです" });
    const name = (body.name || game.title).slice(0, 40);
    const room = roomsLib.create(game.type, name, game.createState());
    const joinUrl = `${baseUrl(req)}/${game.type}/join?t=${room.id}`;
    const qr = await QRCode.toDataURL(joinUrl, { width: 320, margin: 2 });
    return sendJSON(res, 200, { tid: room.id, name: room.name, gameType: game.type, joinUrl, qr });
  }

  // 参加フォーム用：ルーム名だけを返す（軽量）
  if (p === "/api/room-info" && req.method === "GET") {
    const room = roomsLib.get(url.searchParams.get("t"));
    if (!room) return sendJSON(res, 404, { error: "ルームが見つかりません" });
    return sendJSON(res, 200, { name: room.name, gameType: room.gameType });
  }

  // ルームに参加
  if (p === "/api/rooms/join" && req.method === "POST") {
    const body = await readBody(req);
    const room = roomsLib.get(body.tid);
    if (!room) return sendJSON(res, 404, { error: "ルームが見つかりません。QRを読み直してください。" });
    const game = GAMES[room.gameType];
    const pid = rid(8);
    room.players[pid] = { name: (body.name || "").slice(0, 20), ...game.createPlayerData(room) };
    roomsLib.save();
    return sendJSON(res, 200, {
      pid, name: room.players[pid].name, tName: room.name, gameType: room.gameType,
      ...(game.joinResponse ? game.joinResponse(room, pid) : {}),
    });
  }

  // ルームを終了（データ削除）
  if (p === "/api/rooms/end" && req.method === "POST") {
    if (!roomsLib.remove(url.searchParams.get("t"))) return sendJSON(res, 404, { error: "ルームが見つかりません" });
    return sendJSON(res, 200, { ok: true });
  }

  // ホスト画面復元用：QRを再発行
  if (p === "/api/qr" && req.method === "GET") {
    const room = roomsLib.get(url.searchParams.get("t"));
    if (!room) return sendJSON(res, 404, { error: "ルームが見つかりません" });
    const joinUrl = `${baseUrl(req)}/${room.gameType}/join?t=${room.id}`;
    const qr = await QRCode.toDataURL(joinUrl, { width: 320, margin: 2 });
    return sendJSON(res, 200, { name: room.name, gameType: room.gameType, joinUrl, qr });
  }

  // --- ゲーム別API（/api/<type>/…） ---
  const gm = p.match(/^\/api\/([a-z0-9_-]+)(\/.+)$/);
  if (gm && GAMES[gm[1]]) {
    const handled = await GAMES[gm[1]].handle(req, res, url, gm[2]);
    if (handled) return;
  }

  // --- その他の静的ファイル ---
  if (req.method === "GET" && !p.startsWith("/api/")) return serveStatic(res, p.slice(1));

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  const names = Object.values(GAMES).map((g) => g.title).join(", ");
  if (isCloud()) {
    console.log(`パーティゲームサーバー起動（クラウド）: port ${PORT} / ゲーム: ${names}` +
      (process.env.BASE_URL ? ` / BASE_URL=${process.env.BASE_URL}` : ""));
    return;
  }
  const { ip, all } = bestLanIP();
  console.log("\n========================================");
  console.log("  🎉 パーティゲームサーバーが起動しました");
  console.log(`  ゲーム: ${names}`);
  console.log("========================================");
  console.log(`  司会PC（この画面）:  http://localhost:${PORT}`);
  console.log(`  参加者URL（自動QR）:  http://${ip}:${PORT}`);
  if (all.length > 1) console.log(`  ※ 他の候補IP: ${all.join(", ")}`);
  console.log("========================================");
  console.log("  終了するには この画面で Ctrl+C を押してください\n");
});
