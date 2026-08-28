/* MySmartNews フロントエンド
 *
 * dist/index.json（パックのカタログ）と dist/p/<pack>.json（記事）を読み、
 * **並び順はこのファイルが決める**。ビルド側は誰にとっても同じ客観的な信号
 * （公開時刻・初回発見時刻・はてブ数と増分・何媒体が報じたか・ソースの性質）
 * しか持たせていないので、ユーザーごとの好みは全部ここと localStorage の中で
 * 完結する。
 *
 * TOPの考え方:
 *   はてなブックマーク数は「ネットで語りたくなる度」であって「重要度」ではない。
 *   ブックマークだけを見て並べると、他社が誰も追随していない個人の意見記事が
 *   構造的に上に来てしまう。そこで重要度の判定には **同じ話題を何媒体が報じたか**
 *   （reach）を使い、はてブ数は話題度の弱い信号に降格させている。
 *   そのうえで「主要ニュース / あなた向け / 新着」を見出しで区切らず、
 *   決まった比率で織り交ぜた1本のリストにして、下に行くほど在庫を継ぎ足す。
 *
 * 記事タイトルは textContent で差し込むため、< や & が含まれていても壊れない。
 */
(function () {
    'use strict';

    /* ---------------- チューニング定数 ---------------- */

    /* TOPは3種類の記事を混ぜて1本のリストにする。見出しで区切らないぶん、
     * どの種類をどれだけ供給するかはこのパターンの繰り返しで決まる。
     *   big … 誰もが知るべきニュース（何媒体が報じたかで判定）
     *   you … 興味キーワードとクリック履歴から選ぶレコメンド
     *   new … 購読しているソースの新着
     * 先頭が big なので、大きなニュースがあれば開いた瞬間に見える。
     * 尽きたレーンの順番は残りのレーンが埋めるので、たとえば興味キーワードを
     * 1つも設定していない人のTOPは新着が中心になる。 */
    var MIX_PATTERN = ['big', 'you', 'new', 'you', 'new'];
    // TOPの上限に対して、各レーンが何件まで在庫を用意するか
    var LANE_SHARE = { big: 0.25, you: 0.40, 'new': 1.0 };

    var HALF_LIFE_HOURS = 8.0;      // 鮮度の半減期
    var BIG_HALF_LIFE_HOURS = 20.0; // 大きなニュースは半日過ぎても落とさない
    var DIVERSITY_DECAY = 0.6;      // 同一サイトが1件増えるごとに掛かる係数
    var TOPIC_DECAY = 0.45;         // 同じ話題が1件増えるごとに掛かる係数
    var POPULARITY_WEIGHT = 0.25;   // はてブ累計数の効き（話題度の弱い信号）
    var VELOCITY_WEIGHT = 0.6;      // はてブ増加数（急上昇）の効き
    var AFFINITY_WEIGHT = 0.5;      // よく読むサイトの効き
    var REACH_WEIGHT = 2.2;         // 何媒体が報じたかの効き
    var BIG_MIN_REACH = 3;          // 「主要」として扱う最低媒体数
    var SEEN_PENALTY = 0.25;        // 一度一覧に出した記事に掛かる係数
    var SEEN_LIMIT = 600;           // 既読として覚えておく件数
    var LEARN_WEIGHT = 0.8;         // 学習した語の効き（手入力より控えめ）
    var LEARN_LIMIT = 40;           // 自動で学習する語の上限
    var LEARN_DECAY = 0.93;         // 古い興味が薄れる速さ
    var LEARN_MAX = 3.0;            // 1語あたりの重みの上限
    var LEARN_FLOOR = 0.35;         // これを下回った語は忘れる
    /* ソースの性質ごとの信頼度。はてブのランキング経由（social）を低く置くのが
     * 「癖の強い個人ブログがTOPを占める」に対する直接の効き手になる。
     * ランキングそのものは「話題」タブに残るので、見たい人は見られる。 */
    var TIER_AUTHORITY = { wire: 1.35, media: 1.0, search: 0.85, social: 0.55 };
    var HOT_THRESHOLD = 30;        // バッジを出す累計ブックマーク数
    var RISING_THRESHOLD = 10;     // 急上昇と見なす増分
    var NEW_WINDOW_HOURS = 3;      // NEW バッジを出す初回発見からの時間
    var PAGE_SIZE = 20;            // 一度に描き足す件数（無限スクロール）
    var TOP_LIMIT = 200;
    var PACK_LIMIT = 200;
    var STORAGE_KEY = 'msn.v2';
    /* 配信時に build.py が実際のビルドIDへ書き換える行（この形のまま置換される）。
     * index.json 側の app_build と突き合わせて、ブラウザが古い app.js を
     * キャッシュしたまま動いていないかを設定画面で確認できるようにする。 */
    var APP_BUILD = 'dev';
    var WEIGHTS = [
        { label: '弱', value: 0.6 },
        { label: '中', value: 1.2 },
        { label: '強', value: 2.0 }
    ];
    /* 学習語から外す、どの記事にも出てくる語。 */
    var STOP_WORDS = ['ニュース', '記事', '速報', '発表', '日本', '一覧', '写真',
                      '動画', '公開', '情報', '開始', '東京', '最新', 'まとめ',
                      '可能性', '理由', '方法', '本当', '完全', '徹底'];
    /* カタカナ語・英単語・漢字熟語だけを拾う簡易トークナイザ。
     * 形態素解析器を積まずに「クリックした記事の話題」を近似する。 */
    var TOKEN_RE = /[\u30a1-\u30f6\u30fc]{3,}|[A-Za-z][A-Za-z0-9.+#-]{2,}|[\u4e00-\u9fff\u3005]{2,5}/g;

    var tabBar = document.getElementById('tab-bar');
    var container = document.getElementById('swipe-container');
    var sheet = document.getElementById('settings');
    var sheetBody = document.getElementById('settings-body');

    var catalog = null;      // index.json
    var packData = {};       // pack_id -> 記事配列
    var apiAvailable = null; // Pages Functions が使えるか（null は未判定）

    /* ---------------- 設定の保存 ---------------- */

    function defaultSettings() {
        return {
            v: 2, onboarded: false, packs: [], interests: [],
            muted: [], custom: [], affinity: {}, topics: {}, seen: {}
        };
    }

    function sanitize(raw) {
        var base = defaultSettings();
        if (!raw || typeof raw !== 'object') { return base; }
        if (Array.isArray(raw.packs)) {
            base.packs = raw.packs.filter(function (id) { return typeof id === 'string'; });
        }
        if (Array.isArray(raw.interests)) {
            raw.interests.forEach(function (item) {
                if (item && typeof item.word === 'string' && item.word) {
                    base.interests.push({
                        word: item.word,
                        weight: typeof item.weight === 'number' ? item.weight : 1.2
                    });
                }
            });
        }
        if (Array.isArray(raw.muted)) {
            base.muted = raw.muted.filter(function (s) { return typeof s === 'string'; });
        }
        if (Array.isArray(raw.custom)) {
            raw.custom.forEach(function (item) {
                if (item && (item.type === 'feed' || item.type === 'query')
                        && typeof item.value === 'string' && item.value) {
                    base.custom.push({
                        id: item.id || ('c' + Math.random().toString(36).slice(2, 9)),
                        name: String(item.name || item.value).slice(0, 40),
                        type: item.type,
                        value: item.value
                    });
                }
            });
        }
        if (raw.affinity && typeof raw.affinity === 'object') {
            Object.keys(raw.affinity).forEach(function (site) {
                var n = Number(raw.affinity[site]);
                if (n > 0) { base.affinity[site] = Math.min(n, 999); }
            });
        }
        if (raw.topics && typeof raw.topics === 'object') {
            Object.keys(raw.topics).forEach(function (word) {
                var n = Number(raw.topics[word]);
                if (word && n > 0) { base.topics[word] = Math.min(n, LEARN_MAX); }
            });
        }
        if (raw.seen && typeof raw.seen === 'object') {
            Object.keys(raw.seen).forEach(function (key) {
                var at = Number(raw.seen[key]);
                if (key && at > 0) { base.seen[key] = at; }
            });
        }
        base.onboarded = !!raw.onboarded;
        return base;
    }

    var settings = defaultSettings();

    function loadSettings() {
        try {
            settings = sanitize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
        } catch (err) {
            settings = defaultSettings();
        }
    }

    function saveSettings() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (err) {
            /* プライベートブラウジングなどで書けなくても表示は続ける */
        }
    }

    function encodeSettings() {
        var json = JSON.stringify({
            packs: settings.packs, interests: settings.interests,
            muted: settings.muted, custom: settings.custom,
            topics: settings.topics, onboarded: true
        });
        var bytes = new TextEncoder().encode(json);
        var binary = '';
        bytes.forEach(function (b) { binary += String.fromCharCode(b); });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    function decodeSettings(code) {
        var binary = atob(code.replace(/-/g, '+').replace(/_/g, '/'));
        var bytes = new Uint8Array(binary.length);
        for (var i = 0; i < binary.length; i++) { bytes[i] = binary.charCodeAt(i); }
        return JSON.parse(new TextDecoder().decode(bytes));
    }

    /* ---------------- 取得 ---------------- */

    function getJSON(url) {
        return fetch(url, { cache: 'no-cache' }).then(function (res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status + ' ' + url); }
            return res.json();
        });
    }

    function packMeta(id) {
        var found = null;
        (catalog.packs || []).forEach(function (pack) {
            if (pack.id === id) { found = pack; }
        });
        return found;
    }

    function subscribedPacks() {
        return settings.packs.map(packMeta).filter(Boolean);
    }

    function loadPack(id) {
        if (packData[id]) { return Promise.resolve(packData[id]); }
        return getJSON('p/' + encodeURIComponent(id) + '.json').then(function (data) {
            packData[id] = data.articles || [];
            return packData[id];
        }).catch(function () {
            packData[id] = [];
            return packData[id];
        });
    }

    /* カスタムソースは Cloudflare Pages Functions のプロキシ越しに取る。
     * 静的配信だけの環境（GitHub Pages など）では 404 になるので、
     * その場合は機能ごと隠す。 */
    function apiURL(source) {
        return source.type === 'query'
            ? 'api/search?q=' + encodeURIComponent(source.value)
            : 'api/feed?url=' + encodeURIComponent(source.value);
    }

    function probeAPI() {
        if (apiAvailable !== null) { return Promise.resolve(apiAvailable); }
        return fetch('api/feed').then(function (res) {
            // 引数なしは 400 を返す実装。404 ならそもそも Functions がいない。
            apiAvailable = res.status !== 404;
            return apiAvailable;
        }).catch(function () {
            apiAvailable = false;
            return false;
        });
    }

    function textOf(node, tag) {
        var found = node.getElementsByTagName(tag)[0];
        return found ? (found.textContent || '').trim() : '';
    }

    function linkOf(node) {
        var links = node.getElementsByTagName('link');
        for (var i = 0; i < links.length; i++) {
            var href = links[i].getAttribute('href') || links[i].textContent;
            if (href && /^https?:\/\//i.test(href.trim())) { return href.trim(); }
        }
        return '';
    }

    function parseFeed(xmlText, source) {
        var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        if (doc.getElementsByTagName('parsererror').length) { return []; }
        var nodes = doc.getElementsByTagName('item');
        if (!nodes.length) { nodes = doc.getElementsByTagName('entry'); }
        var out = [];
        var nowISO = new Date().toISOString();
        for (var i = 0; i < nodes.length && out.length < 30; i++) {
            var node = nodes[i];
            var title = textOf(node, 'title');
            var link = linkOf(node);
            if (!title || !link) { continue; }
            var raw = textOf(node, 'pubDate') || textOf(node, 'published')
                || textOf(node, 'updated') || textOf(node, 'date');
            var published = raw ? new Date(raw) : null;
            var site = source.name;
            var meta = node.getElementsByTagName('source')[0];
            if (meta && meta.textContent) {
                site = meta.textContent.trim();
                if (title.slice(-(site.length + 3)) === ' - ' + site) {
                    title = title.slice(0, -(site.length + 3)).trim();
                }
            }
            out.push({
                title: title, link: link, key: link, site: site,
                source: source.id, cluster: null,
                published_at: (published && !isNaN(published)) ? published.toISOString() : nowISO,
                dated: !!(published && !isNaN(published)),
                first_seen: nowISO, image: null, hatena: 0, hatena_delta: 0,
                custom: true
            });
        }
        return out;
    }

    function loadCustom(source) {
        return fetch(apiURL(source)).then(function (res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.text();
        }).then(function (text) {
            return parseFeed(text, source);
        }).catch(function () {
            return [];
        });
    }

    /* ---------------- 既読と学習 ---------------- */

    var saveTimer = null;

    function saveSoon() {
        if (saveTimer) { return; }
        saveTimer = setTimeout(function () {
            saveTimer = null;
            saveSettings();
        }, 1500);
    }

    /* 一覧に出した記事を覚えておく。次に開いたときスコアを大きく下げるので、
     * 見るたびに同じ顔ぶれが並ぶことがなくなる。端末の中だけの記録。 */
    function remember(article) {
        if (settings.seen[article.key]) { return; }
        settings.seen[article.key] = Date.now();
        var keys = Object.keys(settings.seen);
        if (keys.length > SEEN_LIMIT) {
            keys.sort(function (a, b) { return settings.seen[b] - settings.seen[a]; });
            var kept = {};
            keys.slice(0, SEEN_LIMIT).forEach(function (key) {
                kept[key] = settings.seen[key];
            });
            settings.seen = kept;
        }
        saveSoon();
    }

    function tokenize(title) {
        var text = title.normalize ? title.normalize('NFKC') : title;
        return (text.match(TOKEN_RE) || []).filter(function (word) {
            return STOP_WORDS.indexOf(word) === -1;
        });
    }

    /* 開いた記事のタイトルから話題の語を拾って重みを育てる。
     * 興味キーワードを1つも設定していない人にもレコメンドが効くようにするため。
     * 古い語は開くたびに少しずつ薄れるので、興味が変われば入れ替わる。 */
    function learnFrom(title) {
        Object.keys(settings.topics).forEach(function (word) {
            settings.topics[word] *= LEARN_DECAY;
            if (settings.topics[word] < LEARN_FLOOR) { delete settings.topics[word]; }
        });
        tokenize(title).slice(0, 3).forEach(function (word) {
            var key = word.toLowerCase();
            settings.topics[key] = Math.min(
                (settings.topics[key] || LEARN_FLOOR) + 0.6, LEARN_MAX);
        });
        var words = Object.keys(settings.topics);
        if (words.length > LEARN_LIMIT) {
            words.sort(function (a, b) { return settings.topics[b] - settings.topics[a]; });
            var kept = {};
            words.slice(0, LEARN_LIMIT).forEach(function (word) {
                kept[word] = settings.topics[word];
            });
            settings.topics = kept;
        }
    }

    /* ---------------- スコアリング ---------------- */

    function matchInterests(title) {
        var lowered = title.toLowerCase();
        return settings.interests.filter(function (interest) {
            return lowered.indexOf(interest.word.toLowerCase()) !== -1;
        });
    }

    function matchTopics(title) {
        var lowered = title.toLowerCase();
        var hits = [];
        Object.keys(settings.topics).forEach(function (word) {
            if (lowered.indexOf(word) !== -1) {
                hits.push({ word: word, weight: settings.topics[word] * LEARN_WEIGHT });
            }
        });
        return hits;
    }

    function authority(article) {
        var value = TIER_AUTHORITY[article.tier];
        return typeof value === 'number' ? value : 1.0;
    }

    function decay(article, now, halfLife) {
        var at = Date.parse(article.published_at) || now;
        var ageHours = Math.max((now - at) / 3600000, 0);
        return Math.pow(0.5, ageHours / halfLife);
    }

    /* 3つのレーンぶんのスコアをまとめて付ける。
     *
     * bigScore … 誰もが知るべきニュースか。判定に使うのは「何媒体が報じたか」
     *   だけで、はてブ数は入れない。個人ブログがどれだけブックマークされても、
     *   他社が同じ話題を報じない限り reach は 1 のままになる。
     * youScore … 手で設定した興味キーワードと、クリックから学習した語。
     *   どちらにも当たらない記事は 0 のままで、このレーンには載らない。
     * newScore … 購読ソースの新着。はてブ数はここで弱い後押しとしてだけ効く。
     */
    function score(article, now) {
        // 記事オブジェクトはタブ間で使い回されるので、前回のレーンを引きずらせない
        article.lane = null;
        var seen = settings.seen[article.key] ? SEEN_PENALTY : 1.0;
        var auth = authority(article);
        var clicks = settings.affinity[article.site] || 0;
        var affinity = 1.0 + AFFINITY_WEIGHT * Math.log10(1 + clicks);
        var hatena = article.hatena || 0;
        var delta = Math.max(article.hatena_delta || 0, 0);
        var buzz = 1.0
            + POPULARITY_WEIGHT * Math.log10(1 + hatena)
            + VELOCITY_WEIGHT * Math.log10(1 + delta);
        var reach = Math.max(article.reach || 1, 1);

        var explicit = matchInterests(article.title);
        var learned = matchTopics(article.title);
        article.matched = explicit.map(function (h) { return h.word; });
        article.learned = learned.map(function (h) { return h.word; });
        var interest = 1.0;
        explicit.concat(learned).forEach(function (h) { interest += h.weight; });

        article.bigScore = reach < BIG_MIN_REACH ? 0
            : decay(article, now, BIG_HALF_LIFE_HOURS) * auth * seen
                * (1 + REACH_WEIGHT * Math.log2(reach));

        var fresh = decay(article, now, HALF_LIFE_HOURS);
        article.youScore = (explicit.length || learned.length)
            ? fresh * interest * affinity * auth * seen : 0;
        article.newScore = fresh * affinity * auth * buzz * seen;

        // カテゴリ別タブは1本のスコアで並べる（TOPのように混ぜる相手がいない）
        article.score = fresh * interest * affinity * auth * buzz * seen
            * (1 + 0.35 * Math.log2(reach));
        return article.score;
    }

    /* スコア順に選びつつ、同じサイト・同じ話題が続くほど割り引く（貪欲MMR）。
     * 純粋なスコア順だと更新頻度の高いサイトと1つの大事件が一覧を独占する。
     * taken を渡すと、他のレーンが既に取った記事を避ける。 */
    function pickDiverse(articles, limit, field, taken) {
        var key = field || 'score';
        var pool = articles.filter(function (article) {
            return article[key] > 0 && !(taken && taken[article.key]);
        }).sort(function (a, b) { return b[key] - a[key]; });
        var chosen = [];
        var sites = {};
        var topics = {};
        while (pool.length && chosen.length < limit) {
            var bestIndex = 0;
            var bestValue = -1;
            for (var i = 0; i < pool.length; i++) {
                var repeats = sites[pool[i].site] || 0;
                var sameTopic = pool[i].cluster ? (topics[pool[i].cluster] || 0) : 0;
                var value = pool[i][key] * Math.pow(DIVERSITY_DECAY, repeats)
                    * Math.pow(TOPIC_DECAY, sameTopic);
                if (value > bestValue) { bestIndex = i; bestValue = value; }
            }
            var picked = pool.splice(bestIndex, 1)[0];
            sites[picked.site] = (sites[picked.site] || 0) + 1;
            if (picked.cluster) {
                topics[picked.cluster] = (topics[picked.cluster] || 0) + 1;
            }
            if (taken) { taken[picked.key] = true; }
            chosen.push(picked);
        }
        return chosen;
    }

    /* 同じ記事（URL）と同じ話題（クラスタ）をまとめる。
     * クラスタは代表1件だけ残し、まとめた件数を持たせる。 */
    function merge(lists) {
        var byKey = {};
        lists.forEach(function (list) {
            list.forEach(function (article) {
                var existing = byKey[article.key];
                if (!existing) { byKey[article.key] = article; return; }
                // 同じ記事が複数のソースから来たら、信頼できるソース経由の
                // ほうを代表にする（同格ならブックマークの多いほう）。
                var better = authority(article) - authority(existing)
                    || (article.hatena || 0) - (existing.hatena || 0);
                if (better > 0) { byKey[article.key] = article; }
            });
        });

        var byCluster = {};
        var out = [];
        Object.keys(byKey).forEach(function (key) {
            var article = byKey[key];
            if (!article.cluster) { out.push(article); return; }
            var leader = byCluster[article.cluster];
            if (!leader) {
                article.also = 0;
                byCluster[article.cluster] = article;
                out.push(article);
                return;
            }
            leader.also = (leader.also || 0) + 1;
            // 画像やはてブ数を持っているほうを代表にする
            if (!leader.image && article.image) { leader.image = article.image; }
            if ((article.hatena || 0) > (leader.hatena || 0)) {
                leader.hatena = article.hatena;
                leader.hatena_delta = article.hatena_delta;
            }
        });
        return out;
    }

    function visible(articles) {
        if (!settings.muted.length) { return articles; }
        return articles.filter(function (a) {
            return settings.muted.indexOf(a.site) === -1;
        });
    }

    function rank(articles, limit) {
        var now = Date.now();
        var pool = visible(articles);
        pool.forEach(function (article) { score(article, now); });
        return pickDiverse(pool, limit);
    }

    /* 3つのレーンを見出しなしで1本に織り込む。
     * ランダムに混ぜると同じ種類が固まるので、決めた比率のパターンで回す。
     * 尽きたレーンの順番は、残っているレーンが埋める。 */
    function interleave(lanes) {
        var names = Object.keys(lanes);
        var cursor = {};
        var total = 0;
        names.forEach(function (name) {
            cursor[name] = 0;
            total += lanes[name].length;
        });

        var out = [];
        var step = 0;
        while (out.length < total) {
            var filled = false;
            for (var i = 0; i < MIX_PATTERN.length && !filled; i++) {
                var name = MIX_PATTERN[(step + i) % MIX_PATTERN.length];
                if (lanes[name] && cursor[name] < lanes[name].length) {
                    out.push(lanes[name][cursor[name]++]);
                    filled = true;
                }
            }
            step++;
            if (!filled) { break; }
        }
        return out;
    }

    /* TOPの中身。種類ごとにセクションへ切り分けるのではなく、混ぜて1本にする。 */
    function buildTop(articles, limit, taken) {
        var now = Date.now();
        var pool = visible(articles);
        pool.forEach(function (article) { score(article, now); });

        var used = taken || Object.create(null);
        var lanes = {
            big: pickDiverse(pool, Math.ceil(limit * LANE_SHARE.big), 'bigScore', used),
            you: pickDiverse(pool, Math.ceil(limit * LANE_SHARE.you), 'youScore', used),
            "new": pickDiverse(pool, Math.ceil(limit * LANE_SHARE['new']),
                               'newScore', used)
        };
        Object.keys(lanes).forEach(function (name) {
            lanes[name].forEach(function (article) { article.lane = name; });
        });
        return interleave(lanes).slice(0, limit);
    }

    /* どの記事がどのレーンから来たかを、記事オブジェクトの外に控える。
     * article.lane は次にスコアを計算し直した時点で消える（カテゴリ別タブの
     * 並べ替えが同じオブジェクトを触る）ので、描くときまで持たない。 */
    function laneMap(articles) {
        var map = Object.create(null);
        articles.forEach(function (article) {
            if (article.lane) { map[article.key] = article.lane; }
        });
        return map;
    }

    /* ---------------- 描画 ---------------- */

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined && text !== null) { node.textContent = text; }
        return node;
    }

    function safeLink(url) {
        return /^https?:\/\//i.test(url || '') ? url : '#';
    }

    function timeAgo(article, now) {
        var at = Date.parse(article.published_at);
        if (!at) { return ''; }
        var seconds = Math.max((now - at) / 1000, 0);
        if (seconds < 3600) { return Math.floor(seconds / 60) + '分前'; }
        if (seconds < 86400) { return Math.floor(seconds / 3600) + '時間前'; }
        return Math.floor(seconds / 86400) + '日前';
    }

    /* TOPはセクション見出しで区切らないので、その代わりにカードの中の
     * 小さなラベルで「なぜこれが出ているのか」だけを伝える。 */
    function laneLabel(article, lane) {
        if (lane === 'big') { return '主要'; }
        if (lane === 'you') {
            var words = (article.matched || []).concat(article.learned || []);
            return words.length ? words[0] : 'あなた向け';
        }
        return null;
    }

    function buildMeta(article, now, lane) {
        var meta = el('div', 'meta');
        var label = laneLabel(article, lane);
        if (label) {
            meta.appendChild(el('span', 'badge lane ' + lane, label));
        }
        if (article.site) { meta.appendChild(el('span', 'site-badge', article.site)); }
        var ago = timeAgo(article, now);
        if (ago) { meta.appendChild(el('span', 'time', ago)); }

        var hatena = article.hatena || 0;
        var rising = (article.hatena_delta || 0) >= RISING_THRESHOLD;
        if (hatena >= HOT_THRESHOLD || rising) {
            var label = rising ? '急上昇' : '';
            if (hatena) { label = label ? label + ' ' + hatena : String(hatena); }
            meta.appendChild(el('span', 'badge hot', label || '話題'));
        }
        if (!label && article.matched && article.matched.length) {
            meta.appendChild(el('span', 'badge interest', article.matched[0]));
        }
        if (Date.parse(article.first_seen)
                && now - Date.parse(article.first_seen) < NEW_WINDOW_HOURS * 3600000) {
            meta.appendChild(el('span', 'badge new', 'NEW'));
        }
        // 何媒体が報じたか。大きなニュースほどここが伸びる。
        if ((article.reach || 1) >= 2) {
            meta.appendChild(el('span', 'badge also', article.reach + '媒体'));
        }
        return meta;
    }

    function buildThumb(url) {
        var img = el('img', 'thumb');
        img.loading = 'lazy';
        img.decoding = 'async';
        img.alt = '';
        img.addEventListener('error', function () {
            // 画像が落ちたらカードごと崩さずサムネイルだけ消す
            if (img.parentNode) { img.parentNode.removeChild(img); }
        });
        img.src = url;
        return img;
    }

    function buildCard(article, now, lane) {
        var card = el('a', 'article' + (article.image ? ' medium' : ''));
        card.href = safeLink(article.link);
        card.target = '_blank';
        card.rel = 'noopener';
        card.addEventListener('click', function () {
            // 「よく読むサイト」と「よく読む話題」を覚える。端末の中だけの記録。
            settings.affinity[article.site] = (settings.affinity[article.site] || 0) + 1;
            learnFrom(article.title);
            saveSettings();
        });

        var body = el('div', 'body');
        if (article.image) {
            body.appendChild(buildThumb(article.image));
            var text = el('div', 'text');
            text.appendChild(el('div', 'title', article.title));
            text.appendChild(buildMeta(article, now, lane));
            body.appendChild(text);
            card.appendChild(body);
            return card;
        }
        body.appendChild(el('div', 'title', article.title));
        body.appendChild(buildMeta(article, now, lane));
        card.appendChild(body);
        return card;
    }

    /* 一覧を PAGE_SIZE 件ずつ描き足す。末尾の番人が画面に入ったら次を描く。
     * 全部描いてしまうと数百枚のカードがDOMに載るし、そもそも一度に見えるのは
     * 数件なので、スクロールに合わせて足すほうが軽い。
     * extend を渡すと、在庫を使い切ったところで補充を試みる。 */
    function renderList(pane, articles, now, extend, lanes) {
        var cursor = 0;
        lanes = lanes || Object.create(null);
        var shown = Object.create(null);
        var loading = false;
        var sentinel = el('div', 'more');
        pane.appendChild(sentinel);
        pane.appendChild(el('div', 'footer',
            '最終更新: ' + ((catalog && catalog.updated_label) || '')));

        function draw() {
            articles.slice(cursor, cursor + PAGE_SIZE).forEach(function (article) {
                shown[article.key] = true;
                pane.insertBefore(buildCard(article, now, lanes[article.key]), sentinel);
                remember(article);
                cursor++;
            });
        }

        function stop() {
            extend = null;
            sentinel.textContent = '';
        }

        function more() {
            if (loading) { return; }
            if (cursor < articles.length) { draw(); return; }
            if (!extend) { stop(); return; }
            loading = true;
            sentinel.textContent = '読み込み中…';
            extend(shown).then(function (added) {
                loading = false;
                sentinel.textContent = '';
                if (!added || !added.length) { stop(); return; }
                var extra = laneMap(added);
                Object.keys(extra).forEach(function (key) { lanes[key] = extra[key]; });
                articles = articles.concat(added);
                draw();
            }, function () {
                loading = false;
                stop();
            });
        }

        draw();
        // 画面下に近づいた時点で次を用意する（スクロールが止まらないように）
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) { more(); }
            });
        }, { root: pane, rootMargin: '800px' });
        observer.observe(sentinel);
    }

    function emptyPane(message) {
        var pane = el('div', 'swipe-item');
        pane.appendChild(el('div', 'empty', message));
        return pane;
    }

    function renderTab(tab, now) {
        var pane = el('div', 'swipe-item');
        pane.id = 'tab-' + tab.id;
        if (!tab.articles.length) {
            pane.appendChild(el('div', 'empty', '記事がありません'));
            pane.appendChild(el('div', 'footer',
                '最終更新: ' + ((catalog && catalog.updated_label) || '')));
            return pane;
        }
        renderList(pane, tab.articles, now, tab.extend, tab.lanes);
        return pane;
    }

    function syncActiveTab(id) {
        var tabs = tabBar.querySelectorAll('.tab');
        for (var i = 0; i < tabs.length; i++) {
            var tab = tabs[i];
            var isActive = tab.getAttribute('data-target') === id;
            tab.classList.toggle('active', isActive);
            if (isActive) {
                tab.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        }
    }

    /* TOPの母集団。購読しているパックとカスタムソースに加えて、探索用に
     * 読み込んだパックも在庫に入れる（下まで読んだ人だけ視野が広がる）。 */
    function topPool() {
        var lists = [];
        subscribedPacks().forEach(function (pack) {
            lists.push(packData[pack.id] || []);
        });
        settings.custom.forEach(function (source) {
            lists.push(packData['custom:' + source.id] || []);
        });
        Object.keys(packData).forEach(function (id) {
            if (id.indexOf('custom:') === 0) { return; }
            if (settings.packs.indexOf(id) !== -1) { return; }
            lists.push(packData[id]);
        });
        return merge(lists);
    }

    /* TOPの続きを作る。まだ出していない記事を手持ちから組み直し、それも尽きたら
     * 購読していないカテゴリを1つ読み込んで継ぎ足す。購読を勝手に増やしはしない。
     * スクロールを続けたぶんだけ視野が広がる、という仕掛け。 */
    function extendTop(shown) {
        var taken = Object.create(null);
        Object.keys(shown).forEach(function (key) { taken[key] = true; });
        var added = buildTop(topPool(), TOP_LIMIT, taken);
        if (added.length) { return Promise.resolve(added); }

        var next = null;
        (catalog.packs || []).forEach(function (pack) {
            if (next || packData[pack.id]) { return; }
            if (settings.packs.indexOf(pack.id) !== -1) { return; }
            next = pack.id;
        });
        if (!next) { return Promise.resolve([]); }
        return loadPack(next).then(function () { return extendTop(shown); });
    }

    function render() {
        var now = Date.now();
        var packs = subscribedPacks();

        var top = buildTop(topPool(), TOP_LIMIT);
        var tabs = [{
            id: 'top', name: 'TOP', articles: top, lanes: laneMap(top),
            extend: extendTop
        }];
        packs.forEach(function (pack) {
            var articles = rank(merge([packData[pack.id] || []]), PACK_LIMIT);
            if (!articles.length) { return; }
            tabs.push({
                id: 'pack-' + pack.id,
                name: pack.name,
                articles: articles
            });
        });
        settings.custom.forEach(function (source) {
            var articles = rank(merge([packData['custom:' + source.id] || []]), PACK_LIMIT);
            if (!articles.length) { return; }
            tabs.push({ id: 'custom-' + source.id, name: source.name, articles: articles });
        });

        tabBar.textContent = '';
        container.textContent = '';

        if (tabs[0].articles.length === 0) {
            container.appendChild(emptyPane(
                'まだ表示する記事がありません。\n右上の「設定」からカテゴリを選んでください。'));
            return;
        }

        tabs.forEach(function (tab, index) {
            var button = el('button', 'tab' + (index === 0 ? ' active' : ''), tab.name);
            button.setAttribute('data-target', 'tab-' + tab.id);
            button.addEventListener('click', function () {
                var target = document.getElementById('tab-' + tab.id);
                if (target) { container.scrollTo({ left: target.offsetLeft, behavior: 'smooth' }); }
            });
            tabBar.appendChild(button);
            container.appendChild(renderTab(tab, now));
        });

        // スワイプでタブバーの選択状態を同期する
        var observer = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) { syncActiveTab(entry.target.id); }
            });
        }, { root: container, threshold: 0.5 });
        container.querySelectorAll('.swipe-item').forEach(function (pane) {
            observer.observe(pane);
        });
    }

    /* ---------------- データの読み込み ---------------- */

    function refresh() {
        var jobs = settings.packs.map(loadPack);
        settings.custom.forEach(function (source) {
            var id = 'custom:' + source.id;
            if (packData[id]) { return; }
            jobs.push(loadCustom(source).then(function (articles) {
                packData[id] = articles;
            }));
        });
        return Promise.all(jobs).then(render);
    }

    /* ---------------- 設定画面 ---------------- */

    function group() { return el('div', 'group'); }

    function sectionTitle(text) { return el('h2', null, text); }

    function hint(text) { return el('p', 'hint', text); }

    function row(name, description) {
        var node = el('div', 'row');
        var grow = el('div', 'grow');
        grow.appendChild(el('div', 'name', name));
        if (description) { grow.appendChild(el('div', 'desc', description)); }
        node.appendChild(grow);
        return node;
    }

    function iconButton(label, onClick, disabled, extraClass) {
        var button = el('button', 'iconbtn' + (extraClass ? ' ' + extraClass : ''), label);
        button.disabled = !!disabled;
        button.addEventListener('click', onClick);
        return button;
    }

    function applyAndRerender() {
        saveSettings();
        renderSettings();
        refresh();
    }

    function subscribe(id) {
        if (settings.packs.indexOf(id) !== -1) { return; }
        settings.packs.push(id);
        var meta = packMeta(id);
        // パックが持っている推奨キーワードを、未登録のものだけ取り込む
        (meta && meta.suggested_interests || []).forEach(function (item) {
            var exists = settings.interests.some(function (i) { return i.word === item.word; });
            if (!exists) {
                settings.interests.push({ word: item.word, weight: item.weight });
            }
        });
    }

    function unsubscribe(id) {
        settings.packs = settings.packs.filter(function (p) { return p !== id; });
    }

    function movePack(id, offset) {
        var index = settings.packs.indexOf(id);
        var target = index + offset;
        if (index < 0 || target < 0 || target >= settings.packs.length) { return; }
        settings.packs.splice(target, 0, settings.packs.splice(index, 1)[0]);
    }

    function renderPackSection(parent) {
        parent.appendChild(sectionTitle('カテゴリ'));
        parent.appendChild(hint(
            '選んだ順にタブが並びます。TOPは選んだカテゴリ全部を混ぜて作られ、'
            + '下まで読み進めると選んでいないカテゴリからも継ぎ足されます。'));
        var box = group();

        settings.packs.forEach(function (id, index) {
            var meta = packMeta(id);
            if (!meta) { return; }
            var node = row(meta.name, meta.description);
            node.appendChild(iconButton('↑', function () {
                movePack(id, -1); applyAndRerender();
            }, index === 0));
            node.appendChild(iconButton('↓', function () {
                movePack(id, 1); applyAndRerender();
            }, index === settings.packs.length - 1));
            node.appendChild(iconButton('✕', function () {
                unsubscribe(id); applyAndRerender();
            }, false, 'danger'));
            box.appendChild(node);
        });

        (catalog.packs || []).forEach(function (meta) {
            if (settings.packs.indexOf(meta.id) !== -1) { return; }
            var node = row(meta.name, meta.description);
            node.classList.add('dim');
            node.appendChild(iconButton('＋', function () {
                subscribe(meta.id); applyAndRerender();
            }));
            box.appendChild(node);
        });

        parent.appendChild(box);
    }

    function renderInterestSection(parent) {
        parent.appendChild(sectionTitle('興味のあるキーワード'));
        parent.appendChild(hint('タイトルにこの語を含む記事が上がりやすくなります。'));
        var box = group();

        var field = el('div', 'field');
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = 'キーワード';
        var select = document.createElement('select');
        WEIGHTS.forEach(function (option, index) {
            var node = document.createElement('option');
            node.value = String(option.value);
            node.textContent = option.label;
            if (index === 1) { node.selected = true; }
            select.appendChild(node);
        });
        var add = document.createElement('button');
        add.textContent = '追加';
        function submit() {
            var word = input.value.trim();
            if (!word) { return; }
            var exists = settings.interests.some(function (i) { return i.word === word; });
            if (!exists) {
                settings.interests.push({ word: word, weight: Number(select.value) });
            }
            input.value = '';
            applyAndRerender();
        }
        add.addEventListener('click', submit);
        input.addEventListener('keydown', function (event) {
            if (event.key === 'Enter') { event.preventDefault(); submit(); }
        });
        field.appendChild(input);
        field.appendChild(select);
        field.appendChild(add);
        box.appendChild(field);

        if (settings.interests.length) {
            var chips = el('div', 'chiprow');
            settings.interests.forEach(function (interest) {
                var chip = el('span', 'chip');
                var label = WEIGHTS.filter(function (w) { return w.value === interest.weight; })[0];
                chip.appendChild(document.createTextNode(
                    interest.word + (label ? '（' + label.label + '）' : '')));
                var remove = document.createElement('button');
                remove.textContent = '✕';
                remove.setAttribute('aria-label', interest.word + ' を削除');
                remove.addEventListener('click', function () {
                    settings.interests = settings.interests.filter(function (i) {
                        return i.word !== interest.word;
                    });
                    applyAndRerender();
                });
                chip.appendChild(remove);
                chips.appendChild(chip);
            });
            box.appendChild(chips);
        }
        parent.appendChild(box);
    }

    /* 何を学習したのかを見せて、いつでも消せるようにしておく。
     * 勝手に効くレコメンドは、中身が見えないと気持ち悪いだけになる。 */
    function renderLearnedSection(parent) {
        var words = Object.keys(settings.topics).sort(function (a, b) {
            return settings.topics[b] - settings.topics[a];
        });
        parent.appendChild(sectionTitle('自動で覚えた話題'));
        parent.appendChild(hint(
            '開いた記事の見出しから拾った語です。TOPのおすすめに使われます。'
            + '古いものから薄れていくので、放っておいても入れ替わります。'));
        var box = group();
        if (!words.length) {
            box.appendChild(row('まだありません', '記事をいくつか開くと溜まります'));
            parent.appendChild(box);
            return;
        }
        var chips = el('div', 'chiprow');
        words.forEach(function (word) {
            var chip = el('span', 'chip');
            chip.appendChild(document.createTextNode(word));
            var remove = document.createElement('button');
            remove.textContent = '✕';
            remove.setAttribute('aria-label', word + ' を忘れる');
            remove.addEventListener('click', function () {
                delete settings.topics[word];
                applyAndRerender();
            });
            chip.appendChild(remove);
            chips.appendChild(chip);
        });
        box.appendChild(chips);
        var forget = el('button', 'linkbtn danger', 'まとめて忘れる');
        forget.addEventListener('click', function () {
            settings.topics = {};
            applyAndRerender();
        });
        box.appendChild(forget);
        parent.appendChild(box);
    }

    function renderCustomSection(parent) {
        // ブラウザから外部フィードを直接読めないので、この機能は取得プロキシ
        // （Cloudflare Pages Functions）のある配信先でしか成立しない。無い環境では
        // 使えない欄を見せても仕方がないので、節ごと出さない。判定前も同じ扱い。
        if (apiAvailable !== true) { return; }

        parent.appendChild(sectionTitle('自分で追加したソース'));
        var box = group();

        settings.custom.forEach(function (source) {
            var node = row(source.name,
                (source.type === 'query' ? 'キーワード: ' : 'RSS: ') + source.value);
            node.appendChild(iconButton('✕', function () {
                settings.custom = settings.custom.filter(function (s) { return s.id !== source.id; });
                delete packData['custom:' + source.id];
                applyAndRerender();
            }, false, 'danger'));
            box.appendChild(node);
        });

        var field = el('div', 'field');
        var kind = document.createElement('select');
        [['query', 'キーワード'], ['feed', 'RSSのURL']].forEach(function (pair) {
            var option = document.createElement('option');
            option.value = pair[0];
            option.textContent = pair[1];
            kind.appendChild(option);
        });
        var input = document.createElement('input');
        input.type = 'text';
        input.placeholder = '例: 将棋 藤井';
        kind.addEventListener('change', function () {
            input.placeholder = kind.value === 'query' ? '例: 将棋 藤井' : 'https://example.com/rss';
        });
        var add = document.createElement('button');
        add.textContent = '追加';
        add.addEventListener('click', function () {
            var value = input.value.trim();
            if (!value) { return; }
            if (kind.value === 'feed' && !/^https?:\/\//i.test(value)) {
                input.value = '';
                input.placeholder = 'http(s):// で始まるURLを入れてください';
                return;
            }
            settings.custom.push({
                id: 'c' + Math.random().toString(36).slice(2, 9),
                name: value.slice(0, 40),
                type: kind.value,
                value: value
            });
            input.value = '';
            applyAndRerender();
        });
        field.appendChild(kind);
        field.appendChild(input);
        field.appendChild(add);
        box.appendChild(field);
        parent.appendChild(box);
        parent.appendChild(el('p', 'note',
            'キーワードはGoogleニュース検索から拾います。RSSはそのURLをそのまま読みます。'));
    }

    function renderMuteSection(parent) {
        var sites = {};
        Object.keys(packData).forEach(function (id) {
            (packData[id] || []).forEach(function (article) { sites[article.site] = true; });
        });
        settings.muted.forEach(function (site) { sites[site] = true; });
        var names = Object.keys(sites).sort();
        if (!names.length) { return; }

        parent.appendChild(sectionTitle('表示しないサイト'));
        var box = group();
        names.forEach(function (site) {
            var node = row(site);
            var checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = settings.muted.indexOf(site) !== -1;
            checkbox.setAttribute('aria-label', site + ' を非表示にする');
            checkbox.addEventListener('change', function () {
                if (checkbox.checked) {
                    settings.muted.push(site);
                } else {
                    settings.muted = settings.muted.filter(function (s) { return s !== site; });
                }
                saveSettings();
                refresh();
            });
            node.appendChild(checkbox);
            box.appendChild(node);
        });
        parent.appendChild(box);
    }

    function renderDataSection(parent) {
        parent.appendChild(sectionTitle('設定の持ち出し'));
        parent.appendChild(hint('アカウントはありません。別の端末に移すときはこのリンクを開いてください。'));
        var box = group();

        var copy = el('button', 'linkbtn', '設定を含んだリンクをコピー');
        copy.addEventListener('click', function () {
            var url = location.origin + location.pathname + '#s=' + encodeSettings();
            var done = function () { copy.textContent = 'コピーしました'; };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(url).then(done, function () {
                    copy.textContent = url;
                });
            } else {
                copy.textContent = url;
            }
        });
        box.appendChild(copy);

        var learned = Object.keys(settings.affinity).length;
        var reset = el('button', 'linkbtn danger',
            'よく読むサイトの記録を消す' + (learned ? '（' + learned + '件）' : ''));
        reset.addEventListener('click', function () {
            settings.affinity = {};
            applyAndRerender();
        });
        box.appendChild(reset);

        var seen = Object.keys(settings.seen).length;
        var unsee = el('button', 'linkbtn danger',
            '「もう見た記事」の記録を消す' + (seen ? '（' + seen + '件）' : ''));
        unsee.addEventListener('click', function () {
            settings.seen = {};
            applyAndRerender();
        });
        box.appendChild(unsee);

        var wipe = el('button', 'linkbtn danger', 'すべての設定を消す');
        wipe.addEventListener('click', function () {
            settings = defaultSettings();
            packData = {};
            saveSettings();
            startOnboarding();
        });
        box.appendChild(wipe);
        parent.appendChild(box);
    }

    /* 「直したはずの機能が出てこない」ときに、まず疑うべきはブラウザが
     * 古い app.js を掴んだままかどうか。配信中の版と突き合わせて出す。 */
    function renderVersionSection(parent) {
        var served = (catalog && catalog.app_build) || '';
        parent.appendChild(sectionTitle('バージョン'));
        var box = group();
        box.appendChild(row('いま動いているアプリ', APP_BUILD));
        if (served) { box.appendChild(row('配信されているアプリ', served)); }
        box.appendChild(row('記事の更新',
            (catalog && catalog.updated_label) || '—'));
        parent.appendChild(box);
        if (served && APP_BUILD !== 'dev' && served !== APP_BUILD) {
            parent.appendChild(hint(
                'ブラウザが古いアプリを保持しています。'
                + 'この画面を閉じてページを再読み込みすると新しくなります。'));
        }
    }

    function renderSettings() {
        sheetBody.textContent = '';
        if (!catalog) { return; }
        renderPackSection(sheetBody);
        renderInterestSection(sheetBody);
        renderLearnedSection(sheetBody);
        renderCustomSection(sheetBody);
        renderMuteSection(sheetBody);
        renderDataSection(sheetBody);
        renderVersionSection(sheetBody);
    }

    function openSettings() {
        sheet.hidden = false;
        probeAPI().then(renderSettings);
        renderSettings();
    }

    function closeSettings() {
        if (!settings.packs.length) {
            // カテゴリが0件だと何も出ないので、閉じさせる前に既定値へ戻す
            applyDefaults();
        }
        settings.onboarded = true;
        saveSettings();
        sheet.hidden = true;
        refresh();
    }

    function applyDefaults() {
        (catalog.packs || []).forEach(function (pack) {
            if (pack['default']) { subscribe(pack.id); }
        });
    }

    function startOnboarding() {
        applyDefaults();
        saveSettings();
        document.getElementById('settings-title').textContent = 'ようこそ';
        document.getElementById('settings-lead').textContent =
            '読みたいカテゴリを選んでください。あとから何度でも変えられます。'
            + '設定はこの端末の中だけに保存されます。';
        openSettings();
        refresh();
    }

    /* ---------------- 起動 ---------------- */

    function importFromHash() {
        var match = /^#s=(.+)$/.exec(location.hash || '');
        if (!match) { return false; }
        try {
            settings = sanitize(decodeSettings(match[1]));
            settings.onboarded = true;
            saveSettings();
            history.replaceState(null, '', location.pathname + location.search);
            return true;
        } catch (err) {
            return false;
        }
    }

    /* 並べ替えの回帰テスト（tools/rank_smoke_test.js）から触るためのフック。
     * ブラウザでの動作には影響しない。 */
    window.__msn = {
        getSettings: function () { return settings; },
        setSettings: function (next) { settings = sanitize(next); },
        score: score,
        rank: rank,
        merge: merge,
        pickDiverse: pickDiverse,
        buildTop: buildTop,
        learnFrom: learnFrom
    };

    document.getElementById('open-settings').addEventListener('click', openSettings);
    document.getElementById('close-settings').addEventListener('click', closeSettings);

    loadSettings();
    importFromHash();

    getJSON('index.json').then(function (data) {
        catalog = data;
        // カタログから消えたパックの購読は落とす
        settings.packs = settings.packs.filter(packMeta);
        if (!settings.onboarded) {
            startOnboarding();
            return;
        }
        saveSettings();
        return refresh();
    }).catch(function (err) {
        var status = document.getElementById('status');
        if (status) {
            status.textContent = 'ニュースの読み込みに失敗しました (' + err.message + ')';
        }
    });
})();
