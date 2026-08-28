"""ネットワークをスタブして build.py の収集挙動を検証する（CI用）。

並び順はブラウザ側の責任になったので、ここで見るのは「配信物が正しいか」だけ:
  - パックごとのシャードが出ること、主観的なスコアを含まないこと
  - URL正規化による重複排除
  - 同じフィードを複数パックが参照しても1回しか取りに行かないこと
  - Googleニュース経由の媒体名・タイトル整形・はてブ問い合わせ除外
  - 公開日時のない記事に初回発見時刻が割り当てられること
  - 取得に失敗したソースが state から復元されること
  - ソースの性質（tier）が記事に載ること
  - 見出しの違う同じ話題がまとまり、報じた媒体数（reach）が数えられること
"""
import email.utils
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime, timedelta, timezone

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
JST = timezone(timedelta(hours=9))
NOW = datetime.now(JST)

INDEX = {
    "version": 2,
    "packs": [
        {"id": "tech", "name": "テック", "order": 1, "default": True,
         "description": "テスト用"},
        {"id": "build", "name": "建設", "order": 2, "default": False,
         "description": "テスト用"},
    ],
}

PACKS = {
    "tech": {
        "id": "tech",
        "suggested_interests": [{"word": "BIM", "weight": 2.0}],
        "sources": [
            {"id": "prolific", "name": "多産サイト", "type": "rss",
             "url": "https://prolific.example/rss"},
            {"id": "dup", "name": "重複サイト", "type": "rss",
             "url": "https://dup.example/rss"},
            {"id": "hatena", "name": "はてブ", "type": "rss", "tier": "social",
             "url": "https://b.hatena.ne.jp/hotentry/it.rss"},
            {"id": "q-bim", "name": "BIM検索", "type": "query", "query": "BIM"},
            {"id": "wire", "name": "通信社", "type": "rss", "tier": "wire",
             "url": "https://wire.example/rss"},
            {"id": "paper", "name": "全国紙", "type": "rss",
             "url": "https://paper.example/rss"},
            {"id": "local", "name": "地方紙", "type": "rss",
             "url": "https://local.example/rss"},
        ],
    },
    "build": {
        "id": "build",
        "suggested_interests": [],
        "sources": [
            {"id": "quiet", "name": "寡作サイト", "type": "rss",
             "url": "https://quiet.example/rss"},
            {"id": "hatena-again", "name": "はてブ（別ID）", "type": "rss",
             "url": "https://b.hatena.ne.jp/hotentry/it.rss"},
            {"id": "scrape", "name": "スクレイピング", "type": "html",
             "url": "https://scrape.example/", "selector": "a",
             "exclude": "/(tag|about)/"},
        ],
    },
}


def rss(items, source_title=None):
    body = ''
    for title, link, minutes in items:
        source = (f'<source url="https://example.com">{source_title}</source>'
                  if source_title else '')
        body += ('<item><title>{}</title><link>{}</link><pubDate>{}</pubDate>{}</item>'
                 .format(title, link,
                         email.utils.format_datetime(NOW - timedelta(minutes=minutes)),
                         source))
    return ('<?xml version="1.0"?><rss version="2.0"><channel>'
            + body + '</channel></rss>')


class FakeResponse:
    def __init__(self, text, payload=None):
        self.text = text
        self.content = text.encode('utf-8')
        self.apparent_encoding = 'utf-8'
        self.encoding = 'utf-8'
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


class Network:
    """テスト中に差し替える requests.get の実装。"""

    def __init__(self):
        self.hatena = {}
        self.scrape_ok = True
        self.hatena_requests = []
        self.feed_requests = []
        self.uri_limit = 4000
        self.scrape_body = None

    def get(self, url, **kwargs):
        import requests

        if 'bookmark.hatenaapis' in url:
            urls = [v for k, v in kwargs.get('params', []) if k == 'url']
            self.hatena_requests.append(list(urls))
            query_bytes = sum(len(u) + 5 for u in urls)
            if query_bytes > self.uri_limit:
                error = requests.exceptions.HTTPError('414 Request-URI Too Large')
                error.response = FakeResponse('')
                error.response.status_code = 414
                raise error
            return FakeResponse('', {u: self.hatena.get(u, 0) for u in urls})

        self.feed_requests.append(url)
        if 'prolific.example' in url:
            return FakeResponse(rss([
                (f'多産サイトの記事{i}', f'https://prolific.example/{i}', i * 3)
                for i in range(30)]))
        # 同じ事件を各社が別の見出しで報じる。まとまって reach=3 になるはず。
        if 'wire.example' in url:
            return FakeResponse(rss([
                ('政府が建設DXの支援制度を発表', 'https://wire.example/1', 20)]))
        if 'paper.example' in url:
            return FakeResponse(rss([
                ('政府が建設DXの支援制度を発表へ', 'https://paper.example/1', 25)]))
        if 'local.example' in url:
            return FakeResponse(rss([
                ('政府、建設DXの支援制度を発表', 'https://local.example/1', 30)]))
        if 'quiet.example' in url:
            return FakeResponse(rss([
                ('BIM連携の新機能', 'https://quiet.example/bim', 200)]))
        if 'dup.example' in url:
            # 多産サイトと同じ記事をトラッキング付きURLで配信する
            return FakeResponse(rss([
                ('多産サイトの記事0', 'https://prolific.example/0?utm_source=dup', 3)]))
        if 'b.hatena.ne.jp' in url:
            return FakeResponse(rss([
                ('はてブの人気記事', 'https://hot.example/1', 90)]))
        if 'news.google.com' in url:
            # 実物同様に長いリダイレクトURLと、媒体名付きのタイトルを返す
            return FakeResponse(rss([
                (f'GoogleニュースのBIM記事{i} - 実在メディア',
                 'https://news.google.com/rss/articles/' + 'C' * 500 + str(i), 150 + i)
                for i in range(30)], source_title='実在メディア'))
        if 'scrape.example' in url:
            if not self.scrape_ok:
                raise requests.exceptions.ConnectionError('stubbed outage')
            if self.scrape_body is not None:
                return FakeResponse(self.scrape_body)
            return FakeResponse(
                '<html><body>'
                '<a href="/tag/bim">BIM</a>'
                '<a href="/about/">このサイトについて</a>'
                '<a href="/page/0">短い</a>'
                '<a href="/page/1">日時のないスクレイピング記事</a>'
                '<a href="/page/2">日付が末尾に付いた記事2026年8月21日</a>'
                '</body></html>')
        raise requests.exceptions.ConnectionError('unmapped ' + url)


def read_dist():
    with open(os.path.join('dist', 'index.json'), encoding='utf-8') as f:
        index = json.load(f)
    packs = {}
    for meta in index['packs']:
        with open(os.path.join('dist', 'p', meta['id'] + '.json'), encoding='utf-8') as f:
            packs[meta['id']] = json.load(f)['articles']
    return index, packs


def find(packs, fragment, pack_id=None):
    for key, articles in packs.items():
        if pack_id and key != pack_id:
            continue
        for article in articles:
            if fragment in article['title']:
                return article
    return None


def check(condition, message):
    if not condition:
        print(f'✗ {message}')
        sys.exit(1)
    print(f'✓ {message}')


def write_catalog():
    os.makedirs(os.path.join('catalog', 'packs'), exist_ok=True)
    with open(os.path.join('catalog', 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(INDEX, f, ensure_ascii=False)
    for pack_id, body in PACKS.items():
        path = os.path.join('catalog', 'packs', f'{pack_id}.json')
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(body, f, ensure_ascii=False)


def main():
    workdir = tempfile.mkdtemp()
    shutil.copy(os.path.join(REPO_ROOT, 'build.py'), workdir)
    # ビルドIDの焼き込みを確かめたいので表示側のファイルも持ち込む
    shutil.copy(os.path.join(REPO_ROOT, 'app.js'), workdir)
    os.chdir(workdir)
    sys.path.insert(0, workdir)
    write_catalog()

    import requests
    network = Network()
    requests.get = network.get

    import build

    network.hatena = {'https://prolific.example/1': 3}
    build.main()
    index, packs = read_dist()

    check(set(packs) == {'tech', 'build'}, 'パックごとにシャードが出力されている')
    check(all(k['id'] and k['name'] for k in index['packs']),
          'カタログにパックのメタ情報が載っている')

    with open(os.path.join('dist', 'app.js'), encoding='utf-8') as f:
        served_app = f.read()
    check(index.get('app_build') and len(index['app_build']) == 7,
          f"配信物にビルドIDが載っている ({index.get('app_build')})")
    check(f"var APP_BUILD = '{index['app_build']}';" in served_app,
          '配信する app.js に同じビルドIDが焼き込まれている')
    check("var APP_BUILD = 'dev';" not in served_app,
          'ビルドIDのプレースホルダが残っていない')
    check(index['packs'][0]['suggested_interests'][0]['word'] == 'BIM',
          'パックの推奨キーワードがカタログに載っている')

    sample = packs['tech'][0]
    check('score' not in sample and 'time_ago' not in sample,
          '配信物に主観的なスコアや整形済み時刻を含まない')
    check(all(key in sample for key in
              ('hatena', 'hatena_delta', 'published_at', 'first_seen', 'cluster',
               'tier', 'reach')),
          '並べ替えに必要な客観信号が揃っている')

    hatena_article = find(packs, 'はてブの人気記事', 'tech')
    check(hatena_article is not None and hatena_article['tier'] == 'social',
          'カタログで指定した tier が記事に載っている '
          f"({hatena_article and hatena_article['tier']})")
    searched = find(packs, 'GoogleニュースのBIM記事1')
    check(searched is not None and searched['tier'] == 'search',
          f"検索フィード経由の記事に既定の tier が付いている "
          f"({searched and searched['tier']})")

    wire = find(packs, '政府が建設DXの支援制度を発表', 'tech')
    same_story = [a for a in packs['tech']
                  if wire and a['cluster'] == wire['cluster']]
    check(len(same_story) == 3,
          f'見出しの違う同じ話題が1つのクラスタにまとまっている ({len(same_story)}件)')
    check(wire is not None and wire['reach'] == 3,
          f"報じた媒体数が数えられている (reach={wire and wire['reach']})")
    check(all(a['reach'] == 1 for a in packs['tech']
              if a['title'].startswith('多産サイトの記事')),
          '誰も追随していない記事の reach は 1 のまま')

    keys = [a['key'] for a in packs['tech']]
    check(len(keys) == len(set(keys)), 'パック内に重複記事がない')
    check(sum(1 for a in packs['tech'] if a['title'] == '多産サイトの記事0') == 1,
          'トラッキングパラメータ違いの同一記事が重複排除されている')

    hatena_fetches = [u for u in network.feed_requests if 'b.hatena.ne.jp' in u]
    check(len(hatena_fetches) == 1,
          f'同じフィードを2パックが参照しても取得は1回 ({len(hatena_fetches)}回)')
    check(find(packs, 'はてブの人気記事', 'build') is not None,
          '共有フィードの記事が両方のパックに入っている')

    google = find(packs, 'GoogleニュースのBIM記事0')
    check(google is not None and google['site'] == '実在メディア',
          f"Googleニュース経由の媒体名を実サイト名にしている ({google and google['site']})")
    check(google is not None and ' - 実在メディア' not in google['title'],
          f"タイトル末尾の媒体名が落ちている ({google and google['title']})")

    scraped = find(packs, '日時のないスクレイピング記事')
    check(scraped is not None and scraped['dated'] is False and scraped['published_at'],
          '公開日時のない記事に初回発見時刻が入り、推定であると印が付いている')

    check(all('news.google.com' not in u
              for chunk in network.hatena_requests for u in chunk),
          'リダイレクトURLをはてブAPIに問い合わせていない')
    check(network.hatena_requests and all(
              sum(len(u) + 5 for u in chunk) <= network.uri_limit
              for chunk in network.hatena_requests),
          f'はてブAPIのリクエストがURI長の上限内に収まっている '
          f'({len(network.hatena_requests)}リクエスト)')

    check(find(packs, 'このサイトについて') is None,
          'exclude パターンのリンクが除外されている')
    check(find(packs, '短い') is None, '短すぎるタイトルが除外されている')
    dated = find(packs, '日付が末尾に付いた記事')
    check(dated is not None and '2026年' not in dated['title'],
          f"タイトル末尾の日付が切り離されている ({dated and dated['title']})")

    dup_clusters = {a['title']: a['cluster'] for a in packs['tech']
                    if a['title'] == '多産サイトの記事0'}
    check(build.cluster_id('同じ 話題！') == build.cluster_id('同じ話題'),
          '記号や空白の違いを吸収してクラスタIDが一致する')
    check(all(c for c in dup_clusters.values()), '全記事にクラスタIDが付いている')

    # --- URIの上限が想定より厳しい場合に、分割して取り直せることを確認 ---
    network.hatena_requests = []
    network.uri_limit = 200
    network.hatena = {'https://prolific.example/2': 55}
    build.main()
    _, split_run = read_dist()
    rejected = [c for c in network.hatena_requests
                if sum(len(u) + 5 for u in c) > network.uri_limit]
    check(len(network.hatena_requests) > len(rejected) > 0,
          f'414を受けたリクエストを分割して取り直している '
          f'(全{len(network.hatena_requests)}回 / うち414が{len(rejected)}回)')
    recovered = find(split_run, '多産サイトの記事2')
    check(recovered is not None and recovered['hatena'] == 55,
          f"分割後にはてブ件数を取得できている ({recovered and recovered['hatena']})")
    network.uri_limit = 4000

    # --- 2周目: はてブの増分が配信物に載ることを確認 ---
    network.hatena = {'https://prolific.example/1': 120}
    build.main()
    _, second = read_dist()
    risen = find(second, '多産サイトの記事1')
    check(risen is not None and risen['hatena'] == 120 and risen['hatena_delta'] >= 117,
          f"はてブの増分が配信されている (delta={risen and risen['hatena_delta']})")

    # --- 3周目: 取得に失敗したソースが state から復元されることを確認 ---
    network.scrape_ok = False
    build.main()
    _, third = read_dist()
    check(find(third, '日時のないスクレイピング記事') is not None,
          '取得に失敗したソースの記事が state から復元されている')

    # --- 4周目: 取得はできたが全件フィルタされた場合は復元しない ---
    network.scrape_ok = True
    network.scrape_body = '<html><body><a href="/tag/bim">除外されるリンク</a></body></html>'
    build.main()
    _, fourth = read_dist()
    check(find(fourth, '日時のないスクレイピング記事') is None,
          '取得できたうえで0件のときは古い記事を復元しない')

    with open(os.path.join('data', 'state.json'), encoding='utf-8') as f:
        state = json.load(f)
    check(all(k == build.normalize_url(k) for k in state['articles']),
          'state のキーが正規化済みURLになっている')

    print('\nすべてのチェックに成功しました')


if __name__ == '__main__':
    main()
