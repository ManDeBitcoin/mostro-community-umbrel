"""The panel and the API agree on the codes of the daemon notices.

The panel decides by code which page each notice of `/api/daemon/status`
belongs to. A code it does not know falls back to a generic title, so adding
one on the server without teaching it to the panel has to fail here. The Rust
tests cannot check this: CI runs them inside the image build, where `web/`
does not exist.
"""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class NoticeCodeTests(unittest.TestCase):
    def setUp(self):
        daemon = (ROOT / "api/src/daemon.rs").read_text()
        declared = re.search(r"pub const NOTICE_CODES: &\[&str\] = &\[(.*?)\];", daemon, re.S)
        self.assertIsNotNone(declared, "NOTICE_CODES not found in api/src/daemon.rs")
        self.declared = re.findall(r'"([a-z_]+)"', declared.group(1))
        self.emitted = set(re.findall(r'DaemonNotice::new\(\s*"([a-z_]+)"', daemon))

        overview = (ROOT / "web/src/lib/overview.ts").read_text()
        routes = re.search(r"const NOTICE_ROUTES: Record<string, NoticeRoute> = \{(.*?)\n\};", overview, re.S)
        self.assertIsNotNone(routes, "NOTICE_ROUTES not found in web/src/lib/overview.ts")
        self.routed = set(re.findall(r"^\s*([a-z_]+): \{", routes.group(1), re.M))

    def test_the_server_declares_every_code_it_emits(self):
        self.assertEqual(len(self.declared), len(set(self.declared)), "duplicated code")
        self.assertEqual(self.emitted, set(self.declared))

    def test_the_panel_knows_where_every_code_belongs(self):
        self.assertEqual(self.routed, set(self.declared))


if __name__ == "__main__":
    unittest.main()
