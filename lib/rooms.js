// ルーム（部屋）管理 — 全ゲーム共通
// ルーム = { id, gameType, name, players: { pid: {name, ...ゲーム固有} }, state: {ゲーム固有} }
const fs = require("fs");
const path = require("path");
const { rid } = require("./util");

const DATA_FILE = path.join(__dirname, "..", "rooms-data.json");
const rooms = {};

// 起動時にファイルから復元。ゲーム側の onRestore で固有の後始末（未公開の抽選破棄など）
function load(games) {
  try {
    const loaded = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    Object.assign(rooms, loaded);
    for (const id in rooms) {
      const g = games[rooms[id].gameType];
      if (g && g.onRestore) g.onRestore(rooms[id]);
    }
    console.log(`保存データを復元しました（ルーム ${Object.keys(rooms).length} 件）`);
  } catch { /* 初回起動などファイルなしはOK */ }
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(rooms), (err) => {
      if (err) console.error("保存に失敗:", err.message);
    });
  }, 300);
}

function create(gameType, name, state) {
  const id = rid(5);
  rooms[id] = { id, gameType, name, players: {}, state };
  save();
  return rooms[id];
}

function get(id) { return rooms[id] || null; }

function remove(id) {
  if (!rooms[id]) return false;
  delete rooms[id];
  save();
  return true;
}

module.exports = { load, save, create, get, remove };
