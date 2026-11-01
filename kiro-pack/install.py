"""Stira kiro-pack の導入(KiroCrew をカスタマイズする人向け)。

入れるもの:
  steering/<lang>/*.md  → ~/.kiro/steering/          (全セッションで読まれる規則)
  skills/*/SKILL.md     → <KIROCREW_HOME>/skills/<名前>/ (必要なときに読む手順)
  hooks/stira_narrative_hook.py は動かす場所に置くだけ。hook の登録はダッシュボードの
  Customize → Hooks で行う(gateway が hooks.json を持っているので、ここでは書かない)。

使い方:
  <KiroCrew 同梱 python> -s kiro-pack/install.py [--lang ja|en] [--dry-run] [--force]
既にあるファイルは上書きしない(--force で上書き。元は .bak に残す)。
"""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

PACK = Path(__file__).resolve().parent


def crew_home() -> Path:
    env = os.environ.get("KIROCREW_HOME")
    return Path(env) if env else Path.home() / ".kiro" / "crew"


def plan(lang: str) -> list[tuple[Path, Path]]:
    steering_home = Path.home() / ".kiro" / "steering"
    out = [(p, steering_home / p.name) for p in sorted((PACK / "steering" / lang).glob("*.md"))]
    for skill in sorted((PACK / "skills").glob("*/SKILL.md")):
        out.append((skill, crew_home() / "skills" / skill.parent.name / "SKILL.md"))
    hook = PACK / "hooks" / "stira_narrative_hook.py"
    out.append((hook, crew_home() / "hooks" / "stira" / hook.name))
    return out


def hook_command(target: Path) -> str:
    py = Path(sys.executable)
    if os.name == "nt":
        return f'"{py}" -s -P "{target}"'
    return f"'{py}' -s -P '{target}'"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--lang", choices=("ja", "en"), default="ja")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--force", action="store_true")
    a = ap.parse_args(argv)
    hook_target = None
    for src, dst in plan(a.lang):
        if dst.name == "stira_narrative_hook.py":
            hook_target = dst
        state = "既にある(そのまま)" if dst.exists() and not a.force else "入れる"
        if dst.exists() and a.force:
            state = "上書き(.bak を残す)"
        print(f"{state}: {dst}")
        if dst.is_symlink():
            print(f"  シンボリックリンクなので触らない: {dst}")
            continue
        if a.dry_run or (dst.exists() and not a.force):
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        if dst.exists():
            shutil.copy2(dst, dst.with_name(dst.name + ".bak"))
        shutil.copy2(src, dst)
    print()
    print("次に、ダッシュボードの Customize → Hooks → New hook で登録する:")
    print("  Event   : UserPromptSubmit")
    print("  Matcher : (空)")
    print("  Timeout : 10")
    print(f"  Command : {hook_command(hook_target or Path('<hook の場所>'))}")
    print("steering は次の新しいセッションから効く。00-core-principles.md の「芯」の節は自分のミッションに書き換える。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
