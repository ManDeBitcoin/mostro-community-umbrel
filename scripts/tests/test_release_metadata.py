import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_metadata import COMPOSE, MANIFEST, README, current_version, plan_promotion  # noqa: E402


class ReleaseMetadataTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        source = Path(__file__).resolve().parents[2]
        self.current = current_version(source)
        major, minor, patch = (int(part) for part in self.current.split("."))
        self.next_version = f"{major}.{minor}.{patch + 1}"
        for relative in (COMPOSE, MANIFEST, README):
            target = self.root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes((source / relative).read_bytes())
        self.notes = self.root / "release-notes.md"
        self.notes.write_text(f"# Mostro Community Manager v{self.next_version}\n\n- Actualización de prueba.\n")

    def test_plan_changes_all_store_references_after_validation(self):
        planned = plan_promotion(self.root, self.next_version, self.current, self.notes)
        self.assertIn(f"version: {self.next_version}\n", planned[MANIFEST])
        self.assertIn(f"Versión {self.next_version}\n", planned[MANIFEST])
        self.assertNotIn(f"ghcr.io/mandebitcoin/mostro-community-umbrel:{self.current}", planned[COMPOSE])
        self.assertEqual(planned[COMPOSE].count(f"ghcr.io/mandebitcoin/mostro-community-umbrel:{self.next_version}"), 4)
        self.assertIn(f"Versión del manifiesto de Umbrel: {self.next_version}.", planned[README])

    def test_rejects_store_version_changed_during_build(self):
        with self.assertRaisesRegex(ValueError, "Store version changed"):
            plan_promotion(self.root, self.next_version, "0.0.0", self.notes)

    def test_rejects_one_service_on_different_image(self):
        compose = (self.root / COMPOSE).read_text()
        (self.root / COMPOSE).write_text(compose.replace(f":{self.current}", ":0.0.0", 1))
        with self.assertRaisesRegex(ValueError, "All four Umbrel services"):
            plan_promotion(self.root, self.next_version, self.current, self.notes)

    def test_rejects_notes_for_another_release(self):
        self.notes.write_text("# Mostro Community Manager v0.0.0\n\n- Otra versión.\n")
        with self.assertRaisesRegex(ValueError, "Release notes must start"):
            plan_promotion(self.root, self.next_version, self.current, self.notes)


if __name__ == "__main__":
    unittest.main()
