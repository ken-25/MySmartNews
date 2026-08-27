"""実際のブラウザで表示と設定画面を確認する（手動実行）。

CIには入れていない。Playwright とブラウザが必要なため。

    pip install playwright && playwright install chromium
    python build.py
    python -m http.server 8765 -d dist &
    python tools/e2e_test.py

第1引数でURLを差し替えられる（既定 http://127.0.0.1:8765/index.html）。
"""
import os
import sys
import tempfile

from playwright.sync_api import sync_playwright

URL = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:8765/index.html'
SHOTS = os.environ.get('E2E_SCREENSHOT_DIR') or tempfile.mkdtemp(prefix='msn-e2e-')

fails = []


def check(condition, message):
    print(('✓ ' if condition else '✗ ') + message)
    if not condition:
        fails.append(message)


def run(page):
    page.goto(URL, wait_until='networkidle')

    # --- 初回はオンボーディングが出る ---
    check(page.is_visible('#settings'), '初回訪問で設定シートが開く')
    check('ようこそ' in page.inner_text('#settings-title'), 'ようこそ画面になっている')
    rows = page.locator('#settings-body .row').count()
    check(rows >= 3, f'カテゴリの一覧が出ている ({rows}行)')
    subscribed = page.evaluate("JSON.parse(localStorage.getItem('msn.v2')).packs")
    check(len(subscribed) >= 1, f'既定のカテゴリが選ばれている ({subscribed})')

    # --- 完了で本編へ ---
    page.click('#close-settings')
    page.wait_for_selector('.tab', timeout=5000)
    tabs = page.locator('.tab').all_inner_texts()
    check(tabs[0] == 'TOP', f'TOPタブが先頭にある ({tabs})')
    check(len(tabs) > 1, 'カテゴリタブが並んでいる')
    cards = page.locator('#tab-top .article').count()
    check(cards > 5, f'TOPに記事カードが並んでいる ({cards}件)')
    top_sites = page.locator('#tab-top .article .site-badge').all_inner_texts()[:10]
    check(len(set(top_sites)) >= 2,
          f'上位に複数サイトが混ざっている ({sorted(set(top_sites))})')

    # --- カテゴリを足すとタブが増える ---
    before = len(tabs)
    page.click('#open-settings')
    page.wait_for_selector('#settings-body .row')
    add = page.locator('#settings-body .row button', has_text='＋').first
    if add.count():
        add.click()
        page.click('#close-settings')
        page.wait_for_timeout(500)
        check(len(page.locator('.tab').all_inner_texts()) > before,
              '追加したカテゴリのタブが増えた')
    else:
        page.click('#close-settings')

    # --- ミュート ---
    page.click('#open-settings')
    page.wait_for_selector('#settings-body')
    checkbox = page.locator('#settings-body .row input[type=checkbox]').first
    muted_site = ''
    if checkbox.count():
        muted_site = checkbox.locator(
            'xpath=../div[@class="grow"]/div[@class="name"]').inner_text()
        checkbox.check()
    page.click('#close-settings')
    page.wait_for_timeout(500)
    if muted_site:
        remaining = page.locator('#tab-top .article .site-badge').all_inner_texts()
        check(muted_site not in remaining,
              f'ミュートしたサイト（{muted_site}）が一覧から消えた')

    page.screenshot(path=os.path.join(SHOTS, 'top.png'))

    # --- 再訪問で設定が復元される ---
    page.reload(wait_until='networkidle')
    check(not page.is_visible('#settings'), '2回目の訪問では設定シートが開かない')
    check(len(page.locator('.tab').all_inner_texts()) > 1,
          '購読したカテゴリが復元されている')


def main():
    errors = []
    with sync_playwright() as playwright:
        launch = {}
        bundled = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
        if os.path.exists(bundled):
            launch['executable_path'] = bundled
        browser = playwright.chromium.launch(**launch)
        page = browser.new_page(viewport={'width': 390, 'height': 844})
        page.on('pageerror', lambda exc: errors.append(str(exc)))
        try:
            run(page)
        finally:
            browser.close()

    # api/feed の 404 は Functions の有無を見るための意図的なリクエストなので、
    # ここではコンソールの404ではなく実行時エラーだけを見る。
    check(not errors, f'JavaScriptエラーが出ていない ({errors[:2]})')
    print(f'\nスクリーンショット: {SHOTS}')
    if fails:
        print(f'{len(fails)}件失敗')
        sys.exit(1)
    print('すべてのチェックに成功しました')


if __name__ == '__main__':
    main()
