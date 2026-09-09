"""Run the unchanged fixture suite and print bounded failure diagnostics.

The full combined output stays in the runner's temporary directory. This avoids
huge HTML assertion values hiding the traceback and final result in CI readers.
No test is filtered, skipped or converted to success by this wrapper.
"""
from __future__ import annotations
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile


def main() -> int:
    directory = Path(os.environ.get("RUNNER_TEMP") or tempfile.gettempdir())
    fd, name = tempfile.mkstemp(prefix="402signal-fixture-tests-", suffix=".log", dir=directory)
    with os.fdopen(fd, "wb") as output:
        completed = subprocess.run(
            [sys.executable, "-m", "unittest", "discover", "-s", "tests"],
            stdout=output, stderr=subprocess.STDOUT, check=False,
        )
    text = Path(name).read_text(encoding="utf-8", errors="replace")
    print("Fixture command: python -m unittest discover -s tests")
    print("Complete runner-local log:", name)
    blocks = re.findall(r"^(?:FAIL|ERROR): .*?(?=^={20,}|^Ran \d+ tests|\Z)", text, flags=re.M | re.S)
    for block in blocks[:20]:
        print("\n" + "=" * 60)
        budget = 7000
        for line in block.splitlines():
            if line and set(line) == {"-"}:
                continue
            rendered = line if len(line) <= 1400 else line[:1400] + " [long assertion value omitted; see full log]"
            if len(rendered) > budget:
                print("[remaining failure output omitted; see full log]")
                break
            print(rendered)
            budget -= len(rendered)
    if len(blocks) > 20:
        print("Additional failure blocks in full log:", len(blocks) - 20)
    if not blocks and completed.returncode:
        print("No standard unittest failure block; last output lines:")
        for line in text.splitlines()[-35:]:
            print(line[:1400])
    for line in text.splitlines():
        if re.match(r"^(Ran \d+ tests|FAILED \(|OK(?: \(|$))", line):
            print(line[:1000])
    print("Fixture process exit status:", completed.returncode)
    return completed.returncode if completed.returncode >= 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
