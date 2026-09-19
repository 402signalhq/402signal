"""Skip an immutable MCP version only when its active metadata matches exactly."""
import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

REGISTRY = "https://registry.modelcontextprotocol.io/v0.1/servers"
MAX_RESPONSE_BYTES = 1_048_576


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise ValueError("Registry lookup redirected; refusing to trust another endpoint")


def publication_needed(manifest, opener=None):
    name, version = manifest.get("name"), manifest.get("version")
    if not isinstance(name, str) or not name or not isinstance(version, str) or not version:
        raise ValueError("Manifest must include a name and version")
    url = f"{REGISTRY}/{urllib.parse.quote(name, safe='')}/versions/{urllib.parse.quote(version, safe='')}"
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    opener = opener or urllib.request.build_opener(NoRedirect())
    try:
        with opener.open(request, timeout=30) as response:
            if response.status != 200:
                raise ValueError("Unexpected registry lookup status")
            payload = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return True
        raise
    if len(payload) > MAX_RESPONSE_BYTES:
        raise ValueError("Registry response exceeded size limit")
    entry = json.loads(payload)
    official = entry.get("_meta", {}).get("io.modelcontextprotocol.registry/official", {})
    if entry.get("server") != manifest or official.get("status") != "active":
        raise ValueError("Existing immutable version differs or is inactive; review metadata and publish a new version")
    return False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest")
    args = parser.parse_args()
    try:
        with open(args.manifest, encoding="utf-8") as source:
            needed = publication_needed(json.load(source))
    except (OSError, ValueError, TypeError, AttributeError) as error:
        print(f"MCP registry preflight failed: {error}", file=sys.stderr)
        return 1
    print("publish=true" if needed else "publish=false")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
