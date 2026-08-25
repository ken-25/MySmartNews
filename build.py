import os
import requests
import feedparser
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from datetime import datetime, timedelta, timezone

# タイムゾーン（JST）
JST = timezone(timedelta(hours=+9), 'JST')

# --- 設定：取得したいサイト一覧 ---
# type: 'rss' または 'html' を指定
# selector: htmlの場合、記事リンクを取得するためのCSSセレクタ
SITES = [
    {
        "name": "ITmedia",
        "url": "https://rss.itmedia.co.jp/rss/2.0/itmedia_all.xml",
        "type": "rss"
    },
    {
        "name": "Archi Future Web",
        "url": "https://www.archifuture-web.jp/magazine/index2.html",
        "type": "html",
        "selector": "a" # 一旦すべてのリンクを取得。ノイズが多い場合はここを調整
    },
    {
        "name": "Revit Peeler",
        "url": "https://www.revitpeeler.com/feeds/posts/default?alt=rss",
        "type": "rss"
    }
]

def fetch_rss(url):
    articles = []
    feed = feedparser.parse(url)
    for entry in feed.entries[:15]: # 最新15件
        articles.append({"title": entry.title, "link": entry.link})
    return articles

def fetch_html(url, selector):
    articles = []
    try:
        res = requests.get(url, timeout=10)
        res.encoding = res.apparent_encoding
        soup = BeautifulSoup(res.text, 'html.parser')
        links = soup.select(selector)
        seen = set()
        for a in links:
            title = a.get_text(strip=True)
            link = a.get('href')
            if not title or not link or len(title) < 5: continue # 短すぎるテキストは除外
            
            # 相対URLを絶対URLに変換
            link = urljoin(url, link)
            
            # 不要なリンク（JavaScript等）を除外
            if not link.startswith('http'): continue
            
            if link not in seen:
                seen.add(link)
                articles.append({"title": title, "link": link})
            if len(articles) >= 15: break
    except Exception as e:
        print(f"Error fetching {url}: {e}")
    return articles

def generate_html(data):
    now = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")
    
    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <!-- PWA / iPhone アプリ化用のタグ -->
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="MyNews">
    <title>MyNews - 自分専用ニュース</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 15px; background: #f2f2f7; }}
        .header {{ text-align: center; margin-bottom: 20px; color: #8e8e93; font-size: 12px; }}
        .site {{ background: #fff; border-radius: 12px; padding: 15px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }}
        .site h2 {{ margin: 0 0 15px 0; font-size: 18px; color: #000; border-bottom: 1px solid #e5e5ea; padding-bottom: 8px; }}
        .article {{ margin-bottom: 12px; line-height: 1.4; }}
        .article:last-child {{ margin-bottom: 0; }}
        .article a {{ text-decoration: none; color: #007aff; font-size: 15px; display: block; }}
        .article a:visited {{ color: #5856d6; }}
    </style>
</head>
<body>
    <div class="header">最終更新: {now}</div>
"""
    for site in data:
        html += f'<div class="site">\n<h2>{site["name"]}</h2>\n'
        for art in site["articles"]:
            html += f'<div class="article"><a href="{art["link"]}" target="_blank">{art["title"]}</a></div>\n'
        html += '</div>\n'
    
    html += "</body>\n</html>"
    return html

def main():
    data = []
    for site in SITES:
        print(f"Fetching {site['name']}...")
        if site['type'] == 'rss':
            articles = fetch_rss(site['url'])
        else:
            articles = fetch_html(site['url'], site['selector'])
        data.append({"name": site["name"], "articles": articles})
    
    html_content = generate_html(data)
    
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html_content)
    print("index.html generated successfully.")

if __name__ == "__main__":
    main()
