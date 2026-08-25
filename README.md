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

### `sites.json` の書き方

**1. RSSフィードがあるサイトの場合（推奨）**
安定して情報を取得できるため、極力RSSを利用してください。
```json
{
    "name": "サイト名",
    "url": "[https://example.com/rss](https://example.com/rss)",
    "type": "rss"
}
```

RSSフィードがないサイトの場合（HTMLスクレイピング）
指定したURLから、CSSセレクタに一致するリンク一覧を抽出します。

```json
{
    "name": "サイト名",
    "url": "[https://example.com/news](https://example.com/news)",
    "type": "html",
    "selector": "a"
}
```
※ ノイズ（ナビゲーションリンクなど）が多く取得されてしまう場合は、⁠selector⁠ を ⁠.news-list a⁠ や ⁠article h2 a⁠ のように具体的に指定してください。
