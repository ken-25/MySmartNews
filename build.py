"""MySmartNews ビルドスクリプト

catalog/ のカテゴリパック定義に従って記事を収集し、dist/ に静的な配信物を書き出す。

このスクリプトは**並び順を決めない**。出すのは誰にとっても同じ客観的な信号
（公開時刻・初回発見時刻・はてなブックマーク数とその増分）だけで、
「どれを上に出すか」はブラウザ側が各ユーザーの設定で決める。
こうしておくと、配信物は1つのまま何人が何通りの趣向で使っても成立する。

data/state.json にビルド間で引き継ぐ状態を保存する。DBの代わりだが、
中身は「7日以内に見た記事のメタ情報」だけの軽量なビルドキャッシュ。
"""

import os
import re
import json
import time
import shutil
import hashlib
import unicodedata
import requests
import feedparser
from bs4 import BeautifulSoup
from urllib.parse import (urljoin, urlparse, urlencode, parse_qsl,
                          quote_plus, urlunparse)
from datetime import datetime, timedelta, timezone

# タイムゾーン（JST）
JST = timezone(timedelta(hours=+9), 'JST')

CATALOG_DIR = 'catalog'
STATE_PATH = os.path.join('data', 'state.json')
DIST_DIR = 'dist'
STATIC_FILES = ['index.html', 'app.js', 'style.css', 'manifest.webmanifest']

USER_AGENT = 'MySmartNewsBot/2.0 (+https://github.com/ken-25/MySmartNews)'

# type: "query" が使う検索フィード。{query} にURLエンコード済みの検索式が入る。
# 別の検索サービスに乗り換えるならここだけ差し替えればよい。
KEYWORD_SEARCH_FEED = ('https://news.google.com/rss/search'
                       '?q={query}&hl=ja&gl=JP&ceid=JP:ja')
HATENA_COUNT_API = 'https://bookmark.hatenaapis.com/count/entries'
REQUEST_TIMEOUT = 15

STATE_RETENTION_DAYS = 7   # state.json に記事を保持する日数
STALE_FALLBACK_HOURS = 48  # 取得失敗時に前回結果を使う上限
HATENA_MAX_URLS = 50       # はてブ件数APIの1リクエストあたり上限件数
HATENA_MAX_QUERY_BYTES = 3000  # 同、クエリ文字列の長さの上限（414対策）
MIN_SCRAPED_TITLE_LEN = 8  # スクレイピングで拾うタイトルの最小文字数
PER_SOURCE_LIMIT = 30      # 1ソースから取り込む最大件数
PACK_LIMIT = 120           # 1パックの配信件数

# リンクがこのホストのものは実記事URLではなくリダイレクトURLなので、
# 実記事に付いたブックマーク数とは結びつかない。件数を問い合わせない。
REDIRECT_HOSTS = ('news.google.com',)

TRACKING_PARAM_RE = re.compile(r'^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|cmpid$)')
TRAILING_DATE_RE = re.compile(r'\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*$')
# 記号・空白・約物をすべて落とし、英数字と日本語の文字だけ残す。
CLUSTER_KEEP_RE = re.compile(r'[^0-9a-z\u3040-\u30ff\u3400-\u9fff]+')


def now_jst():
    return datetime.now(JST)


def to_iso(dt):
    return dt.astimezone(JST).isoformat() if dt else None


def from_iso(text):
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def bare_host(netloc):
    """ホスト名を小文字にし、先頭の www. だけを取り除く。"""
    host = netloc.lower()
    return host[4:] if host.startswith('www.') else host


def normalize_url(url):
    """トラッキングパラメータとフラグメントを落として重複判定に使うURLを作る。"""
    if not url:
        return url
    try:
        parts = urlparse(url)
    except ValueError:
        return url
    query = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not TRACKING_PARAM_RE.match(k)]
    path = parts.path.rstrip('/') or '/'
    return urlunparse((parts.scheme, bare_host(parts.netloc), path, '',
                       urlencode(query), ''))


def is_redirect_link(url):
    try:
        return bare_host(urlparse(url).netloc) in REDIRECT_HOSTS
    except ValueError:
        return False


def cluster_id(title):
    """同じ話題を各社が配信したときにまとめるためのキー。

    記号と空白を落としたタイトルのハッシュ。表記ゆれまでは吸収しないが、
    Googleニュース経由で同一タイトルが重複して届くケースはこれで潰せる。
    """
    folded = unicodedata.normalize('NFKC', title).lower()
    normalized = CLUSTER_KEEP_RE.sub('', folded)
    return hashlib.sha1(normalized.encode('utf-8')).hexdigest()[:12]


def entry_datetime(entry):
    for key in ['published_parsed', 'updated_parsed']:
        value = getattr(entry, key, None)
        if value:
            dt = datetime.fromtimestamp(time.mktime(value))
            return dt.replace(tzinfo=timezone.utc).astimezone(JST)
    return None


def entry_image(entry):
    """RSS が持っている範囲でサムネイル URL を拾う（追加リクエストはしない）。"""
    for key in ('media_thumbnail', 'media_content'):
        media = entry.get(key) if hasattr(entry, 'get') else None
        if media:
            url = media[0].get('url')
            if url:
                return url
    for enclosure in getattr(entry, 'enclosures', []) or []:
        if str(enclosure.get('type', '')).startswith('image/') and enclosure.get('href'):
            return enclosure['href']
    for key in ('content', 'summary'):
        value = getattr(entry, key, None)
        html = value[0].get('value') if isinstance(value, list) and value else value
        if isinstance(html, str) and '<img' in html:
            match = re.search(r'<img[^>]+src=["\']([^"\']+)["\']', html)
            if match:
                return match.group(1)
    return None


def entry_hatena_count(entry):
    """はてなのフィードは件数を埋め込んでいるので、あればAPIを叩かずに済ませる。"""
    for key in ('hatena_bookmarkcount', 'bookmarkcount'):
        value = entry.get(key) if hasattr(entry, 'get') else None
        if value is not None:
            try:
                return int(value)
            except (TypeError, ValueError):
                pass
    return None


def entry_site_name(entry, fallback):
    """Googleニュース経由のフィードは実際の媒体名を source に持つ。"""
    source_meta = getattr(entry, 'source', None)
    if source_meta is None:
        return fallback
    title = source_meta.get('title') if hasattr(source_meta, 'get') else None
    return title or fallback


def strip_source_suffix(title, site_name):
    """「記事タイトル - 媒体名」の末尾を落とす（Googleニュース対策）。"""
    suffix = ' - ' + site_name
    if site_name and title.endswith(suffix) and len(title) > len(suffix):
        return title[:-len(suffix)].strip()
    return title


def make_article(source, title, link, published_at, image=None, hatena=None,
                 site_name=None):
    title = title.strip()
    resolved = (site_name or source['name']).strip()
    return {
        "source_id": source['id'],
        "site_name": resolved,
        # フィードが媒体名を持っていた場合だけ True。別パックが同じフィードを
        # 参照したときに、媒体名を上書きしてよいかの判断に使う。
        "named_by_feed": resolved != source['name'],
        "title": title,
        "link": link,
        "url_key": normalize_url(link),
        "cluster": cluster_id(title),
        "published_at": published_at,
        "image": image,
        "hatena": hatena,
        "bookmarkable": not is_redirect_link(link),
    }


def fetch_rss(source):
    """取得できたら記事のリスト、取得自体に失敗したら None を返す。"""
    articles = []
    try:
        res = requests.get(source['url'], timeout=REQUEST_TIMEOUT,
                           headers={'User-Agent': USER_AGENT})
        res.raise_for_status()
        feed = feedparser.parse(res.content)
    except Exception as exc:
        print(f"  !! RSS取得に失敗: {source['name']} ({exc})")
        return None

    for entry in feed.entries[:PER_SOURCE_LIMIT]:
        title = getattr(entry, 'title', '')
        link = getattr(entry, 'link', '')
        if not title or not link:
            continue
        site_name = entry_site_name(entry, source['name'])
        articles.append(make_article(
            source, strip_source_suffix(title, site_name), link,
            entry_datetime(entry), image=entry_image(entry),
            hatena=entry_hatena_count(entry), site_name=site_name))
    return articles


def split_trailing_date(title):
    """「記事タイトル2026年8月21日」のように末尾に付く日付を切り離す。

    カード全体を get_text したときに日付まで拾ってしまうサイト向け。
    """
    match = TRAILING_DATE_RE.search(title)
    if not match:
        return title, None
    year, month, day = (int(g) for g in match.groups())
    try:
        published = datetime(year, month, day, tzinfo=JST)
    except ValueError:
        return title, None
    return title[:match.start()].strip(), published


def fetch_html(source):
    """取得できたら記事のリスト、取得自体に失敗したら None を返す。"""
    articles = []
    try:
        res = requests.get(source['url'], timeout=REQUEST_TIMEOUT,
                           headers={'User-Agent': USER_AGENT})
        res.raise_for_status()
        res.encoding = res.apparent_encoding
        soup = BeautifulSoup(res.text, 'html.parser')
    except Exception as exc:
        print(f"  !! HTML取得に失敗: {source['name']} ({exc})")
        return None

    # ナビゲーションやタグ一覧のリンクを落とすためのURLパターン（任意）
    include = re.compile(source['include']) if source.get('include') else None
    exclude = re.compile(source['exclude']) if source.get('exclude') else None

    seen = set()
    skipped = 0
    for anchor in soup.select(source['selector']):
        title = anchor.get_text(strip=True)
        href = anchor.get('href')
        if not title or not href:
            continue
        link = urljoin(source['url'], href)
        if not link.startswith('http'):
            continue
        if include and not include.search(link):
            skipped += 1
            continue
        if exclude and exclude.search(link):
            skipped += 1
            continue

        title, published_at = split_trailing_date(title)
        if len(title) < MIN_SCRAPED_TITLE_LEN:
            skipped += 1
            continue

        key = normalize_url(link)
        if key in seen:
            continue
        seen.add(key)
        # 日付が拾えなければ初回発見時刻で代用する
        articles.append(make_article(source, title, link, published_at))
        if len(articles) >= PER_SOURCE_LIMIT:
            break

    if skipped:
        print(f"  {source['name']}: {skipped}件をパターン/文字数で除外")
    return articles


def fetch_query(source):
    """キーワード検索フィード。登録していないサイトの記事が入ってくる。"""
    url = KEYWORD_SEARCH_FEED.format(query=quote_plus(source['query']))
    return fetch_rss(dict(source, url=url))


def fetch_source(source):
    if source['type'] == 'query':
        return fetch_query(source)
    if source['type'] == 'html':
        return fetch_html(source)
    return fetch_rss(source)


def fetch_key(source):
    """同じフィードを複数パックが参照していても1回しか取りに行かないためのキー。"""
    return source.get('query') if source['type'] == 'query' else source.get('url')


def hatena_chunks(urls):
    """件数と、URLをクエリに詰めたときのバイト長の両方で分割する。

    Googleニュース経由のリンクは 500 文字を超えることがあり、件数だけで
    50件ずつに切ると URI が長すぎて 414 になる。
    """
    chunk, size = [], 0
    for url in urls:
        cost = len(urlencode([('url', url)])) + 1
        if chunk and (len(chunk) >= HATENA_MAX_URLS
                      or size + cost > HATENA_MAX_QUERY_BYTES):
            yield chunk
            chunk, size = [], 0
        chunk.append(url)
        size += cost
    if chunk:
        yield chunk


def request_hatena_chunk(chunk, counts, depth=0):
    try:
        res = requests.get(
            HATENA_COUNT_API,
            params=[('url', u) for u in chunk],
            timeout=REQUEST_TIMEOUT, headers={'User-Agent': USER_AGENT})
        res.raise_for_status()
        counts.update({k: int(v) for k, v in res.json().items()})
        return
    except Exception as exc:
        status = getattr(getattr(exc, 'response', None), 'status_code', None)
        # URIが長すぎる場合だけは分割して取り直す（他のエラーで再試行はしない）
        if status in (413, 414) and len(chunk) > 1 and depth < 5:
            middle = len(chunk) // 2
            request_hatena_chunk(chunk[:middle], counts, depth + 1)
            request_hatena_chunk(chunk[middle:], counts, depth + 1)
            return
        print(f"  !! はてブ件数の取得に失敗（{len(chunk)}件をスコア0扱いで続行）: {exc}")


def fetch_hatena_counts(urls):
    """はてなブックマーク件数API（無料・認証不要）をまとめて叩く。"""
    counts = {}
    targets = [u for u in urls if u and u.startswith('http')]
    for chunk in hatena_chunks(targets):
        request_hatena_chunk(chunk, counts)
    return counts


def load_catalog():
    """catalog/index.json とパック定義を読み込む。"""
    with open(os.path.join(CATALOG_DIR, 'index.json'), 'r', encoding='utf-8') as f:
        index = json.load(f)
    packs = []
    for meta in sorted(index['packs'], key=lambda p: p.get('order', 999)):
        path = os.path.join(CATALOG_DIR, 'packs', f"{meta['id']}.json")
        with open(path, 'r', encoding='utf-8') as f:
            body = json.load(f)
        packs.append(dict(meta, sources=body.get('sources', []),
                          suggested_interests=body.get('suggested_interests', [])))
    return packs


def load_state():
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            state = json.load(f)
    except (OSError, ValueError):
        return {"articles": {}}
    state.setdefault('articles', {})
    return state


def save_state(state, now):
    cutoff = now - timedelta(days=STATE_RETENTION_DAYS)
    kept = {}
    for key, meta in state['articles'].items():
        first_seen = from_iso(meta.get('first_seen'))
        if first_seen and first_seen >= cutoff:
            kept[key] = meta
    state['articles'] = kept
    state['updated_at'] = to_iso(now)
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    with open(STATE_PATH, 'w', encoding='utf-8') as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"state.json: {len(kept)} 件を保持")


def recover_from_state(state, source, now):
    """取得に失敗したソースは、直近のstateから記事を復元して空タブを防ぐ。"""
    cutoff = now - timedelta(hours=STALE_FALLBACK_HOURS)
    recovered = []
    for key, meta in state['articles'].items():
        if meta.get('source_id') != source['id']:
            continue
        first_seen = from_iso(meta.get('first_seen'))
        if not first_seen or first_seen < cutoff:
            continue
        recovered.append(make_article(
            source, meta.get('title', ''), meta.get('link', key),
            from_iso(meta.get('published_at')), image=meta.get('image'),
            site_name=meta.get('site_name')))
    recovered.sort(key=lambda a: a['published_at'] or datetime.min.replace(tzinfo=JST),
                   reverse=True)
    return recovered[:PER_SOURCE_LIMIT]


def collect(packs, state, now):
    """パックごとに記事を集める。同じフィードは何パックから参照されても1回だけ取る。"""
    cache = {}
    per_pack = {}
    for pack in packs:
        collected = []
        for source in pack['sources']:
            key = fetch_key(source)
            if key in cache:
                articles = [dict(a, source_id=source['id'],
                                 site_name=(a['site_name'] if a['named_by_feed']
                                            else source['name']))
                            for a in cache[key]]
            else:
                print(f"Fetching {pack['id']}/{source['id']} ({source['name']})...")
                articles = fetch_source(source)
                if articles is None:
                    # 取得できなかったときだけ前回の結果で埋める。取得できたうえで
                    # 0件だった場合は設定の問題なので、古い記事を蘇らせない。
                    articles = recover_from_state(state, source, now)
                    print(f"  !! 取得失敗。stateから{len(articles)}件を復元")
                elif not articles:
                    print("  !! 0件（セレクタやパターンの設定を確認）")
                cache[key] = articles
            collected.extend(articles)
        per_pack[pack['id']] = collected
    return per_pack


def serialize(article):
    """配信する記事1件。並び順に関わる主観的な値はここでは持たせない。"""
    return {
        "title": article['title'],
        "link": article['link'],
        "key": article['url_key'],
        "site": article['site_name'],
        "source": article['source_id'],
        "cluster": article['cluster'],
        "published_at": to_iso(article['effective_at']),
        "dated": bool(article['published_at']),
        "first_seen": to_iso(article['first_seen']),
        "image": article.get('image'),
        "hatena": article.get('hatena') or 0,
        "hatena_delta": max(article.get('hatena_delta') or 0, 0),
    }


def write_dist(packs, per_pack, now):
    os.makedirs(os.path.join(DIST_DIR, 'p'), exist_ok=True)

    index_packs = []
    for pack in packs:
        articles = per_pack[pack['id']]
        if not articles:
            print(f"  !! パック {pack['id']} は0件のためカタログから除外")
            continue
        payload = {
            "id": pack['id'],
            "updated_at": to_iso(now),
            "articles": [serialize(a) for a in articles],
        }
        path = os.path.join(DIST_DIR, 'p', f"{pack['id']}.json")
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, separators=(',', ':'))
        index_packs.append({
            "id": pack['id'],
            "name": pack['name'],
            "emoji": pack.get('emoji', ''),
            "description": pack.get('description', ''),
            "default": bool(pack.get('default')),
            "count": len(articles),
            "suggested_interests": pack['suggested_interests'],
            "sources": [{"id": s['id'], "name": s['name']}
                        for s in pack['sources']],
        })

    index = {
        "version": 2,
        "updated_at": to_iso(now),
        "updated_label": now.strftime('%Y-%m-%d %H:%M'),
        "packs": index_packs,
    }
    with open(os.path.join(DIST_DIR, 'index.json'), 'w', encoding='utf-8') as f:
        json.dump(index, f, ensure_ascii=False, separators=(',', ':'))

    for name in STATIC_FILES:
        if os.path.exists(name):
            shutil.copy(name, os.path.join(DIST_DIR, name))
    if os.path.exists('_headers'):
        shutil.copy('_headers', os.path.join(DIST_DIR, '_headers'))
    total = sum(len(a) for a in per_pack.values())
    print(f"{DIST_DIR}/: {len(index_packs)} パック / 延べ {total} 記事")


def main():
    now = now_jst()
    packs = load_catalog()
    state = load_state()

    per_pack = collect(packs, state, now)

    # パック内の重複排除（同じ記事が複数ソースから来る）と、全体のはてブ件数取得。
    unique = {}
    for pack_id, articles in per_pack.items():
        deduped = {}
        for article in articles:
            deduped.setdefault(article['url_key'], article)
        per_pack[pack_id] = list(deduped.values())
        for article in per_pack[pack_id]:
            unique.setdefault(article['url_key'], article)

    need_counts = [a['link'] for a in unique.values()
                   if a.get('hatena') is None and a['bookmarkable']]
    skipped = sum(1 for a in unique.values() if not a['bookmarkable'])
    if skipped:
        print(f"  はてブ件数の問い合わせ対象外: {skipped}件（リダイレクトURL）")
    counts = fetch_hatena_counts(need_counts)

    stored = state['articles']
    signals = {}
    for key, article in unique.items():
        meta = stored.get(key, {})
        hatena = article['hatena']
        if hatena is None:
            hatena = counts.get(article['link'], 0)

        # 公開日時が取れない記事（HTMLスクレイピング）は初回発見時刻で代用する
        first_seen = from_iso(meta.get('first_seen')) or now
        signals[key] = {
            "hatena": hatena,
            "hatena_delta": hatena - int(meta.get('hatena') or 0),
            "first_seen": first_seen,
            "effective_at": article['published_at'] or first_seen,
        }
        stored[key] = {
            "first_seen": to_iso(first_seen),
            "published_at": to_iso(article['published_at']),
            "hatena": hatena,
            "source_id": article['source_id'],
            "site_name": article['site_name'],
            "title": article['title'],
            "link": article['link'],
            "image": article.get('image'),
        }

    for pack_id, articles in per_pack.items():
        for article in articles:
            article.update(signals[article['url_key']])
        articles.sort(key=lambda a: a['effective_at'], reverse=True)
        per_pack[pack_id] = articles[:PACK_LIMIT]

    write_dist(packs, per_pack, now)
    save_state(state, now)


if __name__ == "__main__":
    main()
