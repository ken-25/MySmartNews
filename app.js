/* MySmartNews フロントエンド
 *
 * dist/index.json（パックのカタログ）と dist/p/<pack>.json（記事）を読み、
 * **並び順はこのファイルが決める**。ビルド側は誰にとっても同じ客観的な信号
 * （公開時刻・初回発見時刻・はてブ数と増分）しか持たせていないので、
 * ユーザーごとの好みは全部ここと localStorage の中で完結する。
 *
 * 記事タイトルは textContent で差し込むため、< や & が含まれていても壊れない。
 */
(function () {
    'use strict';

    /* ---------------- チューニング定数 ---------------- */
    var HALF_LIFE_HOURS = 8.0;     // 鮮度の半減期
    var DIVERSITY_DECAY = 0.6;     // 同一サイトが1件増えるごとに掛かる係数
    var POPULARITY_WEIGHT = 0.6;   // はてブ累計数の効き
    var VELOCITY_WEIGHT = 1.2;     // はてブ増加数（急上昇）の効き
    var AFFINITY_WEIGHT = 0.5;     // よく読むサイトの効き
    var HOT_THRESHOLD = 30;        // バッジを出す累計ブックマーク数
    var RISING_THRESHOLD = 10;     // 急上昇と見なす増分
    var NEW_WINDOW_HOURS = 3;      // NEW バッジを出す初回発見からの時間
    var TOP_LIMIT = 60;
    var PACK_LIMIT = 80;
    var STORAGE_KEY = 'msn.v2';
    var WEIGHTS = [
        { label: '弱', value: 0.6 },
        { label: '中', value: 1.2 },
        { label: '強', value: 2.0 }
    ];

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
            muted: [], custom: [], affinity: {}
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
            muted: settings.muted, custom: settings.custom, onboarded: true
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

    /* ---------------- スコアリング ---------------- */

    function matchInterests(title) {
        var lowered = title.toLowerCase();
        return settings.interests.filter(function (interest) {
            return lowered.indexOf(interest.word.toLowerCase()) !== -1;
        });
    }

    function score(article, now) {
        var at = Date.parse(article.published_at) || now;
        var ageHours = Math.max((now - at) / 3600000, 0);
        var freshness = Math.pow(0.5, ageHours / HALF_LIFE_HOURS);

        var hits = matchInterests(article.title);
        article.matched = hits.map(function (h) { return h.word; });
        var interest = 1.0;
        hits.forEach(function (h) { interest += h.weight; });

        var hatena = article.hatena || 0;
        var delta = article.hatena_delta || 0;
        var popularity = 1.0
            + POPULARITY_WEIGHT * Math.log10(1 + hatena)
            + VELOCITY_WEIGHT * Math.log10(1 + Math.max(delta, 0));

        var clicks = settings.affinity[article.site] || 0;
        var affinity = 1.0 + AFFINITY_WEIGHT * Math.log10(1 + clicks);

        article.score = freshness * interest * popularity * affinity;
        return article.score;
    }

    /* スコア順に選びつつ、同じサイトが続くほどスコアを割り引く（貪欲MMR）。
     * 純粋な新着順だと更新頻度の高いサイトが一覧を独占してしまう。 */
    function pickDiverse(articles, limit) {
        var pool = articles.slice().sort(function (a, b) { return b.score - a.score; });
        var chosen = [];
        var used = {};
        while (pool.length && chosen.length < limit) {
            var bestIndex = 0;
            var bestValue = -1;
            for (var i = 0; i < pool.length; i++) {
                var seen = used[pool[i].site] || 0;
                var value = pool[i].score * Math.pow(DIVERSITY_DECAY, seen);
                if (value > bestValue) { bestIndex = i; bestValue = value; }
            }
            var picked = pool.splice(bestIndex, 1)[0];
            used[picked.site] = (used[picked.site] || 0) + 1;
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
                if (!existing || (article.hatena || 0) > (existing.hatena || 0)) {
                    byKey[article.key] = article;
                }
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

    function buildMeta(article, now) {
        var meta = el('div', 'meta');
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
        if (article.matched && article.matched.length) {
            meta.appendChild(el('span', 'badge interest', article.matched[0]));
        }
        if (Date.parse(article.first_seen)
                && now - Date.parse(article.first_seen) < NEW_WINDOW_HOURS * 3600000) {
            meta.appendChild(el('span', 'badge new', 'NEW'));
        }
        if (article.also) {
            meta.appendChild(el('span', 'badge also', '他' + article.also + '件'));
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

    function buildCard(article, now) {
        var card = el('a', 'article' + (article.image ? ' medium' : ''));
        card.href = safeLink(article.link);
        card.target = '_blank';
        card.rel = 'noopener';
        card.addEventListener('click', function () {
            // 「よく読むサイト」を覚える。端末の中だけの記録。
            settings.affinity[article.site] = (settings.affinity[article.site] || 0) + 1;
            saveSettings();
        });

        var body = el('div', 'body');
        if (article.image) {
            body.appendChild(buildThumb(article.image));
            var text = el('div', 'text');
            text.appendChild(el('div', 'title', article.title));
            text.appendChild(buildMeta(article, now));
            body.appendChild(text);
            card.appendChild(body);
            return card;
        }
        body.appendChild(el('div', 'title', article.title));
        body.appendChild(buildMeta(article, now));
        card.appendChild(body);
        return card;
    }

    function appendSection(parent, title, articles, now) {
        if (!articles.length) { return; }
        if (title) { parent.appendChild(el('div', 'section-title', title)); }
        articles.forEach(function (article) {
            parent.appendChild(buildCard(article, now));
        });
    }

    /* TOPだけは同じ一覧を「話題 / あなた向け / 新着」に切り分けて、
     * 全カードが同じ見た目で流れていく単調さをなくす。重複はさせない。 */
    function renderTop(pane, articles, now) {
        var used = Object.create(null);
        function take(predicate, limit) {
            var picked = [];
            articles.forEach(function (article) {
                if (picked.length >= limit || used[article.link]) { return; }
                if (predicate(article)) {
                    used[article.link] = true;
                    picked.push(article);
                }
            });
            return picked;
        }
        var hot = take(function (a) {
            return (a.hatena || 0) >= HOT_THRESHOLD
                || (a.hatena_delta || 0) >= RISING_THRESHOLD;
        }, 5);
        var forYou = take(function (a) { return a.matched && a.matched.length; }, 8);
        var rest = take(function () { return true; }, articles.length);

        appendSection(pane, hot.length ? '話題' : null, hot, now);
        appendSection(pane, 'あなた向け', forYou, now);
        appendSection(pane, (forYou.length || hot.length) ? '新着' : null, rest, now);
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
        } else if (tab.id === 'top') {
            renderTop(pane, tab.articles, now);
        } else {
            appendSection(pane, null, tab.articles, now);
        }
        pane.appendChild(el('div', 'footer',
            '最終更新: ' + ((catalog && catalog.updated_label) || '')));
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

    function render() {
        var now = Date.now();
        var packs = subscribedPacks();
        var lists = packs.map(function (pack) { return packData[pack.id] || []; });
        settings.custom.forEach(function (source) {
            lists.push(packData['custom:' + source.id] || []);
        });

        var tabs = [{ id: 'top', name: 'TOP', articles: rank(merge(lists), TOP_LIMIT) }];
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
        parent.appendChild(hint('選んだ順にタブが並びます。TOPは選んだカテゴリ全部から作られます。'));
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

    function renderSettings() {
        sheetBody.textContent = '';
        if (!catalog) { return; }
        renderPackSection(sheetBody);
        renderInterestSection(sheetBody);
        renderCustomSection(sheetBody);
        renderMuteSection(sheetBody);
        renderDataSection(sheetBody);
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
        pickDiverse: pickDiverse
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
