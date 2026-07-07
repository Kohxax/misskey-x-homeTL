# misskey-x-homeTL

X (Twitter) の特定ユーザーのホームタイムラインを取得して JSON として返す、Misskey 向けブリッジサーバーです。

Misskey 本体 (フォーク側) の XTL 機能 (フォロー中タブ / Deck カラム) が `X_BRIDGE_URL` 経由でこのサーバーにアクセスし、X のタイムラインを表示します。Misskey 本体は X と直接通信しません。

```
[Misskey フロントエンド]
       ↓ /api/x/timeline 
[Misskey バックエンド  (x/* エンドポイント)]
       ↓ X_BRIDGE_URL (既定: http://x-hometl:3001)
[misskey-x-homeTL  ← このリポジトリ]
       ↓ 内部 GraphQL API
[X (Twitter)]
```

---

## 免責・注意事項

- このサーバーは X の**非公式・内部 GraphQL API** を、ウェブクライアント共通の公開 Bearer Token + ログイン済み cookie セッション (`auth_token` / `ct0`) を使って呼び出します。
- X の利用規約に抵触する可能性があり、アカウントの制限・凍結リスクがあります。**自己責任**で個人用途に限り使用してください。
- X 側の仕様変更により予告なく動作しなくなることがあります (Query ID の更新が必要になる場合があります)。
- このサービスは性質上おひとり様サーバー向けです。

---

## 必要なもの

- **X アカウント**のログイン cookie (`auth_token` / `ct0`)
- Docker + Docker Compose (推奨) **または** Node.js 20+

---

## セットアップ

### 1. cookie の取得

ブラウザで [x.com](https://x.com) にログインし、DevTools を開きます。

- **Chrome / Edge**: `F12` → Application タブ → Storage → Cookies → `https://x.com`
- **Firefox**: `F12` → Storage タブ → Cookies → `https://x.com`

`auth_token` と `ct0` の値をそれぞれコピーしておきます。

### 2. 環境変数の設定

```bash
cp .env.example .env
```

`.env` を開き、取得した値を設定します:

```
TWITTER_AUTH_TOKEN=<auth_token の値>
TWITTER_CT0=<ct0 の値>
```

その他の設定項目は [環境変数一覧](#環境変数一覧) を参照してください。

### 3-A. Docker で起動する (推奨)

#### Docker ネットワーク名の確認・変更 (必須)

`compose.yml` の `networks.misskey_net.name` は、Misskey 本体の Docker Compose が作成するネットワーク名に合わせる必要があります。

```bash
# Misskey 側のネットワーク名を確認する
docker network ls
```

出力例:
```
NETWORK ID     NAME                               DRIVER    SCOPE
abc123def456   my-misskey_internal_network        bridge    local
```

`compose.yml` の該当箇所を実際のネットワーク名に書き換えます:

```yaml
networks:
  misskey_net:
    external: true
    name: my-misskey_internal_network  # ← 自分の環境のネットワーク名に変更
```

変更後、起動します:

```bash
docker compose build
docker compose up -d
```

#### Misskey 本体側の設定

Misskey バックエンドのコンテナが `X_BRIDGE_URL` 環境変数を参照します。既定値は `http://x-hometl:3001` (サービス名 `x-hometl` + ポート 3001) です。同一ネットワーク上に参加していれば名前解決されるため、既定値のままで通常は動作します。

異なるサービス名やポートを使う場合は、Misskey 本体の `.env` または `docker-compose.yml` に以下を追加してください:

```
X_BRIDGE_URL=http://<サービス名>:<PORT>
```

### 3-B. ローカルで直接実行する

```bash
npm install

# 開発モード (ファイル変更を検知して自動再起動)
npm run dev

# 本番モード
npm run build
npm start
```

---

## 環境変数一覧

| 変数 | 既定値 | 必須 | 説明 |
| --- | --- | --- | --- |
| `TWITTER_AUTH_TOKEN` | — | ✅ | X の `auth_token` cookie。未設定の場合は起動時にエラー終了します。 |
| `TWITTER_CT0` | — | ✅ | X の `ct0` cookie (CSRF トークン)。 |
| `PORT` | `3001` | | 待ち受けポート。 |
| `CACHE_TTL_MS` | `60000` | | タイムラインキャッシュの有効時間 (ミリ秒)。TTL 内はリクエストを X に送らずプール内のデータを返します。 |
| `TIMELINE_COUNT` | `40` | | 初回取得時のツイート数。 |
| `TIMELINE_INCREMENTAL_COUNT` | `20` | | 差分 (cursor) 取得時のツイート数。 |
| `MAX_POOL_SIZE` | `200` | | サーバー内に保持するツイートプールの上限数。 |
| `HOME_TL_QUERY_ID` | `K0X1xbCZUjttdK8RazKAlw` | | HomeLatestTimeline の GraphQL Query ID。X の仕様変更時に上書きします。 |
| `FAVORITE_QUERY_ID` | `lI07N6Otwv1PhnEgXILM7A` | | FavoriteTweet の Query ID。 |
| `UNFAVORITE_QUERY_ID` | `ZYKSe-w7KEslx3JhSIk5LA` | | UnfavoriteTweet の Query ID。 |

`TIMELINE_COUNT`, `TIMELINE_INCREMENTAL_COUNT`の値を大きくしすぎるとX側のレートリミットに当たってしまいます。基本的に初期設定が推奨です。

---

## API リファレンス

### `GET /health`

ヘルスチェック用。

```json
{ "ok": true }
```

### `GET /status`

ブリッジの状態を返します。異常検知に使用します。

```json
{
  "ok": true,
  "poolSize": 120,
  "consecutiveErrors": 0,
  "lastError": null,
  "lastSuccessAt": "2024-01-01T00:00:00.000Z",
  "lastFetchAt": "2024-01-01T00:00:00.000Z"
}
```

3 回連続でエラーが発生すると `ok: false` になり、ログに ALERT が出力されます。

### `GET /timeline`

ツイートの配列を返します。

- キャッシュが有効な場合はプールのデータを返します。
- キャッシュ期限切れの場合は X から差分取得 (cursor ベース) を行い、プールにマージします。
- X からの取得に失敗した場合はキャッシュを返します (キャッシュもない場合は 502)。

レスポンス: `Tweet[]`

```ts
interface Tweet {
  id: string;
  text: string;             // t.co を展開済み、メディア URL は除去済み
  createdAt: string;
  author: {
    name: string;
    screenName: string;
    avatarUrl: string;
    protected: boolean;     // 非公開アカウントかどうか
  };
  media: {
    url: string;            // 動画: 最高ビットレートの m3u8/mp4, 画像: 原寸 URL
    thumbUrl: string;       // サムネイル URL
    type: 'photo' | 'video' | 'animated_gif';
  }[];
  quotedTweet?: Tweet;      // 引用リポストの場合
  retweetedBy?: {           // リポストの場合、RT したユーザー
    name: string;
    screenName: string;
  };
  originalId?: string;      // リポストの場合、元ツイートの ID
}
```

### `GET /liked`

いいね済みのツイート ID の配列を返します。

```json
["1234567890", "9876543210"]
```

> いいね状態はプロセスのメモリ上に保持されます。サーバーを再起動すると消えます。

### `POST /like`

ツイートにいいねします。

```json
// req
{ "id": "1234567890" }

// res
{ "ok": true }
```

### `POST /unlike`

いいねを取り消します。

```json
// req
{ "id": "1234567890" }

// res
{ "ok": true }
```

---

## トラブルシューティング

`/status` を確認します:

```bash
curl http://localhost:3001/status
```

`lastError.type` によって対処が変わります。

### `AUTH_ERROR` (HTTP 401 / 403)

X のセッション cookie が切れています。

1. ブラウザで x.com に再ログインし、`auth_token` と `ct0` を再取得
2. `.env` の値を更新
3. サーバーを再起動 (`docker compose restart` または `npm run dev`)

### `QUERY_ID_ERROR` (HTTP 400 / 404)

X の内部 API の Query ID が変更されています。

1. ブラウザで x.com を開き、DevTools → Network タブ
2. タイムラインを読み込み、`HomeLatestTimeline` へのリクエストを探す
3. リクエスト URL から Query ID (パスの `graphql/<ID>/` の部分) をコピー
4. `.env` に `HOME_TL_QUERY_ID=<新しいID>` を追加して再起動

いいね/いいね解除が失敗する場合は `FAVORITE_QUERY_ID` / `UNFAVORITE_QUERY_ID` も同様に更新してください。

### `UNKNOWN`

想定外のエラーです。ログを確認してください:

```bash
docker compose logs x-hometl
```

---

## 補足

- **XTL の表示機能 (フロントエンド / `x/*` API エンドポイント)** はこのリポジトリではなく、Misskey 本体側のフォーク [misskey-orenoheya](https://github.com/Kohxax/misskey-orenoheya/tree/orenoheya-develop) に実装されています。このリポジトリはデータ取得ブリッジ部分のみです。
- いいね状態はブリッジプロセスのメモリ上で管理されるため、複数デバイスからアクセスすると状態が共有されますが、**サーバー再起動でリセット**されます。
