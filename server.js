// QR参加型ビンゴ大会サーバー（依存: qrcode のみ）
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;
const LETTERS = ["B", "I", "N", "G", "O"];
const RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];

// ---------- 状態（ファイルに自動保存・起動時に復元） ----------
const DATA_FILE = path.join(__dirname, "bingo-data.json");
const tournaments = {}; // tid -> { name, called:[], players:{ pid:{name,card,marked} }, winners:[{pid,name,at}] }
try {
  const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  Object.assign(tournaments, loaded);
  for (const tid in tournaments) {
    tournaments[tid].winners = tournaments[tid].winners || [];
    tournaments[tid].pending = null; // 復元時は未公開の1個は破棄（引き直し）
  }
  console.log(`保存データを復元しました（大会 ${Object.keys(tournaments).length} 件）`);
} catch { /* 初回起動などファイルなしはOK */ }

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(tournaments), (err) => {
      if (err) console.error("保存に失敗:", err.message);
    });
  }, 300);
}

// ---------- ユーティリティ ----------
function rid(len) {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

function makeCard() {
  const card = [];
  for (let col = 0; col < 5; col++) {
    const [lo, hi] = RANGES[col];
    const pool = [];
    for (let n = lo; n <= hi; n++) pool.push(n);
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    card.push(pool.slice(0, 5)); // 列ごとに5個（列優先）
  }
  return card; // card[col][row]
}

function emptyMarks() {
  const m = [];
  for (let r = 0; r < 5; r++) m.push([false, false, false, false, false]);
  m[2][2] = true; // FREE
  return m;
}

// プレイヤーが自分でマークした状態から評価
function evaluate(m) {
  const lines = [];
  for (let r = 0; r < 5; r++) lines.push([0, 1, 2, 3, 4].map((c) => [r, c]));
  for (let c = 0; c < 5; c++) lines.push([0, 1, 2, 3, 4].map((r) => [r, c]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, i]));
  lines.push([0, 1, 2, 3, 4].map((i) => [i, 4 - i]));

  let bingoLines = 0, reachLines = 0;
  for (const line of lines) {
    const cnt = line.filter(([r, c]) => m[r][c]).length;
    if (cnt === 5) bingoLines++;
    else if (cnt === 4) reachLines++;
  }
  return { marked: m, bingo: bingoLines > 0, bingoLines, reach: reachLines > 0, reachLines };
}

function hostSummary(t) {
  let players = 0, reach = 0, bingo = 0;
  const list = [];
  for (const pid in t.players) {
    players++;
    const ev = evaluate(t.players[pid].marked);
    if (ev.bingo) bingo++;
    else if (ev.reach) reach++;
    list.push({
      name: t.players[pid].name || "ゲスト",
      status: ev.bingo ? "bingo" : ev.reach ? "reach" : "playing",
      bingoLines: ev.bingoLines,
      reachLines: ev.reachLines,
    });
  }
  const order = { bingo: 0, reach: 1, playing: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || b.bingoLines - a.bingoLines);
  const winners = (t.winners || []).map((w, i) => ({ rank: i + 1, name: w.name }));
  return { name: t.name, called: t.called, players, reach, bingo, list, winners };
}

// 参加URLの土台を決める。
//   1) 環境変数 BASE_URL があればそれを最優先（クラウドで明示指定できる）
//   2) プロキシ経由（クラウド）なら x-forwarded-host から公開URLを組み立て
//   3) それ以外（ローカルLAN）は司会PCのLAN IPを使う
function baseUrl(req) {
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, "");
  const xfHost = req.headers["x-forwarded-host"] || (isCloud() ? req.headers.host : null);
  if (xfHost) {
    const proto = req.headers["x-forwarded-proto"] || "https";
    return `${proto}://${xfHost}`;
  }
  const { ip } = bestLanIP();
  return `http://${ip}:${PORT}`;
}
// クラウド上（Render等）で動いているかの簡易判定
function isCloud() {
  return !!(process.env.RENDER || process.env.BASE_URL || process.env.DYNO || process.env.FLY_APP_NAME);
}

function bestLanIP() {
  const ifaces = os.networkInterfaces();
  const cands = [];
  for (const name in ifaces) {
    for (const ni of ifaces[name]) {
      if (ni.family === "IPv4" && !ni.internal) cands.push(ni.address);
    }
  }
  // 家庭/社内LANでよく使う帯域を優先
  const score = (ip) =>
    ip.startsWith("192.168.") ? 0 : ip.startsWith("10.") ? 1 : ip.startsWith("172.") ? 2 : 3;
  cands.sort((a, b) => score(a) - score(b));
  return { ip: cands[0] || "localhost", all: cands };
}

// ---------- HTTP ----------
function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" };
function serveStatic(res, file) {
  const full = path.join(__dirname, "public", file);
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(full)] || "application/octet-stream" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  // --- ページ ---
  if (p === "/" || p === "/host") return serveStatic(res, "host.html");
  if (p === "/join") return serveStatic(res, "join.html");

  // --- API ---
  if (p === "/api/create" && req.method === "POST") {
    const body = await readBody(req);
    const tid = rid(5);
    tournaments[tid] = { name: (body.name || "ビンゴ大会").slice(0, 40), called: [], pending: null, players: {}, winners: [] };
    save();
    const joinUrl = `${baseUrl(req)}/join?t=${tid}`;
    const qr = await QRCode.toDataURL(joinUrl, { width: 320, margin: 2 });
    return sendJSON(res, 200, { tid, name: tournaments[tid].name, joinUrl, qr });
  }

  if (p === "/api/host" && req.method === "GET") {
    const t = tournaments[url.searchParams.get("t")];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    return sendJSON(res, 200, hostSummary(t));
  }

  if (p === "/api/draw" && req.method === "POST") {
    const t = tournaments[url.searchParams.get("t")];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    // 前回の未公開分が残っていれば先に確定（reveal取りこぼしのフォールバック）
    if (t.pending != null) { t.called.push(t.pending); t.pending = null; }
    const remain = [];
    for (let n = 1; n <= 75; n++) if (!t.called.includes(n)) remain.push(n);
    if (remain.length === 0) return sendJSON(res, 200, { done: true, ...hostSummary(t) });
    const n = remain[Math.floor(Math.random() * remain.length)];
    t.pending = n; // まだ全体には公開しない（司会のルーレット着地後に reveal）
    save();
    const letter = LETTERS[Math.floor((n - 1) / 15)];
    return sendJSON(res, 200, { drawn: n, letter, done: remain.length === 1 });
  }

  // ルーレット着地後：未公開の番号を全体に公開する
  if (p === "/api/reveal" && req.method === "POST") {
    const t = tournaments[url.searchParams.get("t")];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    if (t.pending != null) { t.called.push(t.pending); t.pending = null; save(); }
    return sendJSON(res, 200, hostSummary(t));
  }

  if (p === "/api/reset" && req.method === "POST") {
    const t = tournaments[url.searchParams.get("t")];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    t.called = [];
    t.pending = null;
    t.winners = [];
    for (const pid in t.players) t.players[pid].marked = emptyMarks();
    save();
    return sendJSON(res, 200, hostSummary(t));
  }

  if (p === "/api/join" && req.method === "POST") {
    const body = await readBody(req);
    const t = tournaments[body.tid];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません。QRを読み直してください。" });
    const pid = rid(8);
    t.players[pid] = { name: (body.name || "").slice(0, 20), card: makeCard(), marked: emptyMarks() };
    save();
    return sendJSON(res, 200, { pid, name: t.players[pid].name, tName: t.name, card: t.players[pid].card });
  }

  if (p === "/api/player" && req.method === "GET") {
    const t = tournaments[url.searchParams.get("t")];
    const pid = url.searchParams.get("p");
    if (!t || !t.players[pid]) return sendJSON(res, 404, { error: "参加情報が見つかりません" });
    const pl = t.players[pid];
    const ev = evaluate(pl.marked);
    const rank = (t.winners || []).findIndex((w) => w.pid === pid) + 1;
    return sendJSON(res, 200, {
      tName: t.name, name: pl.name, card: pl.card, called: t.called,
      marked: pl.marked, bingo: ev.bingo, reach: ev.reach, reachLines: ev.reachLines,
      rank: rank || null,
    });
  }

  // マスをタッチしてマーク（出た数字のみ有効）
  if (p === "/api/mark" && req.method === "POST") {
    const body = await readBody(req);
    const t = tournaments[body.tid];
    if (!t || !t.players[body.pid]) return sendJSON(res, 404, { error: "参加情報が見つかりません" });
    const pl = t.players[body.pid];
    const r = body.r | 0, c = body.c | 0;
    if (r < 0 || r > 4 || c < 0 || c > 4 || (r === 2 && c === 2))
      return sendJSON(res, 400, { error: "無効なマスです" });
    const num = pl.card[c][r];
    if (!t.called.includes(num))
      return sendJSON(res, 400, { error: "その数字はまだ出ていません" });
    pl.marked[r][c] = !pl.marked[r][c];
    const ev = evaluate(pl.marked);
    // ビンゴ達成順位を記録（初回達成時のみ・以後は保持）
    t.winners = t.winners || [];
    if (ev.bingo && !t.winners.some((w) => w.pid === body.pid)) {
      t.winners.push({ pid: body.pid, name: pl.name || "ゲスト", at: Date.now() });
    }
    save();
    const rank = t.winners.findIndex((w) => w.pid === body.pid) + 1;
    return sendJSON(res, 200, {
      marked: pl.marked, bingo: ev.bingo, reach: ev.reach, reachLines: ev.reachLines,
      rank: rank || null,
    });
  }

  // 参加フォーム用：大会名だけを返す（軽量）
  if (p === "/api/info" && req.method === "GET") {
    const t = tournaments[url.searchParams.get("t")];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    return sendJSON(res, 200, { name: t.name });
  }

  // ホスト画面復元用：QRを再発行
  if (p === "/api/qr" && req.method === "GET") {
    const tid = url.searchParams.get("t");
    const t = tournaments[tid];
    if (!t) return sendJSON(res, 404, { error: "大会が見つかりません" });
    const joinUrl = `${baseUrl(req)}/join?t=${tid}`;
    const qr = await QRCode.toDataURL(joinUrl, { width: 320, margin: 2 });
    return sendJSON(res, 200, { name: t.name, joinUrl, qr });
  }

  // 大会を終了（データ削除）
  if (p === "/api/end" && req.method === "POST") {
    const tid = url.searchParams.get("t");
    if (!tournaments[tid]) return sendJSON(res, 404, { error: "大会が見つかりません" });
    delete tournaments[tid];
    save();
    return sendJSON(res, 200, { ok: true });
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, "0.0.0.0", () => {
  if (isCloud()) {
    console.log(`ビンゴ大会サーバー起動（クラウド）: port ${PORT}` +
      (process.env.BASE_URL ? ` / BASE_URL=${process.env.BASE_URL}` : ""));
    return;
  }
  const { ip, all } = bestLanIP();
  console.log("\n========================================");
  console.log("  🎉 ビンゴ大会サーバーが起動しました");
  console.log("========================================");
  console.log(`  司会PC（この画面）:  http://localhost:${PORT}`);
  console.log(`  参加者URL（自動QR）:  http://${ip}:${PORT}`);
  if (all.length > 1) console.log(`  ※ 他の候補IP: ${all.join(", ")}`);
  console.log("========================================");
  console.log("  終了するには この画面で Ctrl+C を押してください\n");
});
