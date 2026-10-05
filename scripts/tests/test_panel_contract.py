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

# Lowercase words joined by underscores; a word may carry digits.
CODE = r"[a-z0-9_]+"


def declared_codes(daemon):
    """The codes listed in `NOTICE_CODES`, or None when the list is not found."""
    declared = re.search(r"pub const NOTICE_CODES: &\[&str\] = &\[(.*?)\];", daemon, re.S)
    return None if declared is None else re.findall(rf'"({CODE})"', declared.group(1))


def emitted_codes(daemon):
    """The literal code of every `DaemonNotice::new(` call, and how many calls there are."""
    literals = re.findall(rf'DaemonNotice::new\(\s*"({CODE})"', daemon)
    return literals, len(re.findall(r"DaemonNotice::new\(", daemon))


def routed_codes(overview):
    """The keys of `NOTICE_ROUTES`, or None when the table is not found."""
    routes = re.search(r"const NOTICE_ROUTES: Record<string, NoticeRoute> = \{(.*?)\n\};", overview, re.S)
    return None if routes is None else re.findall(rf"^\s*({CODE}): \{{", routes.group(1), re.M)


class NoticeCodeTests(unittest.TestCase):
    def setUp(self):
        daemon = (ROOT / "api/src/daemon.rs").read_text()
        self.declared = declared_codes(daemon)
        self.assertIsNotNone(self.declared, "NOTICE_CODES not found in api/src/daemon.rs")
        self.emitted, self.calls = emitted_codes(daemon)

        self.routed = routed_codes((ROOT / "web/src/lib/overview.ts").read_text())
        self.assertIsNotNone(self.routed, "NOTICE_ROUTES not found in web/src/lib/overview.ts")

    def test_every_notice_is_built_with_a_code_this_test_can_read(self):
        # A code built at run time, or one written in a way the pattern does
        # not match, would slip past the two comparisons below.
        self.assertGreater(self.calls, 0)
        self.assertEqual(self.calls, len(self.emitted))

    def test_the_server_declares_every_code_it_emits(self):
        self.assertEqual(len(self.declared), len(set(self.declared)), "duplicated code")
        self.assertEqual(set(self.emitted), set(self.declared))

    def test_the_panel_knows_where_every_code_belongs(self):
        self.assertEqual(len(self.routed), len(set(self.routed)), "duplicated route")
        self.assertEqual(set(self.routed), set(self.declared))


class ReadingTheSourcesTests(unittest.TestCase):
    """The comparison is only as good as what it reads from the two files."""

    DAEMON = """
        pub const NOTICE_CODES: &[&str] = &[
            "rules_missing",
            "lnd_v2_unreadable",
        ];
        notices.push(DaemonNotice::new("rules_missing", "Faltan las reglas."));
        notices.push(DaemonNotice::new(
            "lnd_v2_unreadable",
            "El panel no pudo leer LND.",
        ));
    """
    OVERVIEW = """
const NOTICE_ROUTES: Record<string, NoticeRoute> = {
  rules_missing: { title: 'Faltan las reglas', page: 'config', action: 'Abrir' },
  lnd_v2_unreadable: { title: 'Sin lectura', page: 'lightning', action: 'Ver' },
};
"""

    def test_a_code_with_a_digit_is_read_on_both_sides(self):
        codes = ["rules_missing", "lnd_v2_unreadable"]
        self.assertEqual(declared_codes(self.DAEMON), codes)
        self.assertEqual(emitted_codes(self.DAEMON), (codes, 2))
        self.assertEqual(routed_codes(self.OVERVIEW), codes)

    def test_a_notice_without_a_literal_code_is_counted(self):
        daemon = self.DAEMON + "notices.push(DaemonNotice::new(code_for(&probe), text));"
        literals, calls = emitted_codes(daemon)
        self.assertEqual(calls, len(literals) + 1)

    def test_a_missing_list_is_not_an_empty_one(self):
        self.assertIsNone(declared_codes("const OTHER: &[&str] = &[];"))
        self.assertIsNone(routed_codes("const OTHER = {};"))


if __name__ == "__main__":
    unittest.main()
