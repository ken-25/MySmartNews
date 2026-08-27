"""MySmartNews ビルドスクリプト

sites.json の設定に従って記事を収集し、スコアリングした結果を news.json に書き出す。
表示は index.html + app.js が news.json を読んで行うため、このスクリプトは
HTML を生成しない（毎時のコミット差分をデータ部分だけに抑えるため）。

data/state.json にビルド間で引き継ぐ状態を保存する。DBの代わりだが、
中身は「7日以内に見た記事のメタ情報」だけの軽量なビルドキャッシュ。
"""

import os
import re
import json
import math
import time
import requests
import feedparser
from bs4 import BeautifulSoup
from urllib.parse import (urljoin, urlparse, urlencode, parse_qsl,
                          quote_plus, urlunparse)
from datetime import datetime, timedelta, timezone

# タイムゾーン（JST）
JST = timezone(timedelta(hours=+9), 'JST')

STATE_PATH = os.path.join('data', 'state.json')
OUTPUT_PATH = 'news.json'

USER_AGENT = 'MySmartNewsBot/1.0 (+https://github.com/ken-25/MySmartNews)'

# discovery の type: "keyword" が使う検索フィード。{query} にURLエンコード済みの
# 検索式が入る。別の検索サービスに乗り換えるならここだけ差し替えればよい。
KEYWORD_SEARCH_FEED = ('https://news.google.com/rss/search'
                       '?q={query}&hl=ja&gl=JP&ceid=JP:ja')
HATENA_COUNT_API = 'https://bookmark.hatenaapis.com/count/entries'
REQUEST_TIMEOUT = 15

# --- スコアリングのチューニング定数 ---
HALF_LIFE_HOURS = 8.0      # 鮮度の半減期
DIVERSITY_DECAY = 0.6      # 同一サイトが1件増えるごとにスコアへ掛かる係数
POPULARITY_WEIGHT = 0.6    # はてブ累計数の効き
VELOCITY_WEIGHT = 1.2      # はてブ増加数（急上昇）の効き
HOT_THRESHOLD = 30         # 🔥 バッジを出す累計ブックマーク数
RISING_THRESHOLD = 10      # 急上昇と見なす前回ビルドからの増分
STATE_RETENTION_DAYS = 7   # state.json に記事を保持する日数
NEW_WINDOW_HOURS = 3       # NEW バッジを出す初回発見からの時間
STALE_FALLBACK_HOURS = 48  # 取得失敗時に前回結果を使う上限
HATENA_MAX_URLS = 50       # はてブ件数APIの1リクエストあたり上限件数
HATENA_MAX_QUERY_BYTES = 3000  # 同、クエリ文字列の長さの上限（414対策）
MIN_SCRAPED_TITLE_LEN = 8  # スクレイピングで拾うタイトルの最小文字数
TOP_LIMIT = 40
CATEGORY_LIMIT = 60
DISCOVERY_LIMIT = 40
PER_SOURCE_LIMIT = 30

TRACKING_PARAM_RE = re.compile(r'^(utm_|fbclid$|gclid$|mc_cid$|mc_eid$|ref$|ref_src$|cmpid$)')
TRAILING_DATE_RE = re.compile(r'\s*(\d{4})年(\d{1,2})月(\d{1,2})日\s*$')


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


def make_article(site_name, title, link, published_at, category_id, kind,
                 image=None, hatena=None, bookmarkable=True):
    return {
        "site_name": site_name,
        "title": title.strip(),
        "link": link,
        "url_key": normalize_url(link),
        "published_at": published_at,
        "category_id": category_id,
        "kind": kind,          # 'site' or 'discovery'
        "image": image,
        "hatena": hatena,
        # リンクがリダイレクト用URLの場合、実記事に付いたブックマークとは
        # 結びつかないので件数を問い合わせない
        "bookmarkable": bookmarkable,
    }


def fetch_rss(source, category_id, kind, bookmarkable=True):
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
        # Googleニュース検索RSSは実サイト名を source に持つ
        site_name = source['name']
        source_meta = getattr(entry, 'source', None)
        if source_meta is not None:
            site_name = (source_meta.get('title') if hasattr(source_meta, 'get') else None) or site_name
        articles.append(make_article(
            site_name, title, link, entry_datetime(entry), category_id, kind,
            image=entry_image(entry), hatena=entry_hatena_count(entry),
            bookmarkable=bookmarkable,
        ))
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


def fetch_html(source, category_id, kind):
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
        articles.append(make_article(source['name'], title, link, published_at,
                                     category_id, kind))
        if len(articles) >= PER_SOURCE_LIMIT:
            break

    if skipped:
        print(f"  {source['name']}: {skipped}件をパターン/文字数で除外")
    return articles


def fetch_keyword(source, kind):
    """キーワード検索フィード。登録していないサイトの記事が入ってくる。

    配信されるリンクは実記事へのリダイレクトURLなので bookmarkable=False とする。
    """
    url = KEYWORD_SEARCH_FEED.format(query=quote_plus(source['query']))
    return fetch_rss({'name': source['name'], 'url': url}, '', kind,
                     bookmarkable=False)


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


def recover_from_state(state, site_name, category_id, kind, now):
    """取得に失敗したサイトは、直近のstateから記事を復元して空タブを防ぐ。"""
    cutoff = now - timedelta(hours=STALE_FALLBACK_HOURS)
    recovered = []
    for key, meta in state['articles'].items():
        if meta.get('site_name') != site_name:
            continue
        first_seen = from_iso(meta.get('first_seen'))
        if not first_seen or first_seen < cutoff:
            continue
        recovered.append(make_article(
            site_name, meta.get('title', ''), meta.get('link', key),
            from_iso(meta.get('published_at')), category_id, kind,
            image=meta.get('image')))
    recovered.sort(key=lambda a: a['published_at'] or datetime.min.replace(tzinfo=JST),
                   reverse=True)
    return recovered[:PER_SOURCE_LIMIT]


def match_interests(title, interests):
    """タイトルに含まれる興味キーワードを返す。"""
    lowered = title.lower()
    return [i for i in interests if i['word'].lower() in lowered]


def compute_score(article, now, interests):
    age_hours = max((now - article['effective_at']).total_seconds() / 3600.0, 0.0)
    freshness = 0.5 ** (age_hours / HALF_LIFE_HOURS)

    hits = match_interests(article['title'], interests)
    article['matched'] = [h['word'] for h in hits]
    interest_mult = 1.0 + sum(h.get('weight', 1.0) for h in hits)

    hatena = article.get('hatena') or 0
    delta = article.get('hatena_delta') or 0
    popularity = (1.0
                  + POPULARITY_WEIGHT * math.log10(1 + hatena)
                  + VELOCITY_WEIGHT * math.log10(1 + max(delta, 0)))

    article['score'] = freshness * interest_mult * popularity
    return article['score']


def pick_diverse(articles, limit):
    """スコア順に選びつつ、同じサイトが続くほどスコアを割り引く（貪欲MMR）。

    純粋な新着順だと更新頻度の高いサイトが一覧を独占してしまうため、
    ここで多様性を確保する。
    """
    pool = sorted(articles, key=lambda a: a['score'], reverse=True)
    chosen = []
    used = {}
    while pool and len(chosen) < limit:
        best_index, best_value = 0, -1.0
        for index, article in enumerate(pool):
            value = article['score'] * (DIVERSITY_DECAY ** used.get(article['site_name'], 0))
            if value > best_value:
                best_index, best_value = index, value
        picked = pool.pop(best_index)
        used[picked['site_name']] = used.get(picked['site_name'], 0) + 1
        chosen.append(picked)
    return chosen


def serialize(article, now):
    age = now - article['effective_at']
    seconds = age.total_seconds()
    if seconds < 3600:
        time_ago = f"{max(int(seconds / 60), 0)}分前"
    elif seconds < 86400:
        time_ago = f"{int(seconds / 3600)}時間前"
    else:
        time_ago = f"{int(seconds / 86400)}日前"

    hatena = article.get('hatena') or 0
    delta = article.get('hatena_delta') or 0
    return {
        "title": article['title'],
        "link": article['link'],
        "site_name": article['site_name'],
        "category_id": article['category_id'],
        "time_ago": time_ago,
        "image": article.get('image'),
        "hatena": hatena,
        "hot": hatena >= HOT_THRESHOLD,
        "rising": delta >= RISING_THRESHOLD,
        "is_new": (now - article['first_seen']).total_seconds() < NEW_WINDOW_HOURS * 3600,
        "matched": article.get('matched', []),
        "kind": article['kind'],
    }


def main():
    now = now_jst()
    with open('sites.json', 'r', encoding='utf-8') as f:
        config = json.load(f)

    categories = config.get('categories', [])
    interests = config.get('interests', [])
    sites = config.get('sites', [])
    discovery_sources = config.get('discovery', [])

    state = load_state()
    collected = []

    for site in sites:
        print(f"Fetching {site['name']}...")
        category_id = site.get('category_id', '')
        if site['type'] == 'rss':
            articles = fetch_rss(site, category_id, 'site')
        else:
            articles = fetch_html(site, category_id, 'site')
        if articles is None:
            # 取得できなかったときだけ前回の結果で埋める。取得できたうえで
            # 0件だった場合は設定の問題なので、古い記事を蘇らせない。
            articles = recover_from_state(state, site['name'], category_id, 'site', now)
            print(f"  !! {site['name']} は取得失敗。stateから{len(articles)}件を復元")
        elif not articles:
            print(f"  !! {site['name']} は0件（セレクタやパターンの設定を確認）")
        collected.extend(articles)

    for source in discovery_sources:
        print(f"Discovering {source['name']}...")
        if source['type'] == 'keyword':
            articles = fetch_keyword(source, 'discovery')
        else:
            articles = fetch_rss(source, '', 'discovery')
        if not articles:
            print(f"  !! 発見ソース {source['name']} は0件")
        collected.extend(articles or [])

    # URL正規化ベースで重複排除（ASCII.jpの総合/テック重複などを吸収）。
    # 登録サイト由来を優先し、後から来た発見ソースの重複は捨てる。
    unique = {}
    for article in collected:
        existing = unique.get(article['url_key'])
        if existing is None:
            unique[article['url_key']] = article
        elif existing['kind'] == 'discovery' and article['kind'] == 'site':
            unique[article['url_key']] = article
    articles = list(unique.values())
    print(f"収集 {len(collected)} 件 → 重複排除後 {len(articles)} 件")

    # はてブ件数（フィードが件数を持っている記事と、リダイレクトURLしか
    # 分からない記事は問い合わせない）
    need_counts = [a['link'] for a in articles
                   if a.get('hatena') is None and a['bookmarkable']]
    skipped = sum(1 for a in articles if not a['bookmarkable'])
    if skipped:
        print(f"  はてブ件数の問い合わせ対象外: {skipped}件（リダイレクトURL）")
    counts = fetch_hatena_counts(need_counts)

    stored = state['articles']
    for article in articles:
        key = article['url_key']
        meta = stored.get(key, {})

        if article.get('hatena') is None:
            article['hatena'] = counts.get(article['link'], 0)

        # 公開日時が取れない記事（HTMLスクレイピング）は初回発見時刻で代用する
        first_seen = from_iso(meta.get('first_seen')) or now
        article['first_seen'] = first_seen
        article['effective_at'] = article['published_at'] or first_seen
        article['hatena_delta'] = article['hatena'] - int(meta.get('hatena') or 0)

        stored[key] = {
            "first_seen": to_iso(first_seen),
            "published_at": to_iso(article['published_at']),
            "hatena": article['hatena'],
            "site_name": article['site_name'],
            "title": article['title'],
            "link": article['link'],
            "image": article.get('image'),
        }

        compute_score(article, now, interests)

    site_articles = [a for a in articles if a['kind'] == 'site']
    discovery_articles = [a for a in articles if a['kind'] == 'discovery']

    tabs = [{
        "id": "top",
        "name": "TOP",
        "articles": [serialize(a, now) for a in pick_diverse(articles, TOP_LIMIT)],
    }]

    for category in sorted(categories, key=lambda c: c['order']):
        in_category = [a for a in site_articles if a['category_id'] == category['id']]
        if not in_category:
            continue
        tabs.append({
            "id": f"category-{category['id']}",
            "name": category['name'],
            "articles": [serialize(a, now)
                         for a in pick_diverse(in_category, CATEGORY_LIMIT)],
        })

    if discovery_articles:
        tabs.append({
            "id": "discovery",
            "name": "発見",
            "articles": [serialize(a, now)
                         for a in pick_diverse(discovery_articles, DISCOVERY_LIMIT)],
        })

    for site in sites:
        owned = [a for a in site_articles if a['site_name'] == site['name']]
        if not owned:
            # 取得に失敗し続けているサイトは空タブを並べても邪魔なので出さない
            # （ビルドログには警告が残るので設定ミスには気づける）
            print(f"  !! {site['name']} のタブは0件のためスキップ")
            continue
        owned.sort(key=lambda a: a['effective_at'], reverse=True)
        tabs.append({
            "id": "site-" + re.sub(r'[^a-z0-9]+', '-', site['name'].lower()).strip('-'),
            "name": site['name'],
            "articles": [serialize(a, now) for a in owned],
        })

    payload = {
        "updated_at": to_iso(now),
        "updated_label": now.strftime("%Y-%m-%d %H:%M"),
        "interests": [i['word'] for i in interests],
        "tabs": tabs,
    }
    with open(OUTPUT_PATH, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=1)
    print(f"{OUTPUT_PATH} generated: {len(tabs)} タブ / {len(articles)} 記事")

    save_state(state, now)


if __name__ == "__main__":
    main()
