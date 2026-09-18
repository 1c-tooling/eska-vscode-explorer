#!/usr/bin/env python3
"""Verify the actual VSIX payload, not only the packaging ignore rules."""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET
import zipfile


def check(archive):
    """Reject missing runtime assets, accidental source/dependency inclusion and mismatched identity."""
    root = Path(__file__).resolve().parents[1]
    manifest = json.loads((root / 'package.json').read_text())
    with zipfile.ZipFile(archive) as package:
        names = package.namelist()
        assert len(names) == len(set(names)), 'Duplicate ZIP entries'
        assert package.testzip() is None, 'Invalid ZIP CRC'
        identity = ET.fromstring(package.read('extension.vsixmanifest')).find('.//{*}Identity')
        assert identity.attrib['Publisher'] == manifest['publisher']
        assert identity.attrib['Id'] == manifest['name']
        assert identity.attrib['Version'] == manifest['version']
        shipped = json.loads(package.read('extension/package.json'))
        assert all(shipped.get(key) == value for key, value in manifest.items()), 'Packaged manifest differs'
        required = ['package.json', 'package.nls.json', 'package.nls.ru.json', 'README.md', 'CHANGELOG.md', 'LICENSE']
        required += [path.relative_to(root).as_posix() for pattern in ['out/*.js', 'resources/icons/**/*.svg', 'docs/*.md', 'docs/measurements/*.json'] for path in root.glob(pattern)]
        # vsce publishes a LICENSE without an extension as LICENSE.txt.
        packaged = {name: 'extension/' + ('LICENSE.txt' if name == 'LICENSE' else name) for name in required}
        expected = set(packaged.values()) | {'extension.vsixmanifest', '[Content_Types].xml'}
        assert {name.lower() for name in names} == {name.lower() for name in expected}, 'Unexpected or missing archive files'
        assert len([name for name in names if name.endswith('.svg')]) == 192
        # vsce may normalize README/CHANGELOG names and augment package.json metadata.
        normalized = {name.lower(): name for name in names}
        for name in required:
            if name != 'package.json':
                assert package.read(normalized[packaged[name].lower()]) == (root / name).read_bytes(), name
        assert package.read('extension/' + manifest['main'].removeprefix('./'))
    print(f'VSIX verified: {manifest["publisher"]}.{manifest["name"]}@{manifest["version"]}; {len(names)} files')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('archive', type=Path)
    check(parser.parse_args().archive)
