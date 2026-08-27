"""ネットワークをスタブして build.py のランキング挙動を検証する（CI用）。

外部フィードに依存せず、以下を保証する:
  - 同一サイトがTOPを独占しないこと（多様性ペナルティ）
  - 興味キーワードとはてブ急上昇がスコアに効くこと
  - URL正規化による重複排除
  - 公開日時のない記事に初回発見時刻が割り当てられること
  - 取得に失敗したサイトが state から復元されること
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

CONFIG = {
    "categories": [
        {"id": "it", "name": "IT", "order": 1},
        {"id": "construction", "name": "建設", "order": 2},
    ],
    "interests": [{"word": "BIM", "weight": 2.0}],
    "discovery": [
        {"name": "はてブ IT", "url": "https://b.hatena.ne.jp/hotentry/it.rss", "type": "rss"},
        {"name": "キーワード", "query": "BIM", "type": "keyword"},
    ],
    "sites": [
        {"name": "多産サイト", "url": "https://prolific.example/rss", "type": "rss",
         "category_id": "it"},
        {"name": "寡作サイト", "url": "https://quiet.example/rss", "type": "rss",
         "category_id": "construction"},
        {"name": "重複サイト", "url": "https://dup.example/rss", "type": "rss",
         "category_id": "it"},
        {"name": "スクレイピング", "url": "https://scrape.example/", "type": "html",
         "selector": "a", "category_id": "construction",
         "exclude": "/(tag|about)/"},
    ],
}


def rss(items):
    body = ''.join(
        '<item><title>{}</title><link>{}</link><pubDate>{}</pubDate></item>'.format(
            title, link, email.utils.format_datetime(NOW - timedelta(minutes=minutes)))
        for title, link, minutes in items)
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
        if 'prolific.example' in url:
            return FakeResponse(rss([
                (f'多産サイトの記事{i}', f'https://prolific.example/{i}', i * 3)
                for i in range(30)]))
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
            # 実物同様に長いリダイレクトURLを返す（414の再現）
            return FakeResponse(rss([
                (f'Googleニュース経由のBIM記事{i}',
                 'https://news.google.com/rss/articles/' + 'C' * 500 + str(i), 150 + i)
                for i in range(30)]))
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


def find(data, fragment):
    for tab in data['tabs']:
        for article in tab['articles']:
            if fragment in article['title']:
                return article
    return None


def check(condition, message):
    if not condition:
        print(f'✗ {message}')
        sys.exit(1)
    print(f'✓ {message}')


def main():
    workdir = tempfile.mkdtemp()
    shutil.copy(os.path.join(REPO_ROOT, 'build.py'), workdir)
    with open(os.path.join(workdir, 'sites.json'), 'w', encoding='utf-8') as f:
        json.dump(CONFIG, f, ensure_ascii=False)
    os.chdir(workdir)
    sys.path.insert(0, workdir)

    import requests
    network = Network()
    requests.get = network.get

    import build

    network.hatena = {'https://prolific.example/1': 3}
    build.main()
    with open('news.json', encoding='utf-8') as f:
        first = json.load(f)

    top = first['tabs'][0]['articles']
    # 純粋な新着順なら上位は多産サイトで埋まる。多様性ペナルティが効いていれば
    # 上位10件に複数のサイトが混ざる。
    head = top[:10]
    head_sites = {a['site_name'] for a in head}
    check(len(head_sites) >= 3,
          f'TOP上位10件が3サイト以上に分散している (内訳: {sorted(head_sites)})')
    check(sum(1 for a in head if a['site_name'] == '多産サイト') <= 7,
          'TOP上位10件を多産サイトが独占していない')
    check(find(first, 'BIM連携の新機能') is not None,
          '興味キーワードを含む寡作サイトの記事がTOPに載っている')

    links = [a['link'] for a in top]
    check(len(links) == len(set(links)), 'TOPに重複記事がない')
    check(sum(1 for a in top if a['title'] == '多産サイトの記事0') == 1,
          'トラッキングパラメータ違いの同一記事が重複排除されている')

    scraped = find(first, '日時のないスクレイピング記事')
    check(scraped is not None and scraped['time_ago'],
          f"公開日時のない記事に相対時刻が付いている ({scraped and scraped['time_ago']})")

    check(all('news.google.com' not in u
              for chunk in network.hatena_requests for u in chunk),
          'リダイレクトURLをはてブAPIに問い合わせていない')
    check(network.hatena_requests and all(
              sum(len(u) + 5 for u in chunk) <= network.uri_limit
              for chunk in network.hatena_requests),
          f'はてブAPIのリクエストがURI長の上限内に収まっている '
          f'({len(network.hatena_requests)}リクエスト)')

    check(find(first, 'このサイトについて') is None,
          'exclude パターンのリンクが除外されている')
    check(find(first, '短い') is None, '短すぎるタイトルが除外されている')
    dated = find(first, '日付が末尾に付いた記事')
    check(dated is not None and '2026年' not in dated['title'],
          f"タイトル末尾の日付が切り離されている ({dated and dated['title']})")

    check(any(t['name'] == '発見' for t in first['tabs']), '発見タブが生成されている')
    discovery = [t for t in first['tabs'] if t['name'] == '発見'][0]['articles']
    check(any('Googleニュース経由' in a['title'] for a in discovery),
          '登録外のキーワード検索記事が発見タブに入っている')

    # --- URIの上限が想定より厳しい場合に、分割して取り直せることを確認 ---
    network.hatena_requests = []
    network.uri_limit = 200
    network.hatena = {'https://prolific.example/2': 55}
    build.main()
    with open('news.json', encoding='utf-8') as f:
        split_run = json.load(f)
    rejected = [c for c in network.hatena_requests
                if sum(len(u) + 5 for u in c) > network.uri_limit]
    check(len(network.hatena_requests) > len(rejected) > 0,
          f'414を受けたリクエストを分割して取り直している '
          f'(全{len(network.hatena_requests)}回 / うち414が{len(rejected)}回)')
    recovered = find(split_run, '多産サイトの記事2')
    check(recovered is not None and recovered['hatena'] == 55,
          f"分割後にはてブ件数を取得できている ({recovered and recovered['hatena']})")
    network.uri_limit = 4000

    # --- 2周目: はてブが急増した記事が浮上することを確認 ---
    network.hatena = {'https://prolific.example/1': 120}
    build.main()
    with open('news.json', encoding='utf-8') as f:
        second = json.load(f)

    risen = find(second, '多産サイトの記事1')
    check(risen is not None and risen['rising'] and risen['hot'],
          'はてブが急増した記事が急上昇として検出されている')
    check(second['tabs'][0]['articles'][0]['title'] == '多産サイトの記事1',
          '急上昇した記事がTOPの先頭に来ている')

    # --- 3周目: 取得に失敗したサイトが state から復元されることを確認 ---
    network.scrape_ok = False
    build.main()
    with open('news.json', encoding='utf-8') as f:
        third = json.load(f)
    check(find(third, '日時のないスクレイピング記事') is not None,
          '取得に失敗したサイトの記事が state から復元されている')

    # --- 4周目: 取得はできたが全件フィルタされた場合は復元しない ---
    network.scrape_ok = True
    network.scrape_body = '<html><body><a href="/tag/bim">除外されるリンク</a></body></html>'
    build.main()
    with open('news.json', encoding='utf-8') as f:
        fourth = json.load(f)
    check(find(fourth, '日時のないスクレイピング記事') is None,
          '取得できたうえで0件のときは古い記事を復元しない')

    with open(os.path.join('data', 'state.json'), encoding='utf-8') as f:
        state = json.load(f)
    check(all(k == build.normalize_url(k) for k in state['articles']),
          'state のキーが正規化済みURLになっている')

    print('\nすべてのチェックに成功しました')


if __name__ == '__main__':
    main()
