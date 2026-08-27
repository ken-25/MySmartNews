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
         "selector": "a", "category_id": "construction"},
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

    def get(self, url, **kwargs):
        import requests

        if 'bookmark.hatenaapis' in url:
            urls = [v for k, v in kwargs.get('params', []) if k == 'url']
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
            return FakeResponse(rss([
                ('Googleニュース経由のBIM記事', 'https://gnews.example/1', 150)]))
        if 'scrape.example' in url:
            if not self.scrape_ok:
                raise requests.exceptions.ConnectionError('stubbed outage')
            return FakeResponse(
                '<html><body><a href="/page/1">日時のないスクレイピング記事</a></body></html>')
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

    check(any(t['name'] == '発見' for t in first['tabs']), '発見タブが生成されている')
    discovery = [t for t in first['tabs'] if t['name'] == '発見'][0]['articles']
    check(any('Googleニュース経由' in a['title'] for a in discovery),
          '登録外のキーワード検索記事が発見タブに入っている')

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

    with open(os.path.join('data', 'state.json'), encoding='utf-8') as f:
        state = json.load(f)
    check(all(k == build.normalize_url(k) for k in state['articles']),
          'state のキーが正規化済みURLになっている')

    print('\nすべてのチェックに成功しました')


if __name__ == '__main__':
    main()
