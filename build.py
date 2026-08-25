import os
import json
import time
import requests
import feedparser
from bs4 import BeautifulSoup
from urllib.parse import urljoin
from datetime import datetime, timedelta, timezone

# タイムゾーン（JST）
JST = timezone(timedelta(hours=+9), 'JST')

def get_time_ago(dt):
    if not dt:
        return ""
    now = datetime.now(JST)
    diff = now - dt
    
    if diff.total_seconds() < 3600:
        minutes = int(diff.total_seconds() / 60)
        return f"{minutes}分前"
    elif diff.total_seconds() < 86400:
        hours = int(diff.total_seconds() / 3600)
        return f"{hours}時間前"
    else:
        days = int(diff.total_seconds() / 86400)
        return f"{days}日前"

def fetch_rss(site):
    articles = []
    feed = feedparser.parse(site['url'])
    for entry in feed.entries[:30]: # 各サイト最大30件取得
        dt = None
        # RSSから日時を取得しJSTに変換
        for key in ['published_parsed', 'updated_parsed']:
            if hasattr(entry, key) and getattr(entry, key):
                dt = datetime.fromtimestamp(time.mktime(getattr(entry, key)))
                dt = dt.replace(tzinfo=timezone.utc).astimezone(JST)
                break
        
        articles.append({
            "site_name": site['name'],
            "title": entry.title,
            "link": entry.link,
            "published_at": dt,
            "time_ago": get_time_ago(dt)
        })
    return articles

def fetch_html(site):
    articles = []
    try:
        res = requests.get(site['url'], timeout=10)
        res.encoding = res.apparent_encoding
        soup = BeautifulSoup(res.text, 'html.parser')
        links = soup.select(site['selector'])
        seen = set()
        for a in links:
            title = a.get_text(strip=True)
            link = a.get('href')
            if not title or not link or len(title) < 5: continue
            
            link = urljoin(site['url'], link)
            if not link.startswith('http'): continue
            
            if link not in seen:
                seen.add(link)
                # HTMLスクレイピングの場合は正確な日時が取れないため便宜上Noneとする
                articles.append({
                    "site_name": site['name'],
                    "title": title,
                    "link": link,
                    "published_at": None,
                    "time_ago": ""
                })
            if len(articles) >= 30: break
    except Exception as e:
        print(f"Error fetching {site['url']}: {e}")
    return articles

def generate_html(all_data, top_articles):
    now = datetime.now(JST).strftime("%Y-%m-%d %H:%M:%S")
    
    html = f"""<!DOCTYPE html>
<html lang="ja">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
    <meta name="apple-mobile-web-app-capable" content="yes">
    <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
    <meta name="apple-mobile-web-app-title" content="MyNews">
    <title>MyNews</title>
    <style>
        :root {{ --bg: #f2f2f7; --card-bg: #ffffff; --text: #000000; --text-muted: #8e8e93; --primary: #007aff; }}
        * {{ box-sizing: border-box; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; margin: 0; padding: 0; background: var(--bg); overflow: hidden; }}
        
        /* タブバー */
        .tab-bar {{ display: flex; overflow-x: auto; white-space: nowrap; background: var(--card-bg); border-bottom: 1px solid #e5e5ea; position: fixed; top: 0; left: 0; right: 0; z-index: 100; scrollbar-width: none; padding-top: env(safe-area-inset-top); }}
        .tab-bar::-webkit-scrollbar {{ display: none; }}
        .tab {{ padding: 12px 16px; cursor: pointer; color: var(--text-muted); font-size: 15px; font-weight: bold; border-bottom: 3px solid transparent; transition: color 0.2s; }}
        .tab.active {{ color: var(--primary); border-bottom-color: var(--primary); }}
        
        /* スワイプエリア */
        .swipe-container {{ display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scroll-behavior: smooth; width: 100vw; height: 100vh; scrollbar-width: none; padding-top: calc(45px + env(safe-area-inset-top)); }}
        .swipe-container::-webkit-scrollbar {{ display: none; }}
        .swipe-item {{ width: 100vw; flex-shrink: 0; scroll-snap-align: start; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 15px; padding-bottom: calc(30px + env(safe-area-inset-bottom)); }}
        
        /* 記事デザイン */
        .article {{ background: var(--card-bg); border-radius: 12px; padding: 15px; margin-bottom: 12px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); }}
        .article a {{ text-decoration: none; color: var(--text); font-size: 15px; display: block; line-height: 1.4; font-weight: 500; margin-bottom: 8px; }}
        .article a:visited {{ color: #5856d6; }}
        .meta {{ display: flex; justify-content: space-between; align-items: center; font-size: 11px; color: var(--text-muted); }}
        .site-badge {{ background: #e5e5ea; padding: 3px 6px; border-radius: 4px; color: #333; }}
        
        .footer {{ text-align: center; color: var(--text-muted); font-size: 12px; margin-top: 20px; }}
    </style>
</head>
<body>
    <div class="tab-bar" id="tab-bar">
        <div class="tab active" data-target="tab-top">TOP</div>
"""
    # タブメニューの生成
    for idx, site in enumerate(all_data):
        html += f'<div class="tab" data-target="tab-{idx}">{site["name"]}</div>\n'
        
    html += f"""
    </div>
    <div class="swipe-container" id="swipe-container">
        <!-- TOP タブ -->
        <div class="swipe-item" id="tab-top">
"""
    # TOP記事の生成
    for art in top_articles:
        html += f"""
            <div class="article">
                <a href="{art['link']}" target="_blank">{art['title']}</a>
                <div class="meta">
                    <span class="site-badge">{art['site_name']}</span>
                    <span>{art['time_ago']}</span>
                </div>
            </div>"""
            
    html += '<div class="footer">最終更新: ' + now + '</div></div>\n'

    # 各サイト別タブの生成
    for idx, site in enumerate(all_data):
        html += f'<div class="swipe-item" id="tab-{idx}">\n'
        for art in site["articles"]:
            html += f"""
            <div class="article">
                <a href="{art['link']}" target="_blank">{art['title']}</a>
                <div class="meta">
                    <span></span>
                    <span>{art['time_ago']}</span>
                </div>
            </div>"""
        html += '<div class="footer">最終更新: ' + now + '</div></div>\n'
        
    html += """
    </div>
    
    <script>
        document.addEventListener('DOMContentLoaded', () => {
            const container = document.getElementById('swipe-container');
            const tabs = document.querySelectorAll('.tab');
            
            // タブクリック時の横スクロール移動
            tabs.forEach(tab => {
                tab.addEventListener('click', () => {
                    const targetId = tab.getAttribute('data-target');
                    const targetEl = document.getElementById(targetId);
                    container.scrollTo({ left: targetEl.offsetLeft, behavior: 'smooth' });
                });
            });

            // スワイプによるスクロール時のタブ同期（Intersection Observerを使用）
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const targetId = entry.target.id;
                        tabs.forEach(t => t.classList.remove('active'));
                        const activeTab = document.querySelector(`.tab[data-target="${targetId}"]`);
                        if(activeTab) {
                            activeTab.classList.add('active');
                            // タブバー自体も選択されたタブが見えるようにスクロール
                            activeTab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
                        }
                    }
                });
            }, { root: container, threshold: 0.5 }); // 画面の50%以上見えたらアクティブ判定

            document.querySelectorAll('.swipe-item').forEach(item => {
                observer.observe(item);
            });
        });
    </script>
</body>
</html>
"""
    return html

def main():
    # sites.jsonからサイトリストを読み込む
    with open('sites.json', 'r', encoding='utf-8') as f:
        sites = json.load(f)

    all_data = []
    all_articles_flat = []

    for site in sites:
        print(f"Fetching {site['name']}...")
        if site['type'] == 'rss':
            articles = fetch_rss(site)
        else:
            articles = fetch_html(site)
            
        all_data.append({"name": site["name"], "articles": articles})
        all_articles_flat.extend(articles)
    
    # TOPタブ用に全記事を日付順にソート（日時がないHTMLスクレイピング記事は最後に回す）
    # datetime.min を使うために timezone を付与
    min_time = datetime.min.replace(tzinfo=timezone.utc)
    top_articles = sorted(
        all_articles_flat,
        key=lambda x: x['published_at'] if x['published_at'] else min_time,
        reverse=True
    )[:30] # 横断TOPの上位30件
    
    html_content = generate_html(all_data, top_articles)
    
    with open("index.html", "w", encoding="utf-8") as f:
        f.write(html_content)
    print("index.html generated successfully.")

if __name__ == "__main__":
    main()
