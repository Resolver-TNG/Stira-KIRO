"""Local Git repositories shown on the Stage workbench.

Local probes are read-only.  The one explicit network operation is ``fetch_repository``:
it accepts only a discovered repository id and runs exactly ``git fetch --prune --quiet origin``.
The HTTP routes stay thin so this logic can be tested without importing KiroCrew packages.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Mapping, Sequence
from urllib.parse import urlsplit, urlunsplit

from .sanitize import clean_field, redact
from .shelf import crew_home

DEFAULT_CONFIG: dict[str, Any] = {"paths": [], "scanRoots": [], "scanDepth": 1, "dashboardBot": ""}
MAX_PATHS = 200
MAX_PATH_LENGTH = 1024
MAX_DASHBOARD_BOT_LENGTH = 64
DASHBOARD_BOT_RE = re.compile(r"^[a-z0-9_-]+$")
GIT_TIMEOUT = 10
FETCH_TIMEOUT = 60
STATUS_TTL = 300.0
MAX_ERROR_LENGTH = 240
MAX_FETCHES = 2

Runner = Callable[..., subprocess.CompletedProcess[str]]


class ConfigError(ValueError):
    """The repository configuration JSON shape is not valid."""


class ConfigPathError(ValueError):
    """One or more configured paths are unsafe or unusable."""

    def __init__(self, problems: list[dict[str, Any]]) -> None:
        super().__init__("one or more repository paths were rejected")
        self.problems = problems


class GitProbeError(RuntimeError):
    """One local Git probe could not complete."""


class RepositoryNotFound(LookupError):
    """A caller supplied an id that is not in the current repository discovery result."""


class FetchConflict(RuntimeError):
    """A fetch cannot start because the repository has no origin or a fetch slot is busy."""

    def __init__(self, message: str, payload: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.payload = payload


class FetchFailed(RuntimeError):
    """The allowed fetch command failed; payload is the freshly re-read local state."""

    def __init__(self, message: str, payload: dict[str, Any]) -> None:
        super().__init__(message)
        self.payload = payload


def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def config_path(home: Path | None = None) -> Path:
    return (home or crew_home()) / "workspace" / "memory" / "stira" / "repos.json"


def _dashboard_bot_reason(value: Any) -> str | None:
    if not isinstance(value, str):
        return "dashboardBot must be a string"
    if len(value) > MAX_DASHBOARD_BOT_LENGTH:
        return f"dashboardBot must be at most {MAX_DASHBOARD_BOT_LENGTH} characters"
    if value and not DASHBOARD_BOT_RE.fullmatch(value):
        return "dashboardBot must contain only lowercase letters, digits, hyphens, and underscores"
    return None


def _shape_config(value: Any, *, check_dashboard_bot: bool) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ConfigError("config must be a JSON object")
    out: dict[str, Any] = {}
    for key in ("paths", "scanRoots"):
        items = value.get(key)
        if not isinstance(items, list):
            raise ConfigError(f"{key} must be an array of strings")
        if len(items) > MAX_PATHS:
            raise ConfigError(f"{key} must contain at most {MAX_PATHS} paths")
        copied = []
        for item in items:
            if not isinstance(item, str):
                raise ConfigError(f"{key} must be an array of strings")
            if len(item) > MAX_PATH_LENGTH:
                raise ConfigError(f"each {key} path must be at most {MAX_PATH_LENGTH} characters")
            if not item or "\x00" in item:
                raise ConfigError(f"{key} contains an invalid path")
            copied.append(item)
        out[key] = copied
    depth = value.get("scanDepth")
    if isinstance(depth, bool) or depth != 1:
        raise ConfigError("scanDepth must be 1")
    out["scanDepth"] = 1
    dashboard_bot = value.get("dashboardBot", "")
    reason = _dashboard_bot_reason(dashboard_bot)
    if check_dashboard_bot and reason:
        raise ConfigError(reason)
    out["dashboardBot"] = dashboard_bot
    return out


def validate_config(value: Any) -> dict[str, Any]:
    """Validate and copy the complete JSON shape accepted by PUT /repos/config."""
    return _shape_config(value, check_dashboard_bot=True)


def normalize_config_path(value: str) -> str:
    """Trim a pasted path, including the quotes added by Windows "Copy as path"."""
    text = value.strip()
    if len(text) >= 2 and text.startswith('"') and text.endswith('"'):
        text = text[1:-1].strip()
    return text


def _is_network_path(value: str) -> bool:
    normalized = value.replace("/", "\\")
    folded = normalized.casefold()
    return normalized.startswith("\\\\") or folded.startswith("\\\\?\\unc\\")


def inspect_config_paths(value: Any) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Normalize and inspect every path without writing configuration.

    Problems retain the submitted array index so the picker can show each reason beside
    the matching row. Duplicate paths are removed independently within each field.
    """
    shaped = _shape_config(value, check_dashboard_bot=False)
    dashboard_reason = _dashboard_bot_reason(shaped["dashboardBot"])
    normalized: dict[str, Any] = {
        "paths": [],
        "scanRoots": [],
        "scanDepth": 1,
        "dashboardBot": shaped["dashboardBot"] if dashboard_reason is None else "",
    }
    problems: list[dict[str, Any]] = []
    if dashboard_reason:
        problems.append({"field": "dashboardBot", "index": 0, "reason": dashboard_reason})

    for field in ("paths", "scanRoots"):
        seen: set[str] = set()
        for index, submitted in enumerate(shaped[field]):
            display = normalize_config_path(submitted)
            problem = {"field": field, "index": index, "path": display}
            if not display:
                problems.append({**problem, "reason": "path is empty"})
                continue
            if _is_network_path(display):
                problems.append({
                    **problem,
                    "reason": "network paths are not allowed because checking them may block",
                })
                continue
            try:
                path = Path(display).expanduser()
            except (OSError, RuntimeError) as err:
                problems.append({**problem, "reason": f"could not expand the path: {_error_text(str(err))}"})
                continue
            expanded = str(path)
            problem["path"] = expanded
            if _is_network_path(expanded):
                problems.append({
                    **problem,
                    "reason": "network paths are not allowed because checking them may block",
                })
                continue
            if not path.is_absolute():
                problems.append({**problem, "reason": "path must be absolute"})
                continue
            key = os.path.normpath(expanded).casefold()
            if key in seen:
                continue
            seen.add(key)
            try:
                if _is_link(path):
                    problems.append({**problem, "reason": "symbolic links and junctions are not allowed"})
                    continue
                if not path.exists():
                    problems.append({**problem, "reason": "path does not exist"})
                    continue
                if not path.is_dir():
                    problems.append({**problem, "reason": "path is not a directory"})
                    continue
                if field == "paths" and _repository_dir(path) is None:
                    problems.append({**problem, "reason": "path is not a Git repository (.git not found)"})
                    continue
            except OSError as err:
                problems.append({**problem, "reason": f"could not inspect the path: {_error_text(str(err))}"})
                continue
            normalized[field].append(expanded)
    return normalized, problems


def save_config(value: Any, home: Path | None = None) -> dict[str, Any]:
    """Inspect every path, then atomically save only an entirely valid configuration."""
    config, problems = inspect_config_paths(value)
    if problems:
        raise ConfigPathError(problems)
    found = len(discover_repositories(config))
    saved = write_config(config, home)
    return {"config": saved, "found": found}


def read_config(home: Path | None = None) -> dict[str, Any]:
    path = config_path(home)
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 1024 * 1024:
            return copy.deepcopy(DEFAULT_CONFIG)
        value = json.loads(path.read_text(encoding="utf-8"))
        return validate_config(value)
    except (OSError, ValueError, json.JSONDecodeError):
        return copy.deepcopy(DEFAULT_CONFIG)


def write_config(value: Any, home: Path | None = None) -> dict[str, Any]:
    """Atomically save a validated config beside the other Stira memory files."""
    config = validate_config(value)
    path = config_path(home)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and path.is_symlink():
        raise OSError("repository config must not be a symbolic link")
    temp = path.with_name(f".{path.name}.{os.getpid()}.{threading.get_ident()}.tmp")
    text = json.dumps(config, ensure_ascii=False, indent=2) + "\n"
    try:
        temp.write_text(text, encoding="utf-8", newline="")
        os.replace(temp, path)
    finally:
        try:
            temp.unlink()
        except FileNotFoundError:
            pass
    return config


def _is_link(path: Path) -> bool:
    """Treat Windows directory junctions like symlinks; neither is an exploration boundary."""
    try:
        return path.is_symlink() or bool(getattr(path, "is_junction", lambda: False)())
    except OSError:
        return True


def _repository_dir(path: Path) -> Path | None:
    try:
        if _is_link(path) or not path.is_dir():
            return None
        marker = path / ".git"
        if _is_link(marker) or not marker.exists():
            return None
        return path.resolve(strict=True)
    except OSError:
        return None


def _discover_repository_locations(config: Mapping[str, Any]) -> list[tuple[Path, Path | None]]:
    """Return repositories paired with their scan root; explicit paths use ``None``.

    Explicit ``paths`` are visited first so they win when the same repository also appears
    under a scan root.
    """
    found: dict[str, tuple[Path, Path | None]] = {}

    def add(candidate: Path, root: Path | None) -> None:
        repo = _repository_dir(candidate)
        if repo is None:
            return
        key = os.path.normcase(os.path.normpath(str(repo)))
        found.setdefault(key, (repo, root))

    for raw in config.get("paths", []):
        add(Path(raw).expanduser(), None)
    for raw in config.get("scanRoots", []):
        configured_root = Path(raw).expanduser()
        try:
            if _is_link(configured_root) or not configured_root.is_dir():
                continue
            root = configured_root.resolve(strict=True)
            for child in sorted(root.iterdir(), key=lambda p: p.name.casefold()):
                add(child, root)
        except OSError:
            continue
    return list(found.values())


def discover_repositories(config: Mapping[str, Any]) -> list[Path]:
    """Return configured repositories and direct children of configured scan roots."""
    return [repo for repo, _root in _discover_repository_locations(config)]


def _read_small_text(path: Path) -> str:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
        raise OSError(f"invalid Git metadata file: {path.name}")
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return handle.read(4097)


def _read_git_pointer(marker: Path) -> Path:
    if marker.is_dir():
        return marker.resolve()
    text = _read_small_text(marker)
    if not text.startswith("gitdir:"):
        raise OSError("invalid .git file")
    target = Path(text.split(":", 1)[1].strip())
    if not target.is_absolute():
        target = marker.parent / target
    return target.resolve(strict=True)


def _git_dirs(repo: Path) -> tuple[Path, Path]:
    git_dir = _read_git_pointer(repo / ".git")
    common = git_dir
    commondir = git_dir / "commondir"
    if commondir.is_file() and not commondir.is_symlink():
        raw = _read_small_text(commondir).strip()
        candidate = Path(raw)
        if not candidate.is_absolute():
            candidate = git_dir / candidate
        common = candidate.resolve(strict=True)
    return git_dir, common


def _stat_token(path: Path) -> tuple[int, int] | None:
    try:
        stat = path.stat()
        return stat.st_size, stat.st_mtime_ns
    except OSError:
        return None


def cache_key(repo: Path) -> tuple[Any, ...]:
    git_dir, common = _git_dirs(repo)
    tokens: list[Any] = [
        ("HEAD", _stat_token(git_dir / "HEAD")),
        ("index", _stat_token(git_dir / "index")),
        ("packed-refs", _stat_token(common / "packed-refs")),
    ]
    heads = common / "refs" / "heads"
    if heads.is_dir() and not heads.is_symlink():
        try:
            for path in sorted((p for p in heads.rglob("*") if p.is_file() and not p.is_symlink()), key=str):
                tokens.append((str(path.relative_to(heads)), _stat_token(path)))
        except OSError:
            tokens.append(("refs/heads", None))
    else:
        tokens.append(("refs/heads", None))
    return tuple(tokens)


def _error_text(text: str) -> str:
    cleaned = clean_field(redact(text))
    return cleaned[:MAX_ERROR_LENGTH] or "git command failed"


def _run_git(
    repo: Path,
    args: Sequence[str],
    *,
    runner: Runner = subprocess.run,
    required: bool = True,
) -> str | None:
    command = ["git", "-C", str(repo), *args]
    env = os.environ.copy()
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": ""})
    try:
        result = runner(
            command,
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=GIT_TIMEOUT,
            check=False,
        )
    except FileNotFoundError as err:
        raise GitProbeError("git executable not found") from err
    except subprocess.TimeoutExpired as err:
        raise GitProbeError(f"git {args[0]} timed out after {GIT_TIMEOUT}s") from err
    except OSError as err:
        raise GitProbeError(_error_text(str(err))) from err
    if result.returncode != 0:
        if not required:
            return None
        detail = result.stderr or result.stdout or f"exit {result.returncode}"
        raise GitProbeError(f"git {args[0]} failed: {_error_text(detail)}")
    return result.stdout


def _run_fetch(repo: Path, *, runner: Runner = subprocess.run) -> None:
    """Run the only remote operation exposed by the workbench."""
    command = ["git", "-C", str(repo), "fetch", "--prune", "--quiet", "origin"]
    env = os.environ.copy()
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "GIT_ASKPASS": ""})
    try:
        result = runner(
            command,
            shell=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
            timeout=FETCH_TIMEOUT,
            check=False,
        )
    except FileNotFoundError as err:
        raise GitProbeError("git executable not found") from err
    except subprocess.TimeoutExpired as err:
        raise GitProbeError(f"git fetch timed out after {FETCH_TIMEOUT}s") from err
    except OSError as err:
        raise GitProbeError(_error_text(str(err))) from err
    if result.returncode != 0:
        detail = result.stderr or result.stdout or f"exit {result.returncode}"
        raise GitProbeError(f"git fetch failed: {_error_text(detail)}")


def _parse_status(text: str) -> dict[str, Any]:
    branch = ""
    upstream: str | None = None
    ahead = behind = staged = unstaged = untracked = 0
    for line in text.splitlines():
        if line.startswith("# branch.head "):
            branch = line[len("# branch.head ") :].strip()
        elif line.startswith("# branch.upstream "):
            upstream = line[len("# branch.upstream ") :].strip() or None
        elif line.startswith("# branch.ab "):
            parts = line.split()
            try:
                ahead = int(parts[-2].removeprefix("+"))
                behind = abs(int(parts[-1].removeprefix("-")))
            except (ValueError, IndexError):
                ahead = behind = 0
        elif line.startswith("? "):
            untracked += 1
        elif line and line[0] in {"1", "2", "u"}:
            parts = line.split(" ", 2)
            xy = parts[1] if len(parts) > 1 else ".."
            staged += int(len(xy) > 0 and xy[0] != ".")
            unstaged += int(len(xy) > 1 and xy[1] != ".")
    return {
        "branch": branch or "(detached)",
        "upstream": upstream,
        "ahead": ahead,
        "behind": behind,
        "changes": {
            "staged": staged,
            "unstaged": unstaged,
            "untracked": untracked,
            "total": staged + unstaged + untracked,
        },
    }


def _default_branch(repo: Path, runner: Runner) -> tuple[str, str]:
    """(既定ブランチ名, 取得元)。origin/HEAD はクローン時点の値で古いことがある(ネットワークに出ないので直せない)。"""
    raw = _run_git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], runner=runner, required=False)
    name = (raw or "").strip().removeprefix("origin/")
    return (name, "origin/HEAD") if name else ("main", "fallback")


def _compare_base(repo: Path, default_branch: str, runner: Runner) -> str:
    """ブランチの比較先。origin/<既定> があればそれ、無ければローカルの既定ブランチ。"""
    remote_ref = f"refs/remotes/origin/{default_branch}"
    found = _run_git(repo, ["rev-parse", "--verify", "--quiet", remote_ref], runner=runner, required=False)
    return f"origin/{default_branch}" if found and found.strip() else default_branch


def _branches(repo: Path, base: str, runner: Runner) -> list[dict[str, Any]] | None:
    fmt = f"--format=%(refname:short)%00%(ahead-behind:{base})"
    raw = _run_git(repo, ["for-each-ref", fmt, "refs/heads"], runner=runner, required=False)
    if raw is None:
        return None
    out = []
    for line in raw.splitlines():
        try:
            name, counts = line.split("\x00", 1)
            ahead, behind = (int(v) for v in counts.split())
        except (ValueError, TypeError):
            return None
        out.append({"name": name, "ahead": ahead, "behind": behind})
    return out


def _worktrees(text: str) -> dict[str, int]:
    return {
        "total": sum(1 for line in text.splitlines() if line.startswith("worktree ")),
        "prunable": sum(1 for line in text.splitlines() if line.startswith("prunable")),
    }


def _worktree_list(text: str, repo: Path) -> list[dict[str, Any]]:
    """Parse ``git worktree list --porcelain`` without changing its existing summary."""
    records: list[dict[str, str | bool]] = []
    current: dict[str, str | bool] = {}
    for line in [*text.splitlines(), ""]:
        if not line:
            if current.get("path"):
                records.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        if key == "worktree":
            current["path"] = value
        elif key == "HEAD":
            current["head"] = value
        elif key == "branch":
            current["branch"] = value.removeprefix("refs/heads/")
        elif key in {"detached", "prunable", "locked"}:
            current[key] = True

    repo_key = os.path.normcase(os.path.normpath(os.path.abspath(str(repo))))
    out: list[dict[str, Any]] = []
    for record in records:
        path = str(record["path"])
        path_key = os.path.normcase(os.path.normpath(os.path.abspath(path)))
        branch = record.get("branch")
        out.append(
            {
                "path": path,
                "branch": str(branch) if branch is not None else None,
                "head": str(record.get("head", ""))[:7],
                "detached": bool(record.get("detached") or branch is None),
                "prunable": bool(record.get("prunable")),
                "locked": bool(record.get("locked")),
                "main": path_key == repo_key,
            }
        )
    return out


def _last_commit(text: str | None) -> dict[str, str] | None:
    if not text:
        return None
    parts = text.rstrip("\r\n").split("\x00", 2)
    if len(parts) != 3:
        return None
    return {"hash": parts[0], "date": parts[1], "subject": redact(parts[2])}


def sanitize_remote_url(raw: str | None) -> str | None:
    if not raw:
        return None
    value = raw.strip()
    try:
        parsed = urlsplit(value)
        if parsed.scheme and parsed.netloc:
            host = parsed.hostname or ""
            if parsed.port:
                host = f"{host}:{parsed.port}"
            value = urlunsplit((parsed.scheme, host, parsed.path, parsed.query, parsed.fragment))
    except (ValueError, UnicodeError):
        pass
    return redact(value)


def github_repository(remote: str | None) -> str | None:
    if not remote:
        return None
    value = remote.strip()
    host = ""
    path = ""
    if value.startswith("git@github.com:"):
        host, path = "github.com", value.split(":", 1)[1]
    else:
        try:
            parsed = urlsplit(value)
            host, path = (parsed.hostname or "").casefold(), parsed.path.lstrip("/")
        except ValueError:
            return None
    if host not in {"github.com", "www.github.com"}:
        return None
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        return None
    repo = parts[1][:-4] if parts[1].casefold().endswith(".git") else parts[1]
    return f"{parts[0]}/{repo}"


def _group_key(remote: str | None, path_key: str) -> str:
    if remote:
        value = remote.rstrip("/")
        if value.casefold().endswith(".git"):
            value = value[:-4]
        source = "remote:" + value.casefold()
    else:
        source = "local:" + path_key
    return "repo-" + hashlib.sha256(source.encode("utf-8")).hexdigest()[:12]


def _fetch_updated_at(repo: Path) -> str | None:
    try:
        git_dir, common = _git_dirs(repo)
        for path in (common / "FETCH_HEAD", git_dir / "FETCH_HEAD"):
            token = _stat_token(path)
            if token is not None:
                return _iso(path.stat().st_mtime)
    except OSError:
        pass
    return None


def _default_branch_behind(data: Mapping[str, Any]) -> int:
    """ローカルの既定ブランチが比較先(origin/<既定>)から遅れている数。upstream 未設定でも拾う。"""
    for b in data.get("branches") or []:
        if b.get("name") == data.get("defaultBranch"):
            return int(b.get("behind", 0))
    return 0


def _status_colour(data: Mapping[str, Any]) -> str:
    if (
        data.get("behind", 0) > 0
        or _default_branch_behind(data) > 0
        or data.get("worktrees", {}).get("prunable", 0) > 0
    ):
        return "red"
    if (
        data.get("changes", {}).get("total", 0) > 0
        or data.get("branch") != data.get("defaultBranch")
        or data.get("stashCount", 0) > 0
    ):
        return "yellow"
    return "green"


def _base(repo: Path) -> tuple[dict[str, Any], str]:
    resolved = repo.resolve(strict=True)
    key = os.path.normcase(os.path.normpath(str(resolved)))
    digest = hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
    return {"id": f"local-{digest}", "name": resolved.name, "path": str(resolved)}, key


def _collect(repo: Path, runner: Runner) -> dict[str, Any]:
    base, path_key = _base(repo)
    status = _parse_status(_run_git(repo, ["status", "--porcelain=v2", "--branch"], runner=runner) or "")
    default_branch, default_source = _default_branch(repo, runner)
    compare_base = _compare_base(repo, default_branch, runner)
    worktree_text = _run_git(repo, ["worktree", "list", "--porcelain"], runner=runner) or ""
    stash_text = _run_git(repo, ["stash", "list"], runner=runner) or ""
    commit_text = _run_git(repo, ["log", "-1", "--format=%h%x00%cI%x00%s"], runner=runner, required=False)
    remote_raw = _run_git(repo, ["remote", "get-url", "origin"], runner=runner, required=False)
    origin_url = sanitize_remote_url(remote_raw)
    data = {
        **base,
        **status,
        "defaultBranch": default_branch,
        "defaultBranchSource": default_source,
        "compareBase": compare_base,
        "branches": _branches(repo, compare_base, runner),
        "worktrees": _worktrees(worktree_text),
        "worktreeList": _worktree_list(worktree_text, repo),
        "stashCount": sum(1 for line in stash_text.splitlines() if line.strip()),
        "lastCommit": _last_commit(commit_text),
        "originUrl": origin_url,
        "github": github_repository(origin_url),
        "fetchHeadUpdatedAt": _fetch_updated_at(repo),
        "group": _group_key(origin_url, path_key),
    }
    data["status"] = _status_colour(data)
    return data


_CACHE: dict[str, dict[str, Any]] = {}
_CACHE_LOCK = threading.Lock()


def clear_cache() -> None:
    with _CACHE_LOCK:
        _CACHE.clear()


def clear_repository_cache(repo: Path) -> None:
    """Discard one repository without evicting every other desk row."""
    try:
        _, path_key = _base(repo)
    except (OSError, ValueError):
        path_key = os.path.normcase(os.path.normpath(str(repo)))
    with _CACHE_LOCK:
        _CACHE.pop(path_key, None)


def repository_payload(
    repo: Path,
    *,
    runner: Runner = subprocess.run,
    now: float | None = None,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Read one repository.  Failures become data so one bad repository cannot hide others."""
    moment = time.monotonic() if now is None else now
    try:
        base, path_key = _base(repo)
        key = cache_key(repo)
        cached = None
        if use_cache:
            with _CACHE_LOCK:
                cached = copy.deepcopy(_CACHE.get(path_key))
        if cached and cached["key"] == key:
            if moment - cached["statusAt"] < STATUS_TTL:
                return cached["payload"]
            status = _parse_status(_run_git(repo, ["status", "--porcelain=v2", "--branch"], runner=runner) or "")
            payload = {**cached["payload"], **status}
            payload["status"] = _status_colour(payload)
            entry = {"key": key, "statusAt": moment, "payload": payload}
        else:
            payload = _collect(repo, runner)
            entry = {"key": key, "statusAt": moment, "payload": payload}
        if use_cache:
            with _CACHE_LOCK:
                _CACHE[path_key] = copy.deepcopy(entry)
        return payload
    except (GitProbeError, OSError, ValueError) as err:
        try:
            base, path_key = _base(repo)
        except (OSError, ValueError):
            path_key = os.path.normcase(os.path.normpath(str(repo)))
            digest = hashlib.sha256(path_key.encode("utf-8")).hexdigest()[:12]
            base = {"id": f"local-{digest}", "name": repo.name, "path": str(repo)}
        return {
            **base,
            "group": _group_key(None, path_key),
            "status": "red",
            "error": _error_text(str(err)),
        }


_FETCH_LOCK = threading.Lock()
_FETCH_ACTIVE: set[str] = set()
_FETCH_SLOTS = threading.BoundedSemaphore(MAX_FETCHES)


def _repository_for_id(repo_id: str, config: Mapping[str, Any]) -> tuple[Path, Path | None]:
    if not isinstance(repo_id, str) or not repo_id.startswith("local-"):
        raise RepositoryNotFound("repository not found")
    for repo, root in _discover_repository_locations(config):
        try:
            base, _ = _base(repo)
        except (OSError, ValueError):
            continue
        if base["id"] == repo_id:
            return repo, root
    raise RepositoryNotFound("repository not found")


def _with_root(payload: Mapping[str, Any], root: Path | None) -> dict[str, Any]:
    return {**payload, "root": str(root) if root is not None else None}


def _fresh_repository_payload(repo: Path, runner: Runner) -> dict[str, Any]:
    clear_repository_cache(repo)
    return repository_payload(repo, runner=runner, use_cache=False)


def fetch_repository(
    repo_id: str,
    home: Path | None = None,
    *,
    config: Mapping[str, Any] | None = None,
    runner: Runner = subprocess.run,
) -> dict[str, Any]:
    """Fetch one currently configured repository and return its freshly collected payload.

    The caller supplies the opaque ``local-<hash>`` id only.  Paths are resolved again from
    ``read_config`` plus ``discover_repositories`` on every call, so stale or invented ids
    cannot select an arbitrary directory.
    """
    chosen = dict(config) if config is not None else read_config(home)
    repo, root = _repository_for_id(repo_id, chosen)
    try:
        remote = _run_git(repo, ["remote", "get-url", "origin"], runner=runner, required=False)
    except GitProbeError as err:
        payload = _with_root(_fresh_repository_payload(repo, runner), root)
        raise FetchFailed(_error_text(str(err)), payload) from err
    if not remote or not remote.strip():
        raise FetchConflict("origin is not configured", _with_root(_fresh_repository_payload(repo, runner), root))

    _, path_key = _base(repo)
    with _FETCH_LOCK:
        if path_key in _FETCH_ACTIVE:
            raise FetchConflict("fetch already in progress")
        if not _FETCH_SLOTS.acquire(blocking=False):
            raise FetchConflict("fetch capacity is busy")
        _FETCH_ACTIVE.add(path_key)

    try:
        try:
            _run_fetch(repo, runner=runner)
        except GitProbeError as err:
            payload = _with_root(_fresh_repository_payload(repo, runner), root)
            raise FetchFailed(_error_text(str(err)), payload) from err
        return _with_root(_fresh_repository_payload(repo, runner), root)
    finally:
        with _FETCH_LOCK:
            _FETCH_ACTIVE.discard(path_key)
            _FETCH_SLOTS.release()


async def build_payload(
    home: Path | None = None,
    *,
    config: Mapping[str, Any] | None = None,
    runner: Runner = subprocess.run,
    use_cache: bool = True,
) -> dict[str, Any]:
    """Read all configured repositories with at most four blocking Git probes in flight."""
    chosen = dict(config) if config is not None else await asyncio.to_thread(read_config, home)
    locations = await asyncio.to_thread(_discover_repository_locations, chosen)
    semaphore = asyncio.Semaphore(4)

    async def one(location: tuple[Path, Path | None]) -> dict[str, Any]:
        path, root = location
        async with semaphore:
            payload = await asyncio.to_thread(repository_payload, path, runner=runner, use_cache=use_cache)
            return _with_root(payload, root)

    repositories = await asyncio.gather(*(one(location) for location in locations))
    return {
        "version": 1,
        "repositories": repositories,
        "generatedAt": _iso(datetime.now(tz=timezone.utc).timestamp()),
    }
