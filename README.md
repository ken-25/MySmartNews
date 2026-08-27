# MySmartNews - 自分専用ニュースリーダー

完全無料・サーバーレスで動作する、自分専用のニュースリーダーです。
GitHub Actionsを利用して定期的に指定サイトの情報を収集し、静的ファイル（GitHub Pages）として配信します。

## 特徴
- **完全無料**: データベース不要。GitHub ActionsとPagesで0円運用。
- **爆速**: 静的ファイル配信のみ。サーバー処理なし。
- **アプリライクUI**: スワイプで切り替え可能なタブUI。ダークモード対応。iPhoneのホーム画面に追加（PWA）対応。
- **新着順ではなくランキング順**: 鮮度・興味キーワード・はてなブックマーク数を組み合わせてスコアリングします。
- **発見タブ**: 登録していないサイトの記事も、人気ランキングとキーワード検索から流れ込みます。

## ファイル構成

| ファイル | 役割 |
|---|---|
| `sites.json` | 設定（カテゴリ・興味キーワード・発見ソース・サイト一覧）。**編集するのはここだけ** |
| `build.py` | 記事を収集・スコアリングして `news.json` を出力する（GitHub Actionsが毎時実行） |
| `news.json` | 生成される記事データ |
| `data/state.json` | ビルド間で引き継ぐ状態。7日以内に見た記事のメタ情報のみ |
| `index.html` / `app.js` | 表示側。`news.json` を読んで描画する静的ファイル |

`index.html` は静的な器なので、毎時の自動コミットで変化するのは `news.json` と `data/state.json` だけです。

## なぜ「新着順」をやめたのか

全記事を単純に新しい順に並べると、更新頻度の高いサイトが一覧を独占してしまい、
更新の少ないサイトの記事は事実上見えなくなります。そこで各記事にスコアを付けて並べています。

```
スコア = 鮮度 × 興味キーワード係数 × 人気度係数
```

- **鮮度**: 半減期8時間の指数減衰。
- **興味キーワード**: `sites.json` の `interests` にマッチしたら加点。
- **人気度**: はてなブックマークの累計数と、前回ビルドからの増加数（急上昇）。
- **多様性**: 一覧を組み立てるとき、同じサイトが1件増えるごとにスコアを割り引きます。
  これで一覧が特定のサイトに埋め尽くされなくなります。

チューニング用の定数は `build.py` 冒頭にまとまっています。効きが強すぎる・弱いと感じたら
`HALF_LIFE_HOURS` や `DIVERSITY_DECAY` を調整してください。

## サイトの追加・メンテナンス方法

`sites.json` を編集してコミットするだけです。次回の自動更新（毎時0分）から反映されます。
手動で反映したい場合は、GitHub Actionsページから「Update News」ワークフローを手動実行できます。

### 1. 記事を取得するサイト（`sites`）

**RSSフィードがあるサイト（推奨）**
```json
{
    "name": "サイト名",
    "url": "https://example.com/rss",
    "type": "rss",
    "category_id": "カテゴリID"
}
```

**RSSフィードがないサイト（HTMLスクレイピング）**
```json
{
    "name": "サイト名",
    "url": "https://example.com/news",
    "type": "html",
    "category_id": "カテゴリID",
    "selector": ".news-list a"
}
```
※ ナビゲーションリンクなどのノイズが多く混ざる場合は、`selector` を `article h2 a` のように具体的に指定してください。
※ スクレイピングでは公開日時が取れないため、**初回に発見した時刻**を代わりに使います（`data/state.json` に記録されます）。

### 2. 興味キーワード（`interests`）

タイトルにこの語を含む記事のスコアが上がり、TOPの「あなた向け」に集まります。
`weight` が大きいほど強く押し上げられます。

```json
"interests": [
    {"word": "BIM", "weight": 2.0},
    {"word": "AI", "weight": 0.8}
]
```

### 3. 発見ソース（`discovery`）

登録していないサイトの記事を拾ってくる枠です。「発見」タブとTOPに混ざります。

```json
"discovery": [
    {"name": "はてブ IT", "url": "https://b.hatena.ne.jp/hotentry/it.rss", "type": "rss"},
    {"name": "BIM/建設DX", "query": "BIM OR 建設DX OR Revit", "type": "keyword"}
]
```

- `type: "rss"` … 任意のRSS。はてなブックマークの人気エントリーなどランキング系フィードが向いています。
- `type: "keyword"` … Googleニュースのキーワード検索RSSを自動で組み立てます。`query` に検索式を書きます。

### 4. カテゴリ（`categories`）

タブとして表示されます。`order` が小さいものから左に並びます。
記事が1件も取れなかったカテゴリ・サイトのタブは表示されません（設定ミスはActionsのログに警告が出ます）。

## 開発

```bash
pip install -r requirements.txt
python build.py                     # news.json と data/state.json を生成
python -m http.server 8000          # http://localhost:8000 で確認

python tools/validate_config.py     # sites.json の検証
python tools/build_smoke_test.py    # ネットワークをスタブしたビルドの回帰テスト
```
