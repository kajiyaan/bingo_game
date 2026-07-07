// ゲーム: 以心伝心（多数派に入ればポイント！逆転の少数派ラウンドあり）
// room.state = { phase: lobby|question|result, round, q:{text,choices}, minority,
//                deadline, answers:{pid:choiceIdx}, lastResult, usedPack:[] }
// room.players[pid] = { name, score }
const { sendJSON, readBody } = require("../../lib/util");
const roomsLib = require("../../lib/rooms");

// ---------- 内蔵お題パック（ここに足せば増える） ----------
const PACK = [
  { text: "朝ごはんといえば？", choices: ["🍞 パン", "🍚 ごはん", "🥣 シリアル", "☕ コーヒーだけ"] },
  { text: "宴会の〆といえば？", choices: ["🍜 ラーメン", "🍨 アイス", "🍵 お茶漬け", "🍰 スイーツ"] },
  { text: "無人島に1つ持っていくなら？", choices: ["🔪 ナイフ", "🔥 ライター", "📱 スマホ", "🎣 釣り竿"] },
  { text: "休日の過ごし方といえば？", choices: ["🛏️ ひたすら寝る", "🛍️ 買い物", "⚽ 体を動かす", "🎮 ゲーム"] },
  { text: "おでんの具といえば？", choices: ["🍢 大根", "🥚 たまご", "🐟 ちくわ", "🔺 こんにゃく"] },
  { text: "旅行に行くなら？", choices: ["♨️ 温泉", "🏖️ ビーチ", "🏙️ 都会", "⛰️ 山"] },
  { text: "カレーの辛さは？", choices: ["🍯 甘口", "🙂 中辛", "🔥 辛口", "💀 激辛"] },
  { text: "目玉焼きにかけるのは？", choices: ["🧂 塩", "🍶 醤油", "🥫 ソース", "🍳 そのまま"] },
  { text: "きのこの山 vs たけのこの里", choices: ["🍄 きのこの山", "🎋 たけのこの里"] },
  { text: "犬派？猫派？", choices: ["🐶 犬", "🐱 猫", "🐹 その他の動物", "🚫 飼わない派"] },
  { text: "夏と冬、どっちが好き？", choices: ["☀️ 夏", "⛄ 冬"] },
  { text: "コンビニといえば？", choices: ["🍙 セブン", "🍗 ファミマ", "🥐 ローソン", "🏪 その他"] },
  { text: "お寿司で最初に食べるのは？", choices: ["🍣 サーモン", "🐟 マグロ", "🥚 たまご", "🦐 えび"] },
  { text: "遅刻しそうな時どうする？", choices: ["🏃 全力で走る", "🚕 タクシー", "😇 諦める", "⏰ そもそも遅刻しない"] },
  { text: "宝くじで1億円当たったら？", choices: ["💼 仕事を辞める", "🏠 家を買う", "💰 堅実に貯金", "✈️ 世界一周"] },
  { text: "飲み会で最初に頼むのは？", choices: ["🍺 ビール", "🍹 サワー・カクテル", "🥤 ソフトドリンク", "🍶 日本酒・焼酎"] },
  { text: "たこ焼きの具、あなたの立場は？", choices: ["🐙 タコ以外認めない", "🧀 チーズはあり", "🤷 なんでもあり", "😋 食べられればOK"] },
  { text: "卵かけごはん、どう食べる？", choices: ["🌀 全力で混ぜる", "🥄 ちょい混ぜ", "🍚 のせるだけ", "🙅 食べない"] },
  { text: "お風呂で最初に洗うのは？", choices: ["🧴 頭", "🧼 体", "🦶 足", "🤔 覚えていない"] },
  { text: "スマホの充電、何%で不安になる？", choices: ["🔋 50%", "😰 30%", "😱 10%", "😎 1%でも平気"] },
];

const DEFAULT_SECONDS = 20;

// ---------- 進行ロジック ----------
// 締め切り時刻を過ぎていたら自動で結果を確定（誰かのアクセスをきっかけに動く）
function maybeClose(room) {
  if (room.state.phase === "question" && Date.now() >= room.state.deadline) closeRound(room);
}

function closeRound(room) {
  const st = room.state;
  if (st.phase !== "question") return;
  const counts = st.q.choices.map(() => 0);
  for (const pid in st.answers) counts[st.answers[pid]]++;
  // 票が入った選択肢の中で、多数派（逆転ラウンドは少数派）を勝ちとする。同数は全て勝ち
  const voted = counts.map((c, i) => ({ c, i })).filter((x) => x.c > 0);
  let winners = [];
  if (voted.length) {
    const target = st.minority ? Math.min(...voted.map((x) => x.c)) : Math.max(...voted.map((x) => x.c));
    winners = voted.filter((x) => x.c === target).map((x) => x.i);
  }
  const pts = st.minority ? 20 : 10;
  let gainedCount = 0;
  for (const pid in st.answers) {
    if (winners.includes(st.answers[pid]) && room.players[pid]) {
      room.players[pid].score = (room.players[pid].score || 0) + pts;
      gainedCount++;
    }
  }
  st.lastResult = { counts, winners, pts, minority: st.minority, answered: Object.keys(st.answers).length, gainedCount };
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
  return {
    name: room.name, phase: st.phase, round: st.round, minority: st.minority,
    q: st.q, remain: st.phase === "question" ? Math.max(0, st.deadline - Date.now()) : 0,
    answered: Object.keys(st.answers).length,
    players: Object.keys(room.players).length,
    result: st.lastResult,
    ranking: ranking(room).slice(0, 10).map((r) => ({ name: r.name, score: r.score })),
    packTotal: PACK.length, packUsed: st.usedPack.length,
  };
}

// ---------- ゲームAPI（/api/ishin/…） ----------
async function handle(req, res, url, sub) {
  const room = () => {
    const r = roomsLib.get(url.searchParams.get("t"));
    return r && r.gameType === "ishin" ? r : null;
  };

  if (sub === "/host" && req.method === "GET") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    maybeClose(t);
    return sendJSON(res, 200, hostView(t)), true;
  }

  // 出題（mode: "pack"=内蔵お題から / "custom"=自作）
  if (sub === "/question" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    const body = await readBody(req);
    let q;
    if (body.mode === "custom") {
      const text = (body.text || "").trim().slice(0, 100);
      const choices = (Array.isArray(body.choices) ? body.choices : [])
        .map((c) => String(c).trim().slice(0, 30)).filter(Boolean);
      if (!text || choices.length < 2 || choices.length > 6)
        return sendJSON(res, 400, { error: "お題と選択肢（2〜6個）を入力してください" }), true;
      q = { text, choices };
    } else {
      // 内蔵パックから未出題をランダムに（使い切ったらリセット）
      if (st.usedPack.length >= PACK.length) st.usedPack = [];
      const rest = PACK.map((_, i) => i).filter((i) => !st.usedPack.includes(i));
      const idx = rest[Math.floor(Math.random() * rest.length)];
      st.usedPack.push(idx);
      q = PACK[idx];
    }
    const seconds = Math.min(120, Math.max(5, (body.seconds | 0) || DEFAULT_SECONDS));
    st.q = q;
    st.minority = !!body.minority;
    st.round++;
    st.answers = {};
    st.lastResult = null;
    st.deadline = Date.now() + seconds * 1000;
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

  // 得点リセット（新しいゲームを最初から）
  if (sub === "/reset" && req.method === "POST") {
    const t = room();
    if (!t) return sendJSON(res, 404, { error: "ルームが見つかりません" }), true;
    const st = t.state;
    st.phase = "lobby"; st.round = 0; st.q = null; st.minority = false;
    st.deadline = 0; st.answers = {}; st.lastResult = null; st.usedPack = [];
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
    const myChoice = st.answers[pid] !== undefined ? st.answers[pid] : null;
    const out = {
      tName: t.name, name: t.players[pid].name,
      phase: st.phase, round: st.round, minority: st.minority,
      score: t.players[pid].score || 0, rank: myRank, players: rk.length,
      q: st.phase === "lobby" ? null : st.q,
      remain: st.phase === "question" ? Math.max(0, st.deadline - Date.now()) : 0,
      myChoice,
    };
    if (st.phase === "result" && st.lastResult) {
      out.result = st.lastResult;
      out.won = myChoice !== null && st.lastResult.winners.includes(myChoice);
    }
    return sendJSON(res, 200, out), true;
  }

  // 回答（締め切りまで変更可能）
  if (sub === "/answer" && req.method === "POST") {
    const body = await readBody(req);
    const t = roomsLib.get(body.tid);
    if (!t || t.gameType !== "ishin" || !t.players[body.pid])
      return sendJSON(res, 404, { error: "参加情報が見つかりません" }), true;
    maybeClose(t);
    const st = t.state;
    if (st.phase !== "question") return sendJSON(res, 400, { error: "今は回答できません" }), true;
    const choice = body.choice | 0;
    if (choice < 0 || choice >= st.q.choices.length)
      return sendJSON(res, 400, { error: "無効な選択です" }), true;
    st.answers[body.pid] = choice;
    roomsLib.save();
    return sendJSON(res, 200, { ok: true, myChoice: choice }), true;
  }

  return false;
}

module.exports = {
  type: "ishin",
  title: "以心伝心",
  icon: "🤝",
  description: "お題にみんなでタップ回答。多数派と一致すればポイント！読み合いが熱い「逆転ラウンド」も。",
  createState() {
    return { phase: "lobby", round: 0, q: null, minority: false, deadline: 0, answers: {}, lastResult: null, usedPack: [] };
  },
  createPlayerData() { return { score: 0 }; },
  joinResponse() { return {}; },
  onRestore(room) {
    // 再起動時、出題中だったラウンドは無効化（回答が揃わないため）
    if (room.state.phase === "question") {
      room.state.phase = "lobby";
      room.state.answers = {};
    }
  },
  handle,
};
