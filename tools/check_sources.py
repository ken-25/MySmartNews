"""catalog/ の全ソースを実際に取得して、生きているかを1件ずつ見る。

CI には入れていない（外部サイトへ何十回も出ていくので、落ちても
それは向こうの都合であってこちらの回帰ではない）。カタログにソースを
足したとき、あるいは「このカテゴリだけ記事が来ない」ときに手で回す。

    python tools/check_sources.py            # 全部
    python tools/check_sources.py it ai      # パックを指定

出るのは3種類。

    ok    取れた（件数つき）
    空    取れたが0件。RSSなら移転、html なら selector が現状と合っていない
    NG    そもそも取れなかった。URLの打ち間違い・廃止・恒久的なブロック

「空」と「NG」はビルドを壊さない（build.py は前回の結果で埋めるか、
そのパックをカタログから落とす）ぶん気づきにくいので、ここで見つける。
"""
import os
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_ROOT)
os.chdir(REPO_ROOT)

import build  # noqa: E402  （CATALOG_DIR が相対パスなので chdir の後で読む）


def main(only):
    packs = build.load_catalog()
    if only:
        packs = [p for p in packs if p['id'] in only]
        missing = set(only) - {p['id'] for p in packs}
        if missing:
            print(f'そんなパックはありません: {sorted(missing)}')
            return 1

    cache = {}
    empty, broken = [], []
    for pack in packs:
        print(f"\n[{pack['id']}] {pack['name']}")
        for source in pack['sources']:
            key = build.fetch_key(source)
            if key in cache:
                print(f"  --  {source['id']}（{cache[key]}件・他のパックと共有）")
                continue
            try:
                articles = build.fetch_source(source)
            except Exception as exc:                      # noqa: BLE001
                articles = None
                print(f"  NG  {source['id']}: {type(exc).__name__} {exc}")
            label = source.get('url') or source.get('query')
            if articles is None:
                broken.append((pack['id'], source['id'], label))
                cache[key] = 0
                continue
            cache[key] = len(articles)
            if not articles:
                empty.append((pack['id'], source['id'], label))
                print(f"  空  {source['id']}  {label}")
            else:
                sample = articles[0]['title'][:40]
                print(f"  ok  {source['id']}  {len(articles)}件  {sample}")

    print(f"\n{'=' * 60}")
    for title, rows in (('取得できなかったソース', broken),
                        ('取得できたが0件のソース', empty)):
        if rows:
            print(f'{title}: {len(rows)}')
            for pack_id, source_id, label in rows:
                print(f'  {pack_id}/{source_id}  {label}')
    if not broken and not empty:
        print('すべてのソースが記事を返しました')
    return 1 if broken or empty else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
