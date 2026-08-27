/* MySmartNews フロントエンド
 *
 * news.json を読み込んでタブとカードを描画する。タイトルは textContent で
 * 差し込むため、記事タイトルに < や & が含まれていても壊れない。
 */
(function () {
    'use strict';

    var tabBar = document.getElementById('tab-bar');
    var container = document.getElementById('swipe-container');

    function safeLink(url) {
        // フィード由来のURLをそのまま href に入れないための最低限のガード
        return /^https?:\/\//i.test(url || '') ? url : '#';
    }

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) { node.className = className; }
        if (text !== undefined && text !== null) { node.textContent = text; }
        return node;
    }

    function buildMeta(article) {
        var meta = el('div', 'meta');
        if (article.site_name) {
            meta.appendChild(el('span', 'site-badge', article.site_name));
        }
        if (article.time_ago) {
            meta.appendChild(el('span', 'time', article.time_ago));
        }
        if (article.hot || article.rising) {
            var label = article.rising ? '急上昇' : '';
            if (article.hatena) { label = label ? label + ' ' + article.hatena : String(article.hatena); }
            meta.appendChild(el('span', 'badge hot', '🔥 ' + (label || '話題')));
        }
        if (article.matched && article.matched.length) {
            meta.appendChild(el('span', 'badge interest', article.matched[0]));
        }
        if (article.is_new) {
            meta.appendChild(el('span', 'badge new', 'NEW'));
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

    /* size: 'hero' | 'medium' | 'compact' */
    function buildCard(article, size) {
        var card = el('a', 'article ' + size);
        card.href = safeLink(article.link);
        card.target = '_blank';
        card.rel = 'noopener';

        var body = el('div', 'body');

        if (size === 'hero') {
            if (article.image) { card.appendChild(buildThumb(article.image)); }
            body.appendChild(el('div', 'title', article.title));
            body.appendChild(buildMeta(article));
            card.appendChild(body);
            return card;
        }

        if (size === 'medium' && article.image) {
            body.appendChild(buildThumb(article.image));
            var text = el('div', 'text');
            text.appendChild(el('div', 'title', article.title));
            text.appendChild(buildMeta(article));
            body.appendChild(text);
            card.appendChild(body);
            return card;
        }

        body.appendChild(el('div', 'title', article.title));
        body.appendChild(buildMeta(article));
        card.appendChild(body);
        return card;
    }

    function appendSection(parent, title, articles, startWithHero) {
        if (!articles.length) { return; }
        if (title) { parent.appendChild(el('div', 'section-title', title)); }
        articles.forEach(function (article, index) {
            var size = 'compact';
            if (startWithHero && index === 0 && article.image) {
                size = 'hero';
            } else if (article.image && index < 5) {
                size = 'medium';
            }
            parent.appendChild(buildCard(article, size));
        });
    }

    /* TOPタブだけは同じ一覧を「話題 / あなた向け / 新着」に切り分けて、
     * 全カードが同じ見た目で流れていく単調さをなくす。重複はさせない。 */
    function renderTop(pane, articles) {
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

        var hot = take(function (a) { return a.hot || a.rising; }, 5);
        var forYou = take(function (a) { return a.matched && a.matched.length; }, 8);
        var rest = take(function () { return true; }, articles.length);

        appendSection(pane, hot.length ? '🔥 話題' : null, hot, true);
        appendSection(pane, '⭐ あなた向け', forYou, hot.length === 0);
        appendSection(pane, forYou.length || hot.length ? '🆕 新着' : null, rest, false);
    }

    function renderTab(tab, isTop) {
        var pane = el('div', 'swipe-item');
        pane.id = 'tab-' + tab.id;

        if (!tab.articles.length) {
            pane.appendChild(el('div', 'empty', '記事がありません'));
            return pane;
        }

        if (isTop) {
            renderTop(pane, tab.articles);
        } else {
            appendSection(pane, null, tab.articles, true);
        }
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

    function render(data) {
        tabBar.textContent = '';
        container.textContent = '';

        data.tabs.forEach(function (tab, index) {
            var button = el('div', 'tab' + (index === 0 ? ' active' : ''), tab.name);
            button.setAttribute('data-target', 'tab-' + tab.id);
            button.addEventListener('click', function () {
                var target = document.getElementById('tab-' + tab.id);
                if (target) { container.scrollTo({ left: target.offsetLeft, behavior: 'smooth' }); }
            });
            tabBar.appendChild(button);

            var pane = renderTab(tab, tab.id === 'top');
            pane.appendChild(el('div', 'footer', '最終更新: ' + (data.updated_label || '')));
            container.appendChild(pane);
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

    fetch('news.json', { cache: 'no-cache' })
        .then(function (res) {
            if (!res.ok) { throw new Error('HTTP ' + res.status); }
            return res.json();
        })
        .then(render)
        .catch(function (err) {
            var status = document.getElementById('status');
            if (status) { status.textContent = 'ニュースの読み込みに失敗しました (' + err.message + ')'; }
        });
})();
