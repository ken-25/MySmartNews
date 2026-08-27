/* GET /api/feed?url=<RSSのURL>
 *
 * ユーザーが自分で追加したRSSを中継する。引数なしなら 400 を返す。
 * フロントはこの 400 と 404 の違いで「Functions が動いているか」を判定する。
 */
import { checkTarget, fail, proxyFeed } from './_shared.js';

export async function onRequestGet(context) {
    const target = new URL(context.request.url).searchParams.get('url');
    if (!target) {
        return fail('url パラメータが必要です', 400);
    }
    const problem = checkTarget(target);
    if (problem) {
        return fail(problem, 400);
    }
    return proxyFeed(context.request, target);
}
