/* 並べ替えの回帰テスト。
 *
 * スコアリングと多様性の担保はブラウザ側に移ったので、ここで検証する。
 * DOM は最小限のスタブで済ませ、app.js が公開する window.__msn を叩く。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function fakeElement() {
    const node = {
        style: {}, dataset: {}, hidden: false, textContent: '', className: '',
        children: [],
        classList: { add() {}, remove() {}, toggle() {} },
        addEventListener() {},
        appendChild(child) { node.children.push(child); return child; },
        removeChild() {},
        setAttribute() {},
        getAttribute() { return null; },
        querySelectorAll() { return []; },
        scrollTo() {},
        scrollIntoView() {}
    };
    return node;
}

function makeContext() {
    const store = {};
    const document = {
        getElementById() { return fakeElement(); },
        createElement() { return fakeElement(); }
    };
    const context = {
        document: document,
        window: {},
        localStorage: {
            getItem(key) { return key in store ? store[key] : null; },
            setItem(key, value) { store[key] = String(value); },
            removeItem(key) { delete store[key]; }
        },
        location: { hash: '', pathname: '/', search: '', origin: 'https://example.test' },
        history: { replaceState() {} },
        navigator: {},
        fetch() { return Promise.reject(new Error('network disabled in test')); },
        IntersectionObserver: function () { return { observe() {} }; },
        DOMParser: function () {},
        TextEncoder: TextEncoder,
        TextDecoder: TextDecoder,
        btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
        atob: (s) => Buffer.from(s, 'base64').toString('binary'),
        console: console
    };
    context.window = context;
    context.globalThis = context;
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(
        path.join(__dirname, '..', 'app.js'), 'utf8'), context);
    return context;
}

let failures = 0;
function check(condition, message) {
    if (condition) {
        console.log('✓ ' + message);
    } else {
        console.log('✗ ' + message);
        failures++;
    }
}

const HOUR = 3600000;

function article(overrides) {
    const now = Date.now();
    return Object.assign({
        title: '記事', link: 'https://example.com/a', key: 'https://example.com/a',
        site: 'サイト', source: 's', cluster: null,
        published_at: new Date(now - HOUR).toISOString(),
        dated: true, first_seen: new Date(now - HOUR).toISOString(),
        image: null, hatena: 0, hatena_delta: 0
    }, overrides);
}

function prolific(count) {
    const out = [];
    for (let i = 0; i < count; i++) {
        out.push(article({
            title: '多産サイトの記事' + i,
            link: 'https://prolific.example/' + i,
            key: 'https://prolific.example/' + i,
            site: '多産サイト',
            published_at: new Date(Date.now() - i * 3 * 60000).toISOString()
        }));
    }
    return out;
}

const msn = makeContext().__msn;

/* --- 多様性: 更新頻度の高いサイトが一覧を独占しない --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
let midsize = [];
for (let i = 0; i < 5; i++) {
    midsize.push(article({
        title: '中堅サイトの記事' + i, link: 'https://mid.example/' + i,
        key: 'https://mid.example/' + i, site: '中堅サイト',
        published_at: new Date(Date.now() - (i + 1) * HOUR).toISOString()
    }));
}
let pool = prolific(30).concat(midsize).concat([
    article({ title: '寡作サイトの記事', link: 'https://quiet.example/1',
              key: 'https://quiet.example/1', site: '寡作サイト',
              published_at: new Date(Date.now() - 5 * HOUR).toISOString() }),
    article({ title: '別サイトの記事', link: 'https://other.example/1',
              key: 'https://other.example/1', site: '別サイト',
              published_at: new Date(Date.now() - 4 * HOUR).toISOString() })
]);
let ranked = msn.rank(pool, 10);
let sites = new Set(ranked.map((a) => a.site));
check(sites.size >= 4, '上位10件が4サイト以上に分散している (内訳: '
    + Array.from(sites).join(', ') + ')');
check(ranked.filter((a) => a.site === '多産サイト').length <= 7,
    '上位10件を多産サイトが独占していない');

/* --- 興味キーワード --- */
msn.setSettings({ packs: [], muted: [], custom: [], affinity: {},
                  interests: [{ word: 'BIM', weight: 2.0 }] });
pool = prolific(20).concat([
    article({ title: 'BIM連携の新機能', link: 'https://quiet.example/bim',
              key: 'https://quiet.example/bim', site: '寡作サイト',
              published_at: new Date(Date.now() - 6 * HOUR).toISOString() })
]);
ranked = msn.rank(pool, 10);
check(ranked.some((a) => a.title === 'BIM連携の新機能'),
    '興味キーワードを含む古めの記事が上位に入る');
check(ranked.filter((a) => a.title === 'BIM連携の新機能')[0].matched[0] === 'BIM',
    'マッチした興味キーワードが記事に記録されている');

/* --- はてブの急上昇 --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
pool = prolific(20);
pool[10].hatena = 200;
pool[10].hatena_delta = 150;
ranked = msn.rank(pool, 10);
check(ranked[0].title === '多産サイトの記事10',
    '急上昇した記事が先頭に来る');

/* --- ミュート --- */
msn.setSettings({ packs: [], interests: [], custom: [], affinity: {},
                  muted: ['多産サイト'] });
ranked = msn.rank(prolific(20).concat([
    article({ title: '別サイトの記事', link: 'https://other.example/1',
              key: 'https://other.example/1', site: '別サイト' })
]), 10);
check(ranked.length === 1 && ranked[0].site === '別サイト',
    'ミュートしたサイトが一覧から消える');

/* --- よく読むサイトの学習 --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [],
                  affinity: { 'お気に入り': 50 } });
pool = [
    article({ title: '普通のサイトの記事', link: 'https://a.example/1',
              key: 'https://a.example/1', site: '普通のサイト' }),
    article({ title: 'お気に入りの記事', link: 'https://b.example/1',
              key: 'https://b.example/1', site: 'お気に入り',
              published_at: new Date(Date.now() - 3 * HOUR).toISOString() })
];
ranked = msn.rank(pool, 2);
check(ranked[0].site === 'お気に入り',
    'よく読むサイトの記事が押し上げられる');

/* --- 重複排除とクラスタのまとめ --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
const merged = msn.merge([
    [article({ key: 'https://a.example/1', title: 'A社の記事', site: 'A', cluster: 'c1', hatena: 5 }),
     article({ key: 'https://b.example/1', title: 'B社の記事', site: 'B', cluster: 'c1', hatena: 40 })],
    [article({ key: 'https://a.example/1', title: 'A社の記事', site: 'A', cluster: 'c1', hatena: 9 }),
     article({ key: 'https://c.example/1', title: '別の話題', site: 'C', cluster: 'c2' })]
]);
check(merged.length === 2, '同じ話題が1件にまとめられる (' + merged.length + '件)');
const leader = merged.filter((a) => a.cluster === 'c1')[0];
check(leader.also === 1, 'まとめた件数が記録されている (他' + leader.also + '件)');
check(leader.hatena === 40, 'クラスタ内で一番ブックマークの多い数を引き継ぐ');

if (failures) {
    console.log('\n' + failures + '件のチェックに失敗しました');
    process.exit(1);
}
console.log('\nすべてのチェックに成功しました');
