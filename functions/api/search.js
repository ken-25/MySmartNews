/* GET /api/search?q=<検索式>
 *
 * ユーザーが自分で追加したキーワードを、Googleニュース検索RSSに変換して中継する。
 * URLはこちらで組み立てるので、任意のホストには飛ばない。
 * 検索サービスを乗り換えるならここだけ差し替えればよい（build.py 側も同様）。
 */
import { fail, proxyFeed } from './_shared.js';

const SEARCH_FEED = 'https://news.google.com/rss/search?q={query}&hl=ja&gl=JP&ceid=JP:ja';
const MAX_QUERY_LENGTH = 200;

export async function onRequestGet(context) {
    const query = (new URL(context.request.url).searchParams.get('q') || '').trim();
    if (!query) {
        return fail('q パラメータが必要です', 400);
    }
    if (query.length > MAX_QUERY_LENGTH) {
        return fail('検索式が長すぎます', 400);
    }
    const target = SEARCH_FEED.replace('{query}', encodeURIComponent(query));
    return proxyFeed(context.request, target);
}
