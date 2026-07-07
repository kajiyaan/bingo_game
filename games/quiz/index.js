// ゲーム: 早押しクイズ（4択＋速答ボーナス / Kahoot方式）
// room.state = { phase: lobby|question|result|final, questions:[{text,choices,correct}],
//                qIndex, deadline, duration, answers:{pid:{choice,at}}, lastResult }
// room.players[pid] = { name, score }
const { sendJSON, readBody } = require("../../lib/util");
const roomsLib = require("../../lib/rooms");

// ---------- サンプル問題（動作確認やつなぎに。correct = 正解のindex） ----------
const SAMPLE = [
  { text: "日本で2番目に高い山は？", choices: ["北岳", "富士山", "槍ヶ岳", "立山"], correct: 0 },
  { text: "1ダースは何個？", choices: ["10個", "12個", "6個", "20個"], correct: 1 },
  { text: "サイコロの「1」の裏の目は？", choices: ["2", "4", "6", "5"], correct: 2 },
  { text: "太陽系で一番大きい惑星は？", choices: ["土星", "火星", "天王星", "木星"], correct: 3 },
  { text: "オリンピックの五輪に「ない」色は？", choices: ["紫", "赤", "緑", "黄"], correct: 0 },
  { text: "世界で一番人口が多い国は？（2025年）", choices: ["中国", "インド", "アメリカ", "インドネシア"], correct: 1 },
  { text: "「カルタ」の語源はどこの国の言葉？", choices: ["スペイン", "オランダ", "ポルトガル", "フランス"], correct: 2 },
  { text: "成人の人間の骨はおよそ何本？", choices: ["約100本", "約200本", "約300本", "約500本"], correct: 1 },
  { text: "日本で一番長い川は？", choices: ["利根川", "石狩川", "信濃川", "北上川"], correct: 2 },
  { text: "「サボる」の語源になった外国語は？", choices: ["サボタージュ", "サバイバル", "サポート", "サボテン"], correct: 0 },
];

const BASE_PTS = 100;   // 正解の基礎点
const SPEED_PTS = 100;  // スピードボーナスの最大値
const DEFAULT_SECONDS = 20;

// ---------- 進行ロジック ----------
function maybeClose(room) {
  if (room.state.phase === "question" && Date.now() >= room.state.deadline) closeRound(room);
}

function closeRound(room) {
  const st = room.state;
  if (st.phase !== "question") return;
  const q = st.questions[st.qIndex];
  const counts = q.choices.map(() => 0);
  const gains = {};   // pid -> 獲得点
  let fastest = null; // 最速正解者
  for (const pid in st.answers) {
    const a = st.answers[pid];
    counts[a.choice]++;
    if (a.choice === q.correct && room.players[pid]) {
      const remainFrac = Math.max(0, (st.deadline - a.at) / st.duration);
      const pts = BASE_PTS + Math.round(SPEED_PTS * remainFrac);
      room.players[pid].score = (room.players[pid].score || 0) + pts;
      gains[pid] = pts;
      if (!fastest || a.at < fastest.at) fastest = { at: a.at, name: room.players[pid].name || "ゲスト", pts };
    }
  }
  st.lastResult = {
    correct: q.correct, counts, gains,
    answered: Object.keys(st.answers).length,
    correctCount: Object.keys(gains).length,
    fastest: fastest ? { name: fastest.name, pts: fastest.pts } : null,
  };
  st.phase = "result";
  roomsLib.save();
}

function ranking(room) {
  return Object.entries(room.players)
    .map(([pid, pl]) => ({ pid, name: pl.name || "ゲスト", score: pl.score || 0 }))
    .sort((a, b) => b.score - a.score);
}

function hostView(room) {
  const st = room.state;
  const q = st.qIndex >= 0 ? st.questions[st.qIndex] : null;
  return {
    name: room.name, phase: st.phase,
    qIndex: st.qIndex, qTotal: st.questions.length,
    // 出題中は正解を混ぜない（プロジェクター映え対策）。結果以降で開示
    q: q ? { text: q.text, choices: q.choices, correct: st.phase === "question" ? undefined : q.correct } : null,
    remain: st.phase === "question" ? Math.max(0, st.deadline - Date.now()) : 0,
    answered: Object.keys(st.answers).length,
    players: Object.keys(room.players).length,
    result: st.lastResult,
    ranking: ranking(room).slice(0, 10).map((r) => ({ name: r.name, score: r.score })),
    questions: st.phase === "question" ? undefined
      : st.questions.map((x) => ({ text: x.text, choices: x.choices, correct: x.correct })),
  };
}

// ---------- ゲームAPI（/api/quiz/…） ----------
async function handle(req, res, url, sub) {
  const room = () => {
    const r = roomsLib.get(url.searchParams.get("t"));
    return r && r.gameType === "quiz" ? r : null;
  };

  if (sub === "/host" && req.method === "GET") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    maybeClose(t);
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 問題を追加
  if (sub === "/add-question" && req.method === "POST") {
    const body = await readBody(req);
    const t = roomsLib.get(body.tid);
    if (!t || t.gameType !== "quiz") return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const text = (body.text || "").trim().slice(0, 120);
    const choices = (Array.isArray(body.choices) ? body.choices : [])
      .map((c) => String(c).trim().slice(0, 40)).filter(Boolean);
    const correct = body.correct | 0;
    if (!text || choices.length < 2 || choices.length > 4 || correct < 0 || correct >= choices.length)
      return sendJSON(res, 400, { error: "問題文・選択肢（2〜4個）・正解を確認してください" }), true;
    t.state.questions.push({ text, choices, correct });
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 問題を削除（未出題のもののみ想定。出題中は不可）
  if (sub === "/del-question" && req.method === "POST") {
    const body = await readBody(req);
    const t = roomsLib.get(body.tid);
    if (!t || t.gameType !== "quiz") return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    const i = body.index | 0;
    if (st.phase === "question") return sendJSON(res, 400, { error: "出題中は削除できません" }), true;
    if (i < 0 || i >= st.questions.length || i <= st.qIndex)
      return sendJSON(res, 400, { error: "出題済み・存在しない問題は削除できません" }), true;
    st.questions.splice(i, 1);
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // サンプル問題を読み込む（既存リストの後ろに追加）
  if (sub === "/load-sample" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    t.state.questions.push(...SAMPLE.map((q) => ({ ...q, choices: [...q.choices] })));
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 次の問題を出題
  if (sub === "/start-question" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    const body = await readBody(req);
    if (st.phase === "question") return sendJSON(res, 400, { error: "出題中です" }), true;
    if (st.qIndex + 1 >= st.questions.length) return sendJSON(res, 400, { error: "問題がありません。追加してください" }), true;
    const seconds = Math.min(120, Math.max(5, (body.seconds | 0) || DEFAULT_SECONDS));
    st.qIndex++;
    st.answers = {};
    st.lastResult = null;
    st.duration = seconds * 1000;
    st.deadline = Date.now() + st.duration;
    st.phase = "question";
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 手動で締め切る
  if (sub === "/close" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    closeRound(t);
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 最終結果を発表
  if (sub === "/final" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    if (t.state.phase === "question") closeRound(t);
    t.state.phase = "final";
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // リセット（問題は残し、得点と進行をリセット）
  if (sub === "/reset" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    st.phase = "lobby"; st.qIndex = -1; st.deadline = 0; st.duration = 0;
    st.answers = {}; st.lastResult = null;
    for (const pid in t.players) t.players[pid].score = 0;
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // プレイヤーの状態取得
  if (sub === "/player" && req.method === "GET") {
    const t = room();
    const pid = url.searchParams.get("p");
    if (!t || !t.players[pid]) return sendJSON(res, 404, { error: "参加情報が見つかりません" }), true;
    maybeClose(t);
    const st = t.state;
    const rk = ranking(t);
    const myRank = rk.findIndex((r) => r.pid === pid) + 1;
    const q = st.qIndex >= 0 ? st.questions[st.qIndex] : null;
    const my = st.answers[pid];
    const out = {
      tName: t.name, name: t.players[pid].name,
      phase: st.phase, qNo: st.qIndex + 1, qTotal: st.questions.length,
      score: t.players[pid].score || 0, rank: myRank, players: rk.length,
      q: q && st.phase !== "lobby" ? { text: q.text, choices: q.choices } : null,
      remain: st.phase === "question" ? Math.max(0, st.deadline - Date.now()) : 0,
      myChoice: my ? my.choice : null,
    };
    if ((st.phase === "result" || st.phase === "final") && st.lastResult) {
      out.correct = st.lastResult.correct;
      out.counts = st.lastResult.counts;
      out.myGain = st.lastResult.gains[pid] || 0;
      out.won = my ? my.choice === st.lastResult.correct : false;
    }
    if (st.phase === "final") out.top3 = rk.slice(0, 3).map((r) => ({ name: r.name, score: r.score }));
    return sendJSON(res, 200, out), true;
  }

  // 回答（1回のみ・変更不可 — 早押しなので）
  if (sub === "/answer" && req.method === "POST") {
    const body = await readBody(req);
    const t = roomsLib.get(body.tid);
    if (!t || t.gameType !== "quiz" || !t.players[body.pid])
      return sendJSON(res, 404, { error: "参加情報が見つかりません" }), true;
    maybeClose(t);
    const st = t.state;
    if (st.phase !== "question") return sendJSON(res, 400, { error: "今は回答できません" }), true;
    if (st.answers[body.pid]) return sendJSON(res, 400, { error: "回答済みです" }), true;
    const choice = body.choice | 0;
    const q = st.questions[st.qIndex];
    if (choice < 0 || choice >= q.choices.length) return sendJSON(res, 400, { error: "無効な選択です" }), true;
    st.answers[body.pid] = { choice, at: Date.now() };
    roomsLib.save();
    return sendJSON(res, 200, { ok: true, myChoice: choice }), true;
  }

  return false;
}

module.exports = {
  type: "quiz",
  title: "早押しクイズ",
  icon: "⚡",
  description: "4択クイズに全員参加。正解＋回答スピードでポイント！会社オリジナル問題で盛り上がろう。",
  createState() {
    return { phase: "lobby", questions: [], qIndex: -1, deadline: 0, duration: 0, answers: {}, lastResult: null };
  },
  createPlayerData() { return { score: 0 }; },
  joinResponse() { return {}; },
  onRestore(room) {
    // 再起動時、出題中だった問題は仕切り直し（同じ問題をもう一度出せる）
    if (room.state.phase === "question") {
      room.state.phase = room.state.qIndex > 0 ? "result" : "lobby";
      room.state.qIndex = Math.max(-1, room.state.qIndex - 1);
      room.state.answers = {};
      room.state.lastResult = null;
    }
  },
  handle,
};
