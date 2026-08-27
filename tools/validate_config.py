"""catalog/ の構造を検証する（CI用）。"""
import json
import os
import re
import sys

CATALOG_DIR = 'catalog'
VALID_TYPES = {'rss', 'html', 'query'}


def load(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def check_source(pack_id, source, seen_ids):
    name = source.get('name')
    for key in ('id', 'name', 'type'):
        assert source.get(key), f'[{pack_id}] ソース "{name}" に {key} がありません'
    source_id = source['id']
    assert re.fullmatch(r'[a-z0-9][a-z0-9-]*', source_id), \
        f'[{pack_id}] ソースID "{source_id}" は英小文字・数字・ハイフンのみ'
    assert source_id not in seen_ids, f'[{pack_id}] ソースID "{source_id}" が重複しています'
    seen_ids.add(source_id)

    assert source['type'] in VALID_TYPES, \
        f'[{pack_id}] ソース "{name}" の type "{source["type"]}" は無効です'
    if source['type'] == 'query':
        assert source.get('query'), f'[{pack_id}] ソース "{name}" に query がありません'
    else:
        assert source.get('url', '').startswith('http'), \
            f'[{pack_id}] ソース "{name}" の url が http(s) で始まっていません'
    if source['type'] == 'html':
        assert source.get('selector'), f'[{pack_id}] ソース "{name}" に selector がありません'
    for key in ('include', 'exclude'):
        if key in source:
            try:
                re.compile(source[key])
            except re.error as exc:
                raise AssertionError(
                    f'[{pack_id}] ソース "{name}" の {key} が正規表現として不正です: {exc}')


def main():
    index = load(os.path.join(CATALOG_DIR, 'index.json'))
    print('✓ catalog/index.json is valid JSON')

    packs = index.get('packs')
    assert packs, 'catalog/index.json に packs がありません'

    pack_ids = set()
    orders = []
    defaults = 0
    total_sources = 0

    for meta in packs:
        for key in ('id', 'name', 'order'):
            assert key in meta, f'パック "{meta.get("id")}" に {key} がありません'
        pack_id = meta['id']
        assert re.fullmatch(r'[a-z0-9][a-z0-9-]*', pack_id), \
            f'パックID "{pack_id}" は英小文字・数字・ハイフンのみ'
        assert pack_id not in pack_ids, f'パックID "{pack_id}" が重複しています'
        pack_ids.add(pack_id)
        orders.append(meta['order'])
        if meta.get('default'):
            defaults += 1

        path = os.path.join(CATALOG_DIR, 'packs', f'{pack_id}.json')
        assert os.path.exists(path), f'パック "{pack_id}" の定義ファイルがありません: {path}'
        body = load(path)
        assert body.get('id') == pack_id, f'{path} の id が "{pack_id}" と一致しません'

        sources = body.get('sources') or []
        assert sources, f'パック "{pack_id}" にソースが1つもありません'
        seen_ids = set()
        for source in sources:
            check_source(pack_id, source, seen_ids)
        total_sources += len(sources)

        for interest in body.get('suggested_interests', []):
            assert interest.get('word'), f'[{pack_id}] suggested_interests に word がありません'
            assert isinstance(interest.get('weight', 1.0), (int, float)), \
                f'[{pack_id}] "{interest.get("word")}" の weight が数値ではありません'

    assert len(orders) == len(set(orders)), 'パックの order が重複しています'
    assert defaults, '既定で購読されるパック（"default": true）が1つもありません'

    extra = set()
    for name in os.listdir(os.path.join(CATALOG_DIR, 'packs')):
        if name.endswith('.json') and name[:-5] not in pack_ids:
            extra.add(name)
    assert not extra, f'index.json に載っていないパック定義があります: {sorted(extra)}'

    print(f'✓ All {len(pack_ids)} packs are valid ({defaults} default)')
    print(f'✓ All {total_sources} sources are valid')


if __name__ == '__main__':
    try:
        main()
    except AssertionError as exc:
        print(f'✗ {exc}')
        sys.exit(1)
