#!/usr/bin/env python3
"""Check GHCR without Docker login or a GitHub credential. Never print bearer tokens."""
import hashlib
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

REPOSITORY = "mandebitcoin/mostro-community-umbrel"
BASE = f"https://ghcr.io/v2/{REPOSITORY}"
ACCEPT = ", ".join([
    "application/vnd.oci.image.index.v1+json",
    "application/vnd.docker.distribution.manifest.list.v2+json",
    "application/vnd.oci.image.manifest.v1+json",
    "application/vnd.docker.distribution.manifest.v2+json",
])


def verify(reference):
    query = urllib.parse.urlencode({"service": "ghcr.io", "scope": f"repository:{REPOSITORY}:pull"})
    with urllib.request.urlopen("https://ghcr.io/token?" + query, timeout=30) as response:
        token = json.load(response)["token"]

    def fetch(path, method="GET"):
        request = urllib.request.Request(BASE + path, method=method, headers={"Authorization": "Bearer " + token, "Accept": ACCEPT})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read(), response.headers

    body, headers = fetch("/manifests/" + reference)
    digest = "sha256:" + hashlib.sha256(body).hexdigest()
    assert headers.get("Docker-Content-Digest") == digest, "Manifest digest mismatch"
    fetch("/manifests/" + reference, "HEAD")
    root = json.loads(body)
    architectures = []
    for descriptor in root["manifests"]:
        platform = descriptor.get("platform", {})
        if platform.get("os") != "linux" or platform.get("architecture") not in ("amd64", "arm64"):
            continue
        manifest_body, _ = fetch("/manifests/" + descriptor["digest"])
        assert "sha256:" + hashlib.sha256(manifest_body).hexdigest() == descriptor["digest"]
        manifest = json.loads(manifest_body)
        fetch("/blobs/" + manifest["config"]["digest"])
        for layer in manifest["layers"]:
            fetch("/blobs/" + layer["digest"], "HEAD")
        architectures.append(platform["architecture"])
    assert sorted(architectures) == ["amd64", "arm64"], "Both Linux architectures must be available"
    print(json.dumps({"image": f"ghcr.io/{REPOSITORY}:{reference}", "digest": digest, "architectures": architectures, "anonymous_access": True}))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("Usage: verify-public-image.py TAG_OR_DIGEST")
    try:
        verify(sys.argv[1])
    except urllib.error.HTTPError as error:
        sys.exit(f"Anonymous GHCR access failed: HTTP {error.code}. Check that the image exists and the package visibility is Public: https://github.com/users/ManDeBitcoin/packages/container/mostro-community-umbrel/settings")
