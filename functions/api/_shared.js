/* Cloudflare Pages Functions 共通ヘルパー。
 *
 * ブラウザは news.google.com や各サイトのRSSを直接読めない（CORSヘッダがない）。
 * ユーザーが自分で追加したソースだけ、この薄いプロキシ越しに取得する。
 * カタログに載っているパックはビルド時に取得済みなので、ここは通らない。
 */

export const FEED_TTL_SECONDS = 900;
export const MAX_BYTES = 2 * 1024 * 1024;
export const USER_AGENT = 'MySmartNewsBot/2.0 (+https://github.com/ken-25/MySmartNews)';

const PRIVATE_HOST = /^(localhost$|.*\.local$|.*\.internal$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/i;

export function fail(message, status) {
    return new Response(JSON.stringify({ error: message }), {
        status: status,
        headers: { 'content-type': 'application/json; charset=utf-8' }
    });
}

/** ユーザーが入れたURLを取りに行ってよいか判断する。 */
export function checkTarget(raw) {
    let url;
    try {
        url = new URL(raw);
    } catch (err) {
        return 'URLの形式が正しくありません';
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        return 'http(s) のURLだけを取得できます';
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
        return '指定できないポートです';
    }
    if (PRIVATE_HOST.test(url.hostname)) {
        return '内部ネットワークのアドレスは取得できません';
    }
    return null;
}

/** フィードらしさの最低限のチェック。汎用プロキシとして使われるのを防ぐ。 */
function looksLikeFeed(contentType, body) {
    if (/xml|rss|atom/i.test(contentType || '')) { return true; }
    return body.trimStart().startsWith('<');
}

/** エッジキャッシュ付きでフィードを取得して返す。 */
export async function proxyFeed(request, target) {
    const cache = caches.default;
    const cacheKey = new Request(new URL(request.url).origin + '/__feed/'
        + encodeURIComponent(target), { method: 'GET' });
    const cached = await cache.match(cacheKey);
    if (cached) { return cached; }

    let upstream;
    try {
        upstream = await fetch(target, {
            headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/xml, text/xml, */*' },
            redirect: 'follow',
            cf: { cacheTtl: FEED_TTL_SECONDS, cacheEverything: true }
        });
    } catch (err) {
        return fail('取得できませんでした', 502);
    }
    if (!upstream.ok) {
        return fail('取得できませんでした (' + upstream.status + ')', 502);
    }

    const raw = await upstream.arrayBuffer();
    if (raw.byteLength > MAX_BYTES) {
        return fail('フィードが大きすぎます', 413);
    }
    const body = new TextDecoder('utf-8').decode(raw);
    if (!looksLikeFeed(upstream.headers.get('content-type'), body)) {
        return fail('RSS/Atom フィードではないようです', 415);
    }

    const response = new Response(body, {
        headers: {
            'content-type': 'application/xml; charset=utf-8',
            'cache-control': 'public, max-age=' + FEED_TTL_SECONDS,
            'x-content-type-options': 'nosniff'
        }
    });
    await cache.put(cacheKey, response.clone());
    return response;
}
