"""sites.json の構造を検証する（CI用）。"""
import json
import re
import sys

VALID_SITE_TYPES = {'rss', 'html'}
VALID_DISCOVERY_TYPES = {'rss', 'keyword'}


def main():
    with open('sites.json', 'r', encoding='utf-8') as f:
        config = json.load(f)
    print('✓ sites.json is valid JSON')

    assert 'categories' in config, 'Missing categories key'
    assert 'sites' in config, 'Missing sites key'
    print('✓ Required keys exist')

    category_ids = set()
    for category in config['categories']:
        for key in ('id', 'name', 'order'):
            assert key in category, f'Category missing {key}'
        category_ids.add(category['id'])
    print(f"✓ All {len(config['categories'])} categories are valid")

    for site in config['sites']:
        name = site.get('name')
        for key in ('name', 'url', 'type'):
            assert key in site, f'Site "{name}" missing {key}'
        assert site['type'] in VALID_SITE_TYPES, f'Invalid type for site "{name}"'
        if site['type'] == 'html':
            assert 'selector' in site, f'HTML site "{name}" missing selector'
        for key in ('include', 'exclude'):
            if key in site:
                try:
                    re.compile(site[key])
                except re.error as exc:
                    raise AssertionError(f'Site "{name}" has an invalid {key} pattern: {exc}')
        category_id = site.get('category_id')
        assert not category_id or category_id in category_ids, \
            f'Site "{name}" references unknown category_id "{category_id}"'
    print(f"✓ All {len(config['sites'])} sites are valid")

    for interest in config.get('interests', []):
        assert interest.get('word'), 'Interest missing word'
        assert isinstance(interest.get('weight', 1.0), (int, float)), \
            f"Interest \"{interest.get('word')}\" has a non-numeric weight"
    print(f"✓ All {len(config.get('interests', []))} interests are valid")

    for source in config.get('discovery', []):
        name = source.get('name')
        assert name, 'Discovery source missing name'
        assert source.get('type') in VALID_DISCOVERY_TYPES, \
            f'Invalid type for discovery source "{name}"'
        if source['type'] == 'keyword':
            assert source.get('query'), f'Keyword source "{name}" missing query'
        else:
            assert source.get('url'), f'Discovery source "{name}" missing url'
    print(f"✓ All {len(config.get('discovery', []))} discovery sources are valid")


if __name__ == '__main__':
    try:
        main()
    except AssertionError as exc:
        print(f'✗ {exc}')
        sys.exit(1)
