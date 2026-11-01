"""Stira Stage と Stira Forest で共有するソースを揃える(開発用)。

共有するもの(正本は Forest 側):
  backend/sanitize.py   秘密のマスク、短い欄の1行化、DATA_NOTICE

使い方:
  python tools/sync_shared.py <Forest のリポジトリ>          # 差があれば止まる(終了コード 1)
  python tools/sync_shared.py <Forest のリポジトリ> --write  # Forest の版をこちらに写す

2つのアプリは別々に配布するので、共有は「同じ内容のファイルを両方に持つ」形にする
(片方がもう片方を import しない)。どちらかで直したら、Forest 側を正本として揃える。
"""

from __future__ import annotations

import hashlib
import shutil
import sys
from pathlib import Path

SHARED = ["backend/sanitize.py"]
HERE = Path(__file__).resolve().parents[1]


def digest(p: Path) -> str:
    # 改行の違い(CRLF / LF)は差として扱わない
    return hashlib.sha256(p.read_bytes().replace(b"\r\n", b"\n")).hexdigest()


def main(argv: list[str]) -> int:
    if not argv:
        print(__doc__)
        return 2
    forest = Path(argv[0]).resolve()
    write = "--write" in argv[1:]
    bad = 0
    for rel in SHARED:
        src, dst = forest / rel, HERE / rel
        if not src.is_file():
            print(f"Forest 側に無い: {src}")
            return 2
        if dst.is_file() and digest(src) == digest(dst):
            print(f"同じ: {rel}")
            continue
        if write:
            shutil.copyfile(src, dst)
            print(f"写した: {rel}")
        else:
            print(f"違う: {rel}(--write で Forest の版に揃える)")
            bad += 1
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
