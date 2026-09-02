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
        insertBefore(child) { node.children.push(child); return child; },
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
        setTimeout: setTimeout,
        clearTimeout: clearTimeout,
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
        site: 'サイト', source: 's', cluster: null, tier: 'media', reach: 1,
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
check(leader.dupes.length === 1,
    'まとめた記事を捨てずに持っている (他' + leader.dupes.length + '件)');
check(leader.dupes[0].link, 'まとめた記事のリンクが残っている');
check(leader.hatena === 40, 'クラスタ内で一番ブックマークの多い数を引き継ぐ');

/* --- 同じ話題を開いて他社の記事を読む --- */
const topic = article({
    key: 'https://lead.example/1', title: '代表記事', site: '通信社', cluster: 'c9'
});
topic.dupes = [
    article({ key: 'https://x.example/1', title: 'X社の記事', site: 'X' }),
    article({ key: 'https://y.example/1', title: 'Y社の記事', site: 'Y' }),
    article({ key: 'https://x.example/2', title: 'X社の続報', site: 'X' }),
    article({ key: 'https://lead.example/2', title: '代表と同じ媒体', site: '通信社' }),
    article({ key: 'https://z.example/1', title: 'Z社の記事', site: 'Z' })
];
let folded = msn.foldedArticles(topic);
check(folded.length === 3,
    '同じ媒体の2件目と代表自身の媒体は畳んだ一覧に出さない (' + folded.length + '件)');
check(msn.foldedLabel(folded) === 'X・Y ほか1媒体 も報じています',
    '件数ではなく媒体名で「他にどこが報じたか」を示す (' + msn.foldedLabel(folded) + ')');
check(msn.foldedLabel(folded.slice(0, 2)) === 'X・Y も報じています',
    '2媒体までは名前だけを並べる');
msn.setSettings({ packs: [], interests: [], muted: ['X'], custom: [], affinity: {} });
folded = msn.foldedArticles(topic);
check(folded.every((a) => a.site !== 'X'),
    'ミュートしたサイトは畳んだ一覧にも出てこない');
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });

/* --- TOP: 重要度の判定にはてブ数を使わない --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
const blog = article({
    title: '個人ブログの長文エッセイ', link: 'https://blog.example/1',
    key: 'https://blog.example/1', site: 'はてブ 総合', tier: 'social',
    reach: 1, hatena: 900, hatena_delta: 400, cluster: 'b1'
});
const bigNews = [];
for (let i = 0; i < 4; i++) {
    bigNews.push(article({
        title: '大きなニュース（' + i + '社目の見出し）',
        link: 'https://media' + i + '.example/1',
        key: 'https://media' + i + '.example/1',
        site: '媒体' + i, tier: i === 0 ? 'wire' : 'media', reach: 4,
        cluster: 'n1', hatena: 3,
        published_at: new Date(Date.now() - 5 * HOUR).toISOString()
    }));
}
let top = msn.buildTop(msn.merge([bigNews.concat([blog]).concat(prolific(20))]), 20);
check(top[0].cluster === 'n1',
    '4媒体が報じたニュースが、はてブ900の個人ブログより先頭に来る (' + top[0].title + ')');
check(top[0].lane === 'big', '先頭の記事が「主要」レーンから選ばれている');
check(top.filter((a) => a.cluster === 'n1').length === 1,
    '同じ話題は代表1件にまとまっている');
check(new Set(top.slice(0, 6).map((a) => a.lane)).size >= 2,
    '上位が1種類のレーンで固まらず混ざっている ('
    + top.slice(0, 6).map((a) => a.lane).join(',') + ')');

/* --- TOP: 話題は載るが、重要度としては扱われない --- */
check(top.some((a) => a.key === blog.key), 'はてブで伸びた記事もTOPには載る');
check(top.filter((a) => a.key === blog.key)[0].lane !== 'big',
    'はてブで伸びただけの記事は「主要」レーンに入らない');

/* --- 既読の記事は次に開いたとき下がる --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {},
                  seen: { 'https://prolific.example/0': Date.now() } });
pool = prolific(20);
ranked = msn.rank(pool, 5);
check(ranked[0].key !== 'https://prolific.example/0',
    '一度見た記事が最新でも先頭から外れる');

/* --- 見出しの切り出し --- */
/* 形態素解析器を積まないぶん、漢字の連なりの端で語でない語ができる。
 * 前後1文字を見て落とすところを、実際に出てきた事故で押さえる。 */
function words(title) { return msn.candidateWords(title); }
check(words('無痛分娩で第2児出産を報告').indexOf('児出産') === -1
    && words('無痛分娩で第2児出産を報告').indexOf('出産') !== -1,
    '数字の後ろの助数詞を語の頭に残さない (' + words('無痛分娩で第2児出産を報告').join(', ') + ')');
check(words('年収が1.5倍違う理由').indexOf('倍違') === -1,
    '送り仮名の付く動詞の語幹を語として拾わない ('
    + words('年収が1.5倍違う理由').join(', ') + ')');
check(words('日経平均が値上げ局面に').indexOf('値上') === -1,
    '送り仮名で切れた「値上」を拾わない');
check(words('生成AIの新モデルを発表').indexOf('生成ai') !== -1,
    '隙間なく続く2語の連結も候補にする (' + words('生成AIの新モデルを発表').join(', ') + ')');
check(words('大林組がBIMで検討').indexOf('bim') !== -1,
    '英字の略語を小文字にして拾う');
check(words('この記事はofとtoを含む').indexOf('of') === -1,
    '小文字2文字の英単語は拾わない');
check(words('経済産業省総合資源調査会が開催').indexOf('経済産業省総合資源調査会') === -1,
    '長すぎる漢字の連なりは語に切れないので捨てる');

/* --- クリックした記事から話題を学習する --- */
/* 見出しの母集団。「提供開始」はどの見出しにも出るが、「revit」は数本だけ。 */
const corpus = [];
for (let i = 0; i < 200; i++) {
    corpus.push(article({
        key: 'https://corpus.example/' + i, link: 'https://corpus.example/' + i,
        site: 'ITmedia ビジネスオンライン',
        title: i % 3 === 0 ? ('新サービスの提供開始を発表' + i)
            : (i % 41 === 0 ? ('Revitで施工図を描く' + i) : ('雑多な見出し' + i + 'について'))
    }));
}
msn.setCorpus({ corpus: corpus });

msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
msn.learnFrom({ key: 'https://x.example/1', site: '寡作サイト',
                title: 'Revitのアドインで施工図を自動生成する' });
check(Object.keys(msn.getSettings().topics).length === 0,
    '1つの記事にしか出ていない語はまだ覚えない');
check(Object.keys(msn.getSettings().candidates).indexOf('revit') !== -1,
    '拾った語は様子見の候補に入る ('
    + Object.keys(msn.getSettings().candidates).join(', ') + ')');

msn.learnFrom({ key: 'https://x.example/2', site: '寡作サイト',
                title: 'Revitの新しい使い方' });
const topics = Object.keys(msn.getSettings().topics);
check(topics.indexOf('revit') !== -1,
    '別の記事で2回目が出た語を覚える (' + topics.join(', ') + ')');

msn.learnFrom({ key: 'https://x.example/2', site: '寡作サイト',
                title: 'Revitの新しい使い方' });
check(Object.keys(msn.getSettings().topics).length === topics.length,
    '同じ記事を開き直しても2回目の証拠にはしない');

pool = prolific(20).concat([
    article({ title: 'Revitの新しい使い方（続報）', link: 'https://quiet.example/revit',
              key: 'https://quiet.example/revit', site: '寡作サイト',
              published_at: new Date(Date.now() - 6 * HOUR).toISOString() })
]);
top = msn.buildTop(pool, 10);
const recommended = top.filter((a) => a.key === 'https://quiet.example/revit')[0];
check(recommended && recommended.lane === 'you',
    'キーワードを1つも設定していなくても、学習した話題がおすすめに載る');

/* --- ありふれた語と媒体名は覚えない --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
for (let i = 0; i < 2; i++) {
    msn.learnFrom({ key: 'https://y.example/' + i, site: 'ITmedia ビジネスオンライン',
                    title: 'テスラの新型を試す（ITmedia ビジネスオンライン）と提供開始' + i });
}
const learned = Object.keys(msn.getSettings().topics);
check(learned.indexOf('提供開始') === -1,
    '見出し全体によく出る語は、2回出ても覚えない (' + learned.join(', ') + ')');
check(learned.indexOf('itmedia') === -1 && learned.indexOf('ビジネスオンライン') === -1,
    '見出しに紛れ込んだ媒体名を話題として覚えない');
check(learned.indexOf('テスラ') !== -1, 'ありふれていない語は覚える');

/* --- 似た語を二重に覚えない --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {},
                  topics: { 'revit': 1.0 } });
msn.learnFrom({ key: 'https://z.example/1', site: '寡作サイト',
                title: 'Revitのアドインが更新' });
const dup = Object.keys(msn.getSettings().topics).filter((w) => w.indexOf('revit') !== -1);
check(dup.length === 1,
    '同じものを指す語をまとめて1語で持つ (' + dup.join(', ') + ')');
check(msn.getSettings().topics.revit > 1.0,
    'まとめた語の重みが育っている');

msn.setCorpus({});

/* --- ソースの性質でTOPの重みが変わる --- */
msn.setSettings({ packs: [], interests: [], muted: [], custom: [], affinity: {} });
const same = { published_at: new Date(Date.now() - HOUR).toISOString(), reach: 1 };
ranked = msn.rank([
    article(Object.assign({ title: '通信社の記事', link: 'https://w.example/1',
                            key: 'https://w.example/1', site: '通信社',
                            tier: 'wire' }, same)),
    article(Object.assign({ title: 'ソーシャル経由の記事', link: 'https://s.example/1',
                            key: 'https://s.example/1', site: 'ソーシャル',
                            tier: 'social', hatena: 200 }, same))
], 2);
check(ranked[0].tier === 'wire',
    'はてブ200件のソーシャル経由より、通信社の記事が上に来る');

if (failures) {
    console.log('\n' + failures + '件のチェックに失敗しました');
    process.exit(1);
}
console.log('\nすべてのチェックに成功しました');
