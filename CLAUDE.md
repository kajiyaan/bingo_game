# CLAUDE.md — このリポジトリで作業するClaude Codeへの案内

QR参加型の**パーティゲーム・プラットフォーム**です。司会がブラウザで部屋を作り、参加者はスマホでQRを読んで参加します。宴会・研修・懇親会での利用を想定し、将来的な法人向けサービス化を構想中。

このリポジトリは「新しいゲームを足しやすい土台」になっています。**新規ゲームを追加するときは、既存の3ゲームと同じ作りに合わせてください。**

## 使う人について
オーナーやワークショップ参加者は**プログラミング未経験の人事チーム**が中心です。専門用語を避け、平易な言葉で説明してください。UIのラベルも素朴な日本語を好みます（例：「内蔵問題」「サンプル問題」ではなく「問題」「お題」）。

## 起動・開発コマンド
```bash
npm install          # 初回のみ（依存は qrcode だけ）
node server.js       # http://localhost:3000 で起動（ポートは PORT 環境変数で変更可）
```
- 司会画面: `http://localhost:3000/`（ランチャー）→ 各ゲームの `/<type>/host`
- 参加画面: QR、または `http://localhost:3000/<type>/join?t=<ルームID>`
- クラウドや別PCから参加させるときは `BASE_URL=http://<公開IP>:3000 node server.js` で起動（QRがそのURLを指す）
- Node.js 18以上で動作。

## アーキテクチャ（土台 + ゲーム）
```
server.js              玄関。ルーティングとゲーム登録だけの薄い層
lib/
  util.js              共通部品（ID生成・JSON応答・QR用URL生成 baseUrl 等）
  rooms.js             ルーム管理（作成/取得/削除/保存/復元）。全ゲーム共通
games/
  <type>/index.js      1ゲーム＝1モジュール（状態とロジック）
public/
  index.html           ゲーム選択ランチャー（/api/games から自動生成）
  <type>/host.html     そのゲームの司会画面
  <type>/join.html     そのゲームのスマホ画面
rooms-data.json        全ルームの保存先（.gitignore 済み。コミットしない）
```
- **状態管理**: メモリ上の `rooms` オブジェクト。変更のたび `roomsLib.save()` で `rooms-data.json` に書き出し、起動時に復元。DBは使っていない。
- **通信**: WebSocketではなく**ポーリング**（各画面が1〜1.5秒ごとに `/api/.../host` `/api/.../player` をGET）。シンプルさ優先。500人規模まで実測OK。
- **依存**: `qrcode` のみ。他は Node 標準モジュール。

## ルーム（共通）とゲーム（固有）の分担
- 「部屋を作る・参加する・保存する・QRを出す」は**共通API**（`/api/rooms`, `/api/rooms/join`, `/api/room-info`, `/api/qr`, `/api/rooms/end`, `/api/games`）が担当。ゲーム側で書く必要はない。
- 各ゲームは自分の**状態とロジック**だけを書く。

## 新しいゲームの追加手順
1. `games/<type>/index.js` を作り、下記インターフェースの `module.exports` を書く
2. `public/<type>/host.html`（司会）と `public/<type>/join.html`（スマホ）を作る
   - 既存ゲームのHTMLをコピーして中身を変えるのが速い。CSSのカラーパレット（`:root` 変数）は全ゲーム共通で揃える
3. `server.js` の `GAMES` に **1行** `　<type>: require("./games/<type>"),` を足す
4. これだけでランチャー（`/`）に自動で並ぶ

### ゲームモジュールのインターフェース（games/<type>/index.js）
```js
module.exports = {
  type: "<type>",                 // URL・APIのキー（英小文字）
  title: "表示名",
  icon: "🎮",                     // ランチャーの絵文字
  description: "1〜2文の説明",
  createState() { return {...} },            // 部屋作成時のゲーム状態
  createPlayerData(room) { return {...} },   // 参加者ごとの初期データ
  joinResponse(room, pid) { return {...} },  // 参加時レスポンスに足す値（任意）
  onRestore(room) { /* 再起動復元時の後始末（進行中ラウンドの無効化など） */ },
  // ゲーム固有API。/api/<type>/<sub> を処理。扱ったら sendJSON して true を返す。
  // 扱わないパスは false を返す（server.js が 404 にする）。
  async handle(req, res, url, sub) {
    const room = () => { const r = roomsLib.get(url.searchParams.get("t"));
      return r && r.gameType === "<type>" ? r : null; };
    if (sub === "/host" && req.method === "GET") { /* ... */ return sendJSON(res,200,view), true; }
    return false;
  },
};
```
- `room.players[pid]` に参加者データ、`room.state` にゲーム状態が入る。
- 状態を変えたら必ず `roomsLib.save()` を呼ぶ。
- 参照実装として **`games/quiz/index.js` が一番きれい**（問題管理・出題進行・採点・最終結果まで揃っている）。以心伝心 `games/ishin/index.js` は多数決系、`games/bingo/index.js` は手動マーク系の例。

## 既存ゲーム
- **bingo**（ビンゴ大会）: ルーレット抽選演出、スマホカードを手動タップ、達成順位記録。抽選は「pending（未公開）→ 司会のルーレット着地後に reveal」で番号バレを防ぐ。
- **ishin**（以心伝心）: お題に選択式で回答、多数派と一致でポイント。逆転ラウンド（少数派勝ち）あり。お題パックは `games/ishin/index.js` の `PACK` 配列。
- **quiz**（早押しクイズ）: 4択＋速答ボーナス。問題パックは `SAMPLE` 配列（30問）、出題数設定あり、司会がその場で問題追加も可。

## テスト・検証のコツ（この環境特有）
- **APIテストは `node -e` の `fetch` で書く**。Windows の Git Bash の `curl` は日本語(UTF-8)ボディが化けるので、日本語を含むテストに使わない。
- **UIの見た目確認はブラウザプレビューのDOM検査（preview_eval で classList / textContent / computed style を読む）が確実**。スクリーンショットはタイムアウトしやすい。アニメや自動ポーリング依存の確認は、`poll()` を手動で呼ぶなど確定的に。
- 変更後は「ルーム作成→参加→1ラウンド進行→結果→終了」を通しでAPIテストしてから完了とする。テストで作ったルームは `/api/rooms/end` で消す。

## コード規約
- 既存ファイルの書き方（素朴なvanilla JS、日本語コメント、外部ライブラリ非依存）に合わせる。ビルド工程なし＝HTMLに直接 `<script>`。
- 新しい npm 依存は極力足さない。
- コミットは日本語メッセージで、変更内容を箇条書きに。

## デプロイ
本番はクラウド上でこのリポジトリを clone し、更新は `git pull` → プロセス再起動で反映する運用（具体的なサーバー情報はオーナーが別途管理）。ローカル開発だけなら上記「起動コマンド」で完結する。
