// ゲーム: ビンゴ大会
// room.state  = { called: [], pending: null, winners: [{pid,name,at}] }
// room.players[pid] = { name, card, marked }
const { sendJSON, readBody } = require("../../lib/util");
const roomsLib = require("../../lib/rooms");

const LETTERS = ["B", "I", "N", "G", "O"];
const RANGES = [[1, 15], [16, 30], [31, 45], [46, 60], [61, 75]];

// ---------- カード生成・判定 ----------
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
    card.push(pool.slice(0, 5)); // card[col][row]
  }
  return card;
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
  return { bingo: bingoLines > 0, bingoLines, reach: reachLines > 0, reachLines };
}

function hostSummary(room) {
  const st = room.state;
  let players = 0, reach = 0, bingo = 0;
  const list = [];
  for (const pid in room.players) {
    players++;
    const ev = evaluate(room.players[pid].marked);
    if (ev.bingo) bingo++;
    else if (ev.reach) reach++;
    list.push({
      name: room.players[pid].name || "ゲスト",
      status: ev.bingo ? "bingo" : ev.reach ? "reach" : "playing",
      bingoLines: ev.bingoLines,
      reachLines: ev.reachLines,
    });
  }
  const order = { bingo: 0, reach: 1, playing: 2 };
  list.sort((a, b) => order[a.status] - order[b.status] || b.bingoLines - a.bingoLines);
  const winners = (st.winners || []).map((w, i) => ({ rank: i + 1, name: w.name }));
  return { name: room.name, called: st.called, players, reach, bingo, list, winners };
}

// ---------- ゲームAPI（/api/bingo/… として server.js からディスパッチ） ----------
async function handle(req, res, url, sub) {
  const room = () => {
    const r = roomsLib.get(url.searchParams.get("t"));
    return r && r.gameType === "bingo" ? r : null;
  };

  if (sub === "/draw" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    // 前回の未公開分が残っていれば先に確定（reveal取りこぼしのフォールバック）
    if (st.pending != null) { st.called.push(st.pending); st.pending = null; }
    const remain = [];
    for (let n = 1; n <= 75; n++) if (!st.called.includes(n)) remain.push(n);
    if (remain.length === 0) return sendJSON(res, 200, { done: true, ...hostSummary(t) }), true;
    const n = remain[Math.floor(Math.random() * remain.length)];
    st.pending = n; // まだ全体には公開しない（司会のルーレット着地後に reveal）
    roomsLib.save();
    const letter = LETTERS[Math.floor((n - 1) / 15)];
    return sendJSON(res, 200, { drawn: n, letter, done: remain.length === 1 }), true;
  }

  // ルーレット着地後：未公開の番号を全体に公開する
  if (sub === "/reveal" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    if (st.pending != null) { st.called.push(st.pending); st.pending = null; roomsLib.save(); }
    return sendJSON(res, 200, hostSummary(t)), true;
  }

  if (sub === "/host" && req.method === "GET") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    return sendJSON(res, 200, hostSummary(t)), true;
  }

  if (sub === "/reset" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    t.state.called = [];
    t.state.pending = null;
    t.state.winners = [];
    for (const pid in t.players) t.players[pid].marked = emptyMarks();
    roomsLib.save();
    return sendJSON(res, 200, hostSummary(t)), true;
  }

  if (sub === "/player" && req.method === "GET") {
    const t = room();
    const pid = url.searchParams.get("p");
    if (!t || !t.players[pid]) return sendJSON(res, 404, { error: "参加情報が見つかりません" }), true;
    const pl = t.players[pid];
    const ev = evaluate(pl.marked);
    const rank = (t.state.winners || []).findIndex((w) => w.pid === pid) + 1;
    return sendJSON(res, 200, {
      tName: t.name, name: pl.name, card: pl.card, called: t.state.called,
      marked: pl.marked, bingo: ev.bingo, reach: ev.reach, reachLines: ev.reachLines,
      rank: rank || null,
    }), true;
  }

  // マスをタッチしてマーク（出た数字のみ有効）
  if (sub === "/mark" && req.method === "POST") {
    const body = await readBody(req);
    const t = roomsLib.get(body.tid);
    if (!t || t.gameType !== "bingo" || !t.players[body.pid])
      return sendJSON(res, 404, { error: "参加情報が見つかりません" }), true;
    const pl = t.players[body.pid];
    const r = body.r | 0, c = body.c | 0;
    if (r < 0 || r > 4 || c < 0 || c > 4 || (r === 2 && c === 2))
      return sendJSON(res, 400, { error: "無効なマスです" }), true;
    const num = pl.card[c][r];
    if (!t.state.called.includes(num))
      return sendJSON(res, 400, { error: "その数字はまだ出ていません" }), true;
    pl.marked[r][c] = !pl.marked[r][c];
    const ev = evaluate(pl.marked);
    // ビンゴ達成順位を記録（初回達成時のみ・以後は保持）
    t.state.winners = t.state.winners || [];
    if (ev.bingo && !t.state.winners.some((w) => w.pid === body.pid)) {
      t.state.winners.push({ pid: body.pid, name: pl.name || "ゲスト", at: Date.now() });
    }
    roomsLib.save();
    const rank = t.state.winners.findIndex((w) => w.pid === body.pid) + 1;
    return sendJSON(res, 200, {
      marked: pl.marked, bingo: ev.bingo, reach: ev.reach, reachLines: ev.reachLines,
      rank: rank || null,
    }), true;
  }

  return false; // このゲームでは扱わないパス
}

module.exports = {
  type: "bingo",
  title: "ビンゴ大会",
  icon: "🎱",
  description: "定番のビンゴ。ルーレット抽選演出、スマホカード自動判定、達成順位の記録つき。",
  // 部屋作成時の初期状態
  createState() { return { called: [], pending: null, winners: [] }; },
  // 参加時のプレイヤー固有データ
  createPlayerData() { return { card: makeCard(), marked: emptyMarks() }; },
  // 参加APIのレスポンスに足すもの（スマホがカードを受け取る）
  joinResponse(room, pid) { return { card: room.players[pid].card }; },
  // 再起動復元時の後始末：未公開の1個は破棄（引き直し）
  onRestore(room) {
    room.state.pending = null;
    room.state.winners = room.state.winners || [];
  },
  handle,
};
