# MySmartNews - 自分専用ニュースリーダー

完全無料・サーバーレスで動作する、自分専用のニュースリーダーです。
GitHub Actionsを利用して定期的に指定サイトの情報をスクレイピングし、静的HTML（GitHub Pages）として配信します。

## 特徴
- **完全無料**: データベース不要。GitHub ActionsとPagesで0円運用。
- **爆速**: 静的HTMLのペラページなので読み込み遅延なし。
- **アプリライクUI**: スワイプで切り替え可能なタブUI。iPhoneのホーム画面に追加（PWA）対応。

## サイトの追加・メンテナンス方法

取得したいサイトを追加・変更・削除する場合は、リポジトリ直下の `sites.json` を編集してください。
GitHub上で直接編集してコミットするだけで、次回の自動更新（毎時0分）から反映されます。

### `sites.json` の構造

`sites.json` は以下の構造で構成されます：

```json
{
    "categories": [
        {"id": "カテゴリID", "name": "カテゴリ名", "order": 表示順序},
        ...
    ],
    "sites": [
        {
            "name": "サイト名",
            "url": "フィードまたはページのURL",
            "type": "rss または html",
            "category_id": "カテゴリID",
            "selector": "CSSセレクタ（html type のみ）"
        },
        ...
    ]
}
```

### 設定方法

**1. RSSフィードがあるサイトの場合（推奨）**
安定して情報を取得できるため、極力RSSを利用してください。
```json
{
    "name": "ITmedia",
    "url": "https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml",
    "type": "rss",
    "category_id": "it"
}
```

**2. RSSフィードがないサイトの場合（HTMLスクレイピング）**
指定したURLから、CSSセレクタに一致するリンク一覧を抽出します。

```json
{
    "name": "Archi Future Web",
    "url": "https://www.archifuture-web.jp/magazine/index2.html",
    "type": "html",
    "category_id": "construction",
    "selector": "a"
}
```
※ ノイズ（ナビゲーションリンクなど）が多く取得されてしまう場合は、`selector` を `.news-list a` や `article h2 a` のように具体的に指定してください。

### カテゴリの追加

タブUIで表示するカテゴリを管理できます。新しいカテゴリを追加する場合：

1. `categories` 配列に新しいカテゴリを追加
2. 各サイトの `category_id` で所属カテゴリを指定
3. `order` で表示順序を制御（小さい数字が上）

### 自動更新について

`sites.json` を編集してGitHub上でコミットすると、次の自動実行タイミング（毎時0分）で反映されます。
手動実行したい場合は、GitHub Actionsページから「Build」ワークフローを手動トリガーできます。
