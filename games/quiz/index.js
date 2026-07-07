// ゲーム: 早押しクイズ（4択＋速答ボーナス / Kahoot方式）
// room.state = { phase: lobby|question|result|final, questions:[{text,choices,correct}],
//                qIndex, deadline, duration, answers:{pid:{choice,at}}, lastResult }
// room.players[pid] = { name, score }
const { sendJSON, readBody } = require("../../lib/util");
const roomsLib = require("../../lib/rooms");

// ---------- 問題パック（ここに足せば増える。correct = 正解のindex） ----------
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
  { text: "世界で一番小さい国は？", choices: ["バチカン市国", "モナコ", "サンマリノ", "ツバル"], correct: 0 },
  { text: "富士山の高さは？", choices: ["3576m", "3776m", "3876m", "3976m"], correct: 1 },
  { text: "パンダの尻尾の色は？", choices: ["黒", "しましま", "白", "グレー"], correct: 2 },
  { text: "江戸時代はおよそ何年続いた？", choices: ["約160年", "約210年", "約310年", "約260年"], correct: 3 },
  { text: "人間の体で一番大きい臓器は？", choices: ["皮膚", "肝臓", "脳", "肺"], correct: 0 },
  { text: "オセロで最初に置かれている石は何個？", choices: ["2個", "4個", "6個", "8個"], correct: 1 },
  { text: "「元旦」が本来指すのは？", choices: ["1月1日全体", "正月三が日", "1月1日の朝", "大晦日の夜"], correct: 2 },
  { text: "日本の国鳥は？", choices: ["ツル", "トキ", "スズメ", "キジ"], correct: 3 },
  { text: "カタツムリの歯の数はおよそ？", choices: ["約1万本", "0本", "約100本", "約1000本"], correct: 0 },
  { text: "東京タワーとスカイツリー、高さの差はおよそ？", choices: ["約100m", "約300m", "約200m", "約400m"], correct: 1 },
  { text: "1円玉の重さは？", choices: ["0.5g", "2g", "1g", "3g"], correct: 2 },
  { text: "世界で母語の話者が一番多い言語は？", choices: ["英語", "スペイン語", "ヒンディー語", "中国語"], correct: 3 },
  { text: "ノーベル賞に「ない」部門は？", choices: ["数学賞", "文学賞", "平和賞", "経済学賞"], correct: 0 },
  { text: "バナナは植物としては？", choices: ["木", "草", "つる植物", "サボテンの仲間"], correct: 1 },
  { text: "日本で一番多い名字は？", choices: ["鈴木", "田中", "佐藤", "高橋"], correct: 2 },
  { text: "虹の一番外側（上）の色は？", choices: ["紫", "青", "黄", "赤"], correct: 3 },
  { text: "「指切りげんまん」の「げんまん」の意味は？", choices: ["拳で1万回", "元の約束", "厳しい誓い", "神への祈り"], correct: 0 },
  { text: "ボウリングのピンは何本？", choices: ["9本", "10本", "11本", "12本"], correct: 1 },
  { text: "「敬老の日」は何月？", choices: ["10月", "11月", "9月", "8月"], correct: 2 },
  { text: "シュークリームの「シュー」の意味は？", choices: ["靴", "砂糖", "ふわふわ", "キャベツ"], correct: 3 },
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

// 実際に出題する問題数（出題数設定と問題リストの少ない方）
function playTotal(st) {
  return st.limit > 0 ? Math.min(st.limit, st.questions.length) : st.questions.length;
}

function hostView(room) {
  const st = room.state;
  const q = st.qIndex >= 0 ? st.questions[st.qIndex] : null;
  return {
    name: room.name, phase: st.phase,
    qIndex: st.qIndex, qTotal: st.questions.length,
    playLimit: st.limit || 0, playTotal: playTotal(st),
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

  // 問題パックを読み込む（シャッフルして追加。すでにある問題は重複させない）
  if (sub === "/load-sample" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const existing = new Set(t.state.questions.map((q) => q.text));
    const pool = SAMPLE.filter((q) => !existing.has(q.text))
      .map((q) => ({ ...q, choices: [...q.choices] }));
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    t.state.questions.push(...pool);
    roomsLib.save();
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 出題数を設定（0 = 全問）
  if (sub === "/set-limit" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const body = await readBody(req);
    t.state.limit = Math.min(100, Math.max(0, body.limit | 0));
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
    if (st.qIndex + 1 >= playTotal(st)) return sendJSON(res, 400, { error: "出題できる問題がありません（出題数の上限か、問題切れです）" }), true;
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
      phase: st.phase, qNo: st.qIndex + 1, qTotal: playTotal(st),
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
    return { phase: "lobby", questions: [], qIndex: -1, deadline: 0, duration: 0, answers: {}, lastResult: null, limit: 0 };
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
