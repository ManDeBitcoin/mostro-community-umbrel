#!/usr/bin/env python3
"""Synthetic HTTPS LND integration checks; no real credentials or nodes.
Usage: python3 scripts/lnd-smoke.py [--image IMAGE]
"""
import argparse
import http.server
import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading

parser = argparse.ArgumentParser()
parser.add_argument('--image')
args = parser.parse_args()
credential = b'synthetic-readonly-test-credential'
mode = 'ok'
seen = []

class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        seen.append(self.path)
        assert self.headers.get('Grpc-Metadata-macaroon') == credential.hex()
        if mode == 'redirect':
            self.send_response(302)
            self.send_header('Location', '/must-not-follow')
            self.end_headers()
            return
        if mode == 'denied' or (mode == 'partial' and self.path == '/v1/balance/channels'):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'private-upstream-error')
            return
        self.send_response(200)
        self.end_headers()
        if mode == 'oversize':
            self.wfile.write(b'x' * (300 * 1024))
            return
        if self.path == '/v1/getinfo':
            response = {'synced_to_chain': mode != 'syncing', 'synced_to_graph': True,
                        'alias': 'Synthetic LND', 'num_active_channels': 2,
                        'chains': [{'chain': 'bitcoin', 'network': 'regtest'}],
                        'identity_pubkey': 'private-upstream-metadata'}
        else:
            response = {'local_balance': {'sat': '9007199254740993'}, 'remote_balance': {'sat': '42'}}
        self.wfile.write(json.dumps(response).encode())

with tempfile.TemporaryDirectory(prefix='mostro-lnd-smoke-') as directory:
    root = Path(directory)
    # Docker runtime uid 1000 needs read-only access to these synthetic fixtures.
    root.chmod(0o755)
    def certificate(name, san):
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
                        '-nodes', '-days', '1', '-subj', '/CN=Synthetic LND',
                        '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'extendedKeyUsage=serverAuth',
                        '-addext', 'subjectAltName=' + san, '-keyout', str(root / (name + '.key')),
                        '-out', str(root / (name + '.cert'))], check=True, capture_output=True)
        (root / (name + '.cert')).chmod(0o644)
    certificate('trusted', 'DNS:localhost,DNS:bridge-test.invalid,IP:127.0.0.1')
    certificate('wrong', 'DNS:wrong.invalid')
    (root / 'readonly.macaroon').write_bytes(credential)
    (root / 'readonly.macaroon').chmod(0o644)
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(root / 'trusted.cert', root / 'trusted.key')
    server.socket = context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    def check(test_mode, expected, cert='trusted.cert', hostname='127.0.0.1', connect_override=False):
        global mode
        mode = test_mode
        seen.clear()
        env = {'LND_REST_URL': f'https://{hostname}:{server.server_port}',
               'LND_TLS_CERT': f'/fixtures/{cert}' if args.image else str(root / cert),
               'LND_READONLY_MACAROON': '/fixtures/readonly.macaroon' if args.image else str(root / 'readonly.macaroon')}
        if connect_override:
            env['LND_CONNECT_HOST'] = f'127.0.0.1:{server.server_port}'
        if args.image:
            command = ['docker', 'run', '--rm', '--network', 'host', '--read-only',
                       '-v', f'{root}:/fixtures:ro']
            for key, value in env.items():
                command += ['-e', f'{key}={value}']
            command += [args.image, 'check-lnd']
        else:
            command = ['./target/debug/mostro-community-api', 'check-lnd']
        result = subprocess.run(command, env={**os.environ, **env}, capture_output=True, text=True, timeout=20)
        assert credential.decode() not in result.stdout + result.stderr
        assert credential.hex() not in result.stdout + result.stderr
        assert 'private-upstream' not in result.stdout + result.stderr
        value = json.loads(result.stdout)
        assert value['status'] == expected, (test_mode, value)
        assert (result.returncode == 0) == (expected in ('online', 'warning'))
        return value
    try:
        value = check('ok', 'online')
        assert value['network'] == 'regtest'
        assert value['liquidity']['local_balance_sats'] == '9007199254740993'
        assert seen == ['/v1/getinfo', '/v1/balance/channels']
        assert check('partial', 'online')['liquidity']['status'] == 'unavailable'
        check('syncing', 'warning')
        check('denied', 'offline')
        check('oversize', 'offline')
        check('redirect', 'offline')
        assert seen == ['/v1/getinfo']
        check('ok', 'offline', cert='wrong.cert')
        assert seen == []  # No credential sent to an untrusted TLS peer.
        check('ok', 'offline', hostname='wronghost.invalid', connect_override=True)
        assert seen == []  # Trusted certificate but hostname mismatch.
        assert check('ok', 'online', hostname='bridge-test.invalid', connect_override=True)['network'] == 'regtest'
        print('LND HTTPS smoke: 9 scenarios passed (TLS, auth, whitelist, private-network resolution, partial data, sync, bounds, redirects).')
    finally:
        server.shutdown()
        server.server_close()
