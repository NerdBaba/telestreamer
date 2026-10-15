#!/usr/bin/env python3
"""Offline Telethon SQLite export; never connects to Telegram. Run at cutover."""
import argparse
import base64
import json
import os
from pathlib import Path
import sqlite3


def export(source, destination):
    # SQLite's read-only URI preserves the original session and its schema.
    with sqlite3.connect(source.resolve().as_uri() + '?mode=ro', uri=True) as db:
        rows = db.execute('SELECT dc_id, server_address, port, auth_key FROM sessions').fetchall()
    if len(rows) != 1 or len(rows[0][3] or b'') != 256:
        raise ValueError('Expected one authorized session')
    dc, address, port, key = rows[0]
    payload = {'dc_id': dc, 'server_address': address, 'port': port,
               'auth_key': base64.b64encode(key).decode('ascii')}
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(descriptor, 'w') as output:
        json.dump(payload, output)
        output.flush()
        os.fsync(output.fileno())


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('destination', type=Path)
    parser.add_argument('--previous-holder-stopped', action='store_true', required=True)
    args = parser.parse_args()
    export(args.source, args.destination)
    print('Offline export complete. Protect both files as credentials.')
