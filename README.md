# MySmartNews

カテゴリを選ぶだけで、自分好みに並ぶニュースリーダー。
データベースもログインも広告もなし、完全無料で運用できます。

- **設定は端末の中だけ** — カテゴリ・キーワード・ミュートは localStorage に保存され、
  サーバーには一切送られません。アカウントは存在しません。
- **TOPは3種類を混ぜた1本のリスト** — 「複数の媒体が同時に報じている大きなニュース」
  「あなたの興味に沿った記事」「購読ソースの新着」を、カテゴリで区切らず織り交ぜます。
  下まで読むと自動で継ぎ足され、一度見た記事は次から下がります。
- **重要度とは、何媒体が報じたか** — はてなブックマーク数は「話題度」であって
  重要度ではないので、大きなニュースの判定には使いません。同じサイトが一覧を
  独占しないようにも調整済み。
- **アプリライクUI** — スワイプで切り替わるタブ。ダークモード対応。
  iPhoneのホーム画面に追加（PWA）できます。
- **サーバーレス** — GitHub Actions が記事を集め、静的ファイルとして配信します。

設計の背景と判断の理由は [docs/DESIGN.md](docs/DESIGN.md) にまとめてあります。

## 使う側

初回に開くとカテゴリの選択画面が出ます。あとから右上の ⚙ でいつでも変えられます。

| できること | 場所 |
|---|---|
| カテゴリの追加・削除・並び替え | 設定 → カテゴリ |
| 興味のあるキーワードと強さ | 設定 → 興味のあるキーワード |
| 自動で覚えた話題の確認・削除 | 設定 → 自動で覚えた話題 |
| 好きなRSS・キーワードの追加 | 設定 → 自分で追加したソース（Cloudflare Pages 版のみ） |
| 特定サイトの非表示 | 設定 → 表示しないサイト |
| 別の端末へ設定を移す | 設定 → 設定の持ち出し（リンクをコピーして開くだけ） |

## ファイル構成

| ファイル | 役割 |
|---|---|
| `catalog/index.json` | カテゴリ（パック）の一覧。**カテゴリを増やすならここ** |
| `catalog/packs/<id>.json` | そのカテゴリのソースと推奨キーワード |
| `index.html` / `style.css` | 表示側の骨格と見た目 |
| `build.py` | 記事を収集して `dist/` を生成する（GitHub Actionsが毎時実行） |
| `index.html` / `app.js` | 表示側。並べ替えと設定画面はすべてここ |
| `functions/api/` | Cloudflare Pages Functions。ユーザーが自分で足したソースの取得に使う |
| `dist/` | 生成される配信物（gitignore） |
| `data/state.json` | ビルド間で引き継ぐ状態。7日以内に見た記事のメタ情報のみ（gitignore） |

記事データはリポジトリにコミットされません。生成物は毎時 Pages へ直接デプロイされます。

## カテゴリを増やす・直す

`catalog/` を編集して Pull Request を送ってください。次回の自動更新から反映されます。

### 1. カテゴリを足す

`catalog/index.json` の `packs` に1行足し、同じ `id` で `catalog/packs/<id>.json` を作ります。

```json
{
    "id": "camera",
    "name": "カメラ",
    "emoji": "📷",
    "description": "写真とカメラ機材の話題。",
    "order": 12,
    "default": false
}
```

`default: true` にすると、初めて開いた人にあらかじめ選択された状態で出ます。

### 2. ソースを書く

**公式RSSがあるサイト（推奨）**

```json
{"id": "example", "name": "サイト名", "type": "rss", "url": "https://example.com/rss"}
```

**キーワード検索（Googleニュース）**

```json
{"id": "q-camera", "name": "ミラーレス", "type": "query", "query": "ミラーレス OR 交換レンズ"}
```

登録していないサイトの記事も流れ込みます。`site:example.com` と書けば、RSSを持たない
サイトをスクレイピングなしでフィード化できます。ただしサムネイル画像とはてブ件数は
付きません（理由は [docs/DESIGN.md](docs/DESIGN.md)）。

**RSSがないサイト（HTMLスクレイピング）**

```json
{
    "id": "example-html",
    "name": "サイト名",
    "type": "html",
    "url": "https://example.com/news",
    "selector": "article h2 a",
    "include": "^https://example\\.com/atcl/",
    "exclude": "/(tag|category)/"
}
```

`selector` はできるだけ具体的に。それでもナビゲーションが混ざるときは `include`
（残すURLのパターン）と `exclude`（捨てるURLのパターン）で絞れます。除外はソース
あたりの取得上限（30件）を数える前に行われます。

※ スクレイピングでは公開日時が取れないため、**初回に発見した時刻**を代わりに使います
（タイトル末尾が `2026年8月21日` のような日付で終わっていれば、それを切り離して使います）。

### 3. ソースの性質（tier）

TOPの重み付けに使います。省略すると `query` は `search`、それ以外は `media` に
なるので、**通信社・公共放送とソーシャルブックマーク経由のときだけ**書けば十分です。

```json
{"id": "nhk", "tier": "wire", "name": "NHKニュース", "type": "rss", "url": "..."}
```

| tier | どんなソースか | TOPでの扱い |
|---|---|---|
| `wire` | 通信社・公共放送。速報の一次情報 | 少し重く見る |
| `media` | 商業メディア（既定） | 基準 |
| `search` | 検索フィード経由（`query` の既定） | やや軽く見る |
| `social` | はてブなどランキング経由 | 軽く見る。専用タブでは今まで通り |

はてなブックマークのランキングは「話題度」であって「重要度」ではないので、
TOPの主要ニュース枠には載せません（詳しくは [docs/DESIGN.md](docs/DESIGN.md)）。

### 4. 推奨キーワード

パックを購読した人の興味キーワードに、未登録のものだけ取り込まれます。
そのジャンルに詳しい人の勘所をプリセットとして配れる枠です。

```json
"suggested_interests": [
    {"word": "BIM", "weight": 2.0},
    {"word": "CAD", "weight": 1.5}
]
```

## 自分で運用する

### Cloudflare Pages（推奨）

帯域無制限で、ユーザーが自分でソースを足す機能（Pages Functions）も使えます。

1. Cloudflare で Pages プロジェクトを作る（Direct Upload を選択）
2. GitHub のリポジトリ設定 → Secrets に `CLOUDFLARE_API_TOKEN` と
   `CLOUDFLARE_ACCOUNT_ID` を登録
3. プロジェクト名が `mysmartnews` 以外なら、Variables に
   `CLOUDFLARE_PROJECT_NAME` を登録
4. Actions の «Update News» を手動実行

`wrangler pages deploy` による Direct Upload は Pages のビルド数上限
（無料枠 500回/月）を消費しないため、毎時デプロイでも無料枠に収まります。

### GitHub Pages

Cloudflare のシークレットを設定しなければ、自動的に GitHub Pages へデプロイされます。
リポジトリ設定 → Pages → Source を **GitHub Actions** に変更してください
（旧来のブランチ配信からの移行が必要です）。

この場合、ユーザーが自分でRSSやキーワードを足す機能だけは使えません
（ブラウザから外部フィードを直接読めないため）。設定画面ではその欄が隠れます。

## 開発

```bash
pip install -r requirements.txt

python build.py                     # dist/ を生成
python -m http.server 8000 -d dist  # http://localhost:8000 で確認

python tools/validate_config.py     # catalog/ の検証
python tools/build_smoke_test.py    # ネットワークをスタブしたビルドの回帰テスト
node tools/rank_smoke_test.js       # 並べ替え（ブラウザ側）の回帰テスト
```

実ブラウザでの確認（CIには入れていません）:

```bash
pip install playwright && playwright install chromium
python -m http.server 8765 -d dist &
python tools/e2e_test.py
```

`dist/` にはビルドが `index.html` / `app.js` / `manifest.webmanifest` / `_headers` を
コピーします。表示だけ直したいときも `python build.py` を通してください。
