#!/usr/bin/env python3
"""Keep the Umbrel store on a public image until a release is fully published."""

import argparse
import re
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
MANIFEST = Path("mandebitcoin-mostro-manager/umbrel-app.yml")
COMPOSE = Path("mandebitcoin-mostro-manager/docker-compose.yml")
README = Path("README.md")
IMAGE = "ghcr.io/mandebitcoin/mostro-community-umbrel"
VERSION = re.compile(r"\d+\.\d+\.\d+")


def parse_version(value: str) -> tuple[int, int, int]:
    if not VERSION.fullmatch(value):
        raise ValueError(f"Invalid release version: {value}")
    return tuple(int(part) for part in value.split("."))


def current_version(root: Path = ROOT) -> str:
    manifest = (root / MANIFEST).read_text()
    matches = re.findall(r"(?m)^version: (\d+\.\d+\.\d+)$", manifest)
    if len(matches) != 1:
        raise ValueError("Umbrel manifest must have exactly one version field")
    return matches[0]


def assert_compose_version(root: Path, version: str) -> None:
    compose = (root / COMPOSE).read_text()
    images = re.findall(r"(?m)^\s+image: " + re.escape(IMAGE) + r":([^\s]+)$", compose)
    if len(images) != 4 or any(image != version for image in images):
        raise ValueError(f"All four Umbrel services must use image {version}; found {images}")


def verify_image(version: str) -> None:
    subprocess.run(["python3", str(ROOT / "scripts/verify-public-image.py"), version], check=True)


def plan_promotion(root: Path, new_version: str, expected_current: str, notes_file: Path) -> dict[Path, str]:
    if parse_version(new_version) <= parse_version(expected_current):
        raise ValueError("The new version must be greater than the installed store version")
    actual = current_version(root)
    if actual != expected_current:
        raise ValueError(f"Store version changed during release: expected {expected_current}, found {actual}")
    assert_compose_version(root, expected_current)

    notes = notes_file.read_text().strip()
    if not notes.startswith(f"# Mostro Community Manager v{new_version}\n"):
        raise ValueError(f"Release notes must start with the v{new_version} heading")
    notes_body = notes.split("\n", 1)[1].strip()
    if not notes_body:
        raise ValueError("Release notes must describe the update")

    manifest = (root / MANIFEST).read_text()
    manifest = manifest.replace(f"version: {expected_current}\n", f"version: {new_version}\n", 1)
    lines = manifest.splitlines(keepends=True)
    start = next((i for i, line in enumerate(lines) if line.startswith("releaseNotes:")), None)
    if start is None:
        raise ValueError("Umbrel manifest has no releaseNotes field")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].strip() and not lines[i].startswith(" ")), len(lines))
    release_notes = f"Versión {new_version}\n\n{notes_body}"
    block = "releaseNotes: |-\n" + "".join(f"  {line}\n" for line in release_notes.splitlines())
    manifest = "".join(lines[:start]) + block + "".join(lines[end:])

    compose = (root / COMPOSE).read_text()
    compose = compose.replace(f"{IMAGE}:{expected_current}", f"{IMAGE}:{new_version}")

    readme = (root / README).read_text()
    old_header = f"Versión del manifiesto de Umbrel: {expected_current}."
    old_install = f"Comprobar que la ficha muestre **{expected_current}**"
    if readme.count(old_header) != 1 or readme.count(old_install) != 1:
        raise ValueError("README must state the current store version in its header and install steps")
    readme = readme.replace(old_header, f"Versión del manifiesto de Umbrel: {new_version}.")
    readme = readme.replace(old_install, f"Comprobar que la ficha muestre **{new_version}**")
    return {MANIFEST: manifest, COMPOSE: compose, README: readme}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("check-candidate", "check-store", "promote"))
    parser.add_argument("version", nargs="?", help="Release tag, for example v1.0.5")
    parser.add_argument("--expected-current", help="Store version captured from the release tag")
    parser.add_argument("--notes-file", type=Path, default=ROOT / "docs/release-notes.md")
    args = parser.parse_args()

    current = current_version()
    assert_compose_version(ROOT, current)
    if args.command == "check-store":
        verify_image(current)
        print(f"Umbrel store version {current} has a public multi-architecture image")
        return

    if not args.version or not args.version.startswith("v"):
        parser.error("A v-prefixed release tag is required")
    new_version = args.version[1:]
    expected = args.expected_current or current
    plan = plan_promotion(ROOT, new_version, expected, args.notes_file)
    if args.command == "check-candidate":
        verify_image(current)
        print(f"Release v{new_version} is staged; Umbrel store remains on public image {current}")
        return

    # This check is repeated here so calling the promotion script directly cannot
    # expose a tag that GHCR does not serve to anonymous amd64 and arm64 clients.
    verify_image(new_version)
    for relative_path, content in plan.items():
        (ROOT / relative_path).write_text(content)
    print(f"Promoted Umbrel store from {expected} to verified image {new_version}")


if __name__ == "__main__":
    main()
