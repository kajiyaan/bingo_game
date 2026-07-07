// 共通ユーティリティ（全ゲーム共通）
const os = require("os");

const PORT = process.env.PORT || 3000;

// ランダムID（紛らわしい文字 0/O/1/I を除外）
function rid(len) {
  const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += c[Math.floor(Math.random() * c.length)];
  return s;
}

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

// クラウド上（Render/EC2のBASE_URL指定等）で動いているかの簡易判定
function isCloud() {
  return !!(process.env.RENDER || process.env.BASE_URL || process.env.DYNO || process.env.FLY_APP_NAME);
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

module.exports = { PORT, rid, sendJSON, readBody, bestLanIP, isCloud, baseUrl };
