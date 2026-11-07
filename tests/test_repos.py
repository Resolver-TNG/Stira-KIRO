"""ローカル Git 作業机の試験。ネットワークには出ず、fetch は file:// bare remote だけ。"""

from __future__ import annotations

import asyncio
import os
import shutil
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend import repos  # noqa: E402


def git(path: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(path), *args],
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=20,
    )
    return result.stdout


def write(path: Path, text: str) -> None:
    path.write_text(text, encoding="utf-8", newline="")


def make_repo(path: Path, subject: str = "initial") -> Path:
    path.mkdir(parents=True)
    git(path, "init", "-q", "-b", "main")
    git(path, "config", "user.name", "Stage Test")
    git(path, "config", "user.email", "stage@example.invalid")
    write(path / "tracked.txt", "one\n")
    git(path, "add", "tracked.txt")
    git(path, "commit", "-q", "-m", subject)
    return path


def payload(path: Path, **kwargs):
    repos.clear_cache()
    return repos.repository_payload(path, use_cache=False, **kwargs)


def test_clean_repository_is_green(tmp_path: Path):
    data = payload(make_repo(tmp_path / "clean"))
    assert data["status"] == "green"
    assert data["branch"] == data["defaultBranch"] == "main"
    assert data["changes"] == {"staged": 0, "unstaged": 0, "untracked": 0, "total": 0}
    assert data["worktrees"] == {"total": 1, "prunable": 0}


def test_staged_unstaged_and_untracked_are_counted(tmp_path: Path):
    repo = make_repo(tmp_path / "changes")
    write(repo / "staged.txt", "staged\n")
    git(repo, "add", "staged.txt")
    write(repo / "tracked.txt", "changed\n")
    write(repo / "untracked.txt", "new\n")
    data = payload(repo)
    assert data["changes"] == {"staged": 1, "unstaged": 1, "untracked": 1, "total": 3}
    assert data["status"] == "yellow"


def test_file_remote_fetch_reports_behind_two_and_fetch_time(tmp_path: Path):
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    source = make_repo(tmp_path / "source")
    git(source, "remote", "add", "origin", remote.as_uri())
    git(source, "push", "-q", "-u", "origin", "main")
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", remote.as_uri(), str(clone)], check=True, timeout=20)
    for n in (2, 3):
        write(source / "tracked.txt", f"{n}\n")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-q", "-m", f"commit {n}")
    git(source, "push", "-q", "origin", "main")
    git(clone, "fetch", "-q", "origin")  # file:// only; production code never fetches
    data = payload(clone)
    assert data["behind"] == 2
    assert data["ahead"] == 0
    assert data["fetchHeadUpdatedAt"] is not None
    assert data["status"] == "red"


def test_deleted_worktree_is_prunable(tmp_path: Path):
    repo = make_repo(tmp_path / "primary")
    worktree = tmp_path / "gone-worktree"
    git(repo, "worktree", "add", "-q", "--detach", str(worktree))
    shutil.rmtree(worktree)
    data = payload(repo)
    assert data["worktrees"] == {"total": 2, "prunable": 1}
    assert data["status"] == "red"


def test_stash_is_counted_and_yellow(tmp_path: Path):
    repo = make_repo(tmp_path / "stash")
    write(repo / "tracked.txt", "stashed\n")
    git(repo, "stash", "push", "-q", "-m", "desk-test")
    data = payload(repo)
    assert data["stashCount"] == 1
    assert data["changes"]["total"] == 0
    assert data["status"] == "yellow"


def test_remote_credentials_are_removed_and_github_is_recognized(tmp_path: Path):
    repo = make_repo(tmp_path / "credential-remote")
    git(repo, "remote", "add", "origin", "https://u:t0ken@github.com/Owner/Repo.git")
    data = payload(repo)
    assert "t0ken" not in data["originUrl"]
    assert data["originUrl"] == "https://github.com/Owner/Repo.git"
    assert data["github"] == "Owner/Repo"


def test_same_remote_gets_same_group_key(tmp_path: Path):
    first = make_repo(tmp_path / "first")
    second = make_repo(tmp_path / "second")
    remote = "https://github.com/Resolver-TNG/Stira-KIRO.git"
    git(first, "remote", "add", "origin", remote)
    git(second, "remote", "add", "origin", remote)
    assert payload(first)["group"] == payload(second)["group"]


def test_commit_subject_is_redacted(tmp_path: Path):
    secret = "gh" + "p_" + "abcdefghijklmnopqrstuvwxyz12"
    repo = make_repo(tmp_path / "redacted", f"do not show {secret}")
    data = payload(repo)
    assert secret not in data["lastCommit"]["subject"]
    assert "[redacted]" in data["lastCommit"]["subject"]


def test_discovery_excludes_missing_unconfigured_and_duplicate_paths(tmp_path: Path):
    explicit = make_repo(tmp_path / "explicit")
    scan = tmp_path / "scan"
    scanned = make_repo(scan / "scanned")
    unconfigured = make_repo(tmp_path / "outside" / "unconfigured")
    config = {
        "paths": [str(explicit), str(explicit), str(tmp_path / "missing")],
        "scanRoots": [str(scan)],
        "scanDepth": 1,
    }
    found = repos.discover_repositories(config)
    assert {p.resolve() for p in found} == {explicit.resolve(), scanned.resolve()}
    assert unconfigured.resolve() not in found



def test_build_payload_marks_explicit_and_scan_root_with_paths_priority(tmp_path: Path):
    scan = tmp_path / "scan"
    explicit = make_repo(scan / "explicit")
    scanned = make_repo(scan / "scanned")
    config = {
        "paths": [str(explicit)],
        "scanRoots": [str(scan)],
        "scanDepth": 1,
    }
    result = asyncio.run(repos.build_payload(config=config, use_cache=False))
    by_name = {item["name"]: item for item in result["repositories"]}
    assert by_name["explicit"]["root"] is None
    assert by_name["scanned"]["root"] == str(scan.resolve())



def test_worktree_list_parses_main_branch_detached_prunable_and_locked(tmp_path: Path):
    repo = (tmp_path / "primary").resolve()
    linked = tmp_path / "review-worktree"
    gone = tmp_path / "gone-worktree"
    text = "\n".join(
        [
            f"worktree {repo}",
            "HEAD 1234567890abcdef",
            "branch refs/heads/main",
            "",
            f"worktree {linked}",
            "HEAD abcdef0123456789",
            "detached",
            "locked reason text",
            "",
            f"worktree {gone}",
            "HEAD fedcba9876543210",
            "branch refs/heads/feature/long-name",
            "prunable gitdir file points to non-existent location",
            "",
        ]
    )
    assert repos._worktree_list(text, repo) == [
        {
            "path": str(repo),
            "branch": "main",
            "head": "1234567",
            "detached": False,
            "prunable": False,
            "locked": False,
            "main": True,
        },
        {
            "path": str(linked),
            "branch": None,
            "head": "abcdef0",
            "detached": True,
            "prunable": False,
            "locked": True,
            "main": False,
        },
        {
            "path": str(gone),
            "branch": "feature/long-name",
            "head": "fedcba9",
            "detached": False,
            "prunable": True,
            "locked": False,
            "main": False,
        },
    ]


def test_discovery_excludes_symbolic_link_or_windows_junction(tmp_path: Path):
    target = make_repo(tmp_path / "target")
    link = tmp_path / "repo-link"
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
    else:
        link.symlink_to(target, target_is_directory=True)
    try:
        found = repos.discover_repositories({"paths": [str(link)], "scanRoots": [], "scanDepth": 1})
        assert found == []
    finally:
        if link.exists() or link.is_symlink():
            link.rmdir() if os.name == "nt" else link.unlink()


def test_missing_git_and_timeout_are_isolated_per_repository(tmp_path: Path):
    good = make_repo(tmp_path / "good")
    missing = make_repo(tmp_path / "missing-git")
    slow = make_repo(tmp_path / "slow")
    real_run = subprocess.run

    def runner(command, **kwargs):
        cwd = Path(command[2])
        if cwd == missing:
            raise FileNotFoundError("git")
        if cwd == slow:
            raise subprocess.TimeoutExpired(command, kwargs.get("timeout", 10))
        return real_run(command, **kwargs)

    config = {"paths": [str(good), str(missing), str(slow)], "scanRoots": [], "scanDepth": 1}
    repos.clear_cache()
    result = asyncio.run(repos.build_payload(config=config, runner=runner, use_cache=False))
    by_name = {item["name"]: item for item in result["repositories"]}
    assert by_name["good"]["status"] == "green" and "error" not in by_name["good"]
    assert by_name["missing-git"]["error"] == "git executable not found"
    assert "timed out" in by_name["slow"]["error"]


def test_old_git_branch_atom_failure_returns_null_branches(tmp_path: Path):
    repo = make_repo(tmp_path / "old-git")
    real_run = subprocess.run

    def runner(command, **kwargs):
        if "for-each-ref" in command:
            return subprocess.CompletedProcess(command, 129, "", "unknown field name: ahead-behind")
        return real_run(command, **kwargs)

    data = payload(repo, runner=runner)
    assert data["branches"] is None
    assert "error" not in data


def test_cache_reuses_all_facts_then_refreshes_only_status(tmp_path: Path):
    repo = make_repo(tmp_path / "cached")
    calls = []

    def runner(command, **kwargs):
        calls.append(command[3])
        return subprocess.run(command, **kwargs)

    repos.clear_cache()
    first = repos.repository_payload(repo, runner=runner, now=0)
    first_count = len(calls)
    second = repos.repository_payload(repo, runner=runner, now=299)
    assert second == first
    assert len(calls) == first_count
    repos.repository_payload(repo, runner=runner, now=301)
    assert calls[first_count:] == ["status"]


def test_config_defaults_roundtrip_and_validation(tmp_path: Path):
    assert repos.read_config(tmp_path) == {"paths": [], "scanRoots": [], "scanDepth": 1, "dashboardBot": ""}
    value = {"paths": ["X:/repo"], "scanRoots": ["X:/root"], "scanDepth": 1, "dashboardBot": "desk-bot_1"}
    assert repos.write_config(value, tmp_path) == value
    assert repos.read_config(tmp_path) == value
    for bad in (
        {"paths": "x", "scanRoots": [], "scanDepth": 1},
        {"paths": [], "scanRoots": [1], "scanDepth": 1},
        {"paths": [], "scanRoots": [], "scanDepth": 2},
        {"paths": ["x" * 1025], "scanRoots": [], "scanDepth": 1},
        {"paths": [str(n) for n in range(201)], "scanRoots": [], "scanDepth": 1},
    ):
        with pytest.raises(repos.ConfigError):
            repos.validate_config(bad)



def test_default_branch_without_upstream_is_compared_to_origin(tmp_path: Path):
    """upstream の無いローカル main が origin/main から遅れていても赤にする (実機の Stira-CrewTree で見逃した型)。"""
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    source = make_repo(tmp_path / "source")
    git(source, "remote", "add", "origin", remote.as_uri())
    git(source, "push", "-q", "-u", "origin", "main")
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", remote.as_uri(), str(clone)], check=True, timeout=20)
    git(clone, "branch", "--unset-upstream", "main")
    for n in (2, 3):
        write(source / "tracked.txt", f"{n}\n")
        git(source, "add", "tracked.txt")
        git(source, "commit", "-q", "-m", f"commit {n}")
    git(source, "push", "-q", "origin", "main")
    git(clone, "fetch", "-q", "origin")  # file:// only
    data = payload(clone)
    assert data["upstream"] is None
    assert data["behind"] == 0
    assert data["compareBase"] == "origin/main"
    assert data["defaultBranchSource"] == "origin/HEAD"
    assert {"name": "main", "ahead": 0, "behind": 2} in data["branches"]
    assert data["status"] == "red"


def test_branches_fall_back_to_local_default_without_remote(tmp_path: Path):
    repo = make_repo(tmp_path / "local-only")
    git(repo, "switch", "-q", "-c", "feature")
    write(repo / "tracked.txt", "feature\n")
    git(repo, "commit", "-q", "-am", "feature work")
    data = payload(repo)
    assert data["compareBase"] == "main"
    assert data["defaultBranchSource"] == "fallback"
    assert {"name": "feature", "ahead": 1, "behind": 0} in data["branches"]



def repo_config(*paths: Path) -> dict[str, object]:
    return {"paths": [str(path) for path in paths], "scanRoots": [], "scanDepth": 1, "dashboardBot": ""}


def test_fetch_rejects_id_outside_current_discovery(tmp_path: Path):
    configured = make_repo(tmp_path / "configured")
    outside = make_repo(tmp_path / "outside")
    outside_id = payload(outside)["id"]
    with pytest.raises(repos.RepositoryNotFound):
        repos.fetch_repository(outside_id, config=repo_config(configured))


def test_fetch_without_origin_is_conflict_and_returns_fresh_payload(tmp_path: Path):
    repo = make_repo(tmp_path / "no-origin")
    repo_id = payload(repo)["id"]
    with pytest.raises(repos.FetchConflict) as caught:
        repos.fetch_repository(repo_id, config=repo_config(repo))
    assert str(caught.value) == "origin is not configured"
    assert caught.value.payload["id"] == repo_id
    assert caught.value.payload["status"] == "green"


def test_same_repository_fetch_is_rejected_while_one_is_running(tmp_path: Path):
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    repo = make_repo(tmp_path / "repo")
    git(repo, "remote", "add", "origin", remote.as_uri())
    git(repo, "push", "-q", "-u", "origin", "main")
    repo_id = payload(repo)["id"]
    started = threading.Event()
    release = threading.Event()
    fetch_call = {}

    def blocking_runner(command, **kwargs):
        if command[3] == "fetch":
            fetch_call.update({"command": command, "kwargs": kwargs})
            started.set()
            assert release.wait(5), "test did not release the fetch"
        return subprocess.run(command, **kwargs)

    with ThreadPoolExecutor(max_workers=1) as pool:
        first = pool.submit(
            repos.fetch_repository,
            repo_id,
            config=repo_config(repo),
            runner=blocking_runner,
        )
        assert started.wait(5), "fetch did not start"
        with pytest.raises(repos.FetchConflict, match="already in progress"):
            repos.fetch_repository(repo_id, config=repo_config(repo))
        release.set()
        assert first.result(timeout=10)["id"] == repo_id
    assert fetch_call["command"] == ["git", "-C", str(repo.resolve()), "fetch", "--prune", "--quiet", "origin"]
    assert fetch_call["kwargs"]["shell"] is False
    assert fetch_call["kwargs"]["timeout"] == 60
    assert fetch_call["kwargs"]["env"]["GIT_OPTIONAL_LOCKS"] == "0"
    assert fetch_call["kwargs"]["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert fetch_call["kwargs"]["env"]["GIT_ASKPASS"] == ""


def test_fetch_global_limit_rejects_a_third_repository(tmp_path: Path):
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    repositories = []
    for name in ("first", "second", "third"):
        repo = make_repo(tmp_path / name)
        git(repo, "remote", "add", "origin", remote.as_uri())
        repositories.append(repo)
    config = repo_config(*repositories)
    ids = [payload(repo)["id"] for repo in repositories]
    release = threading.Event()
    two_started = threading.Event()
    count_lock = threading.Lock()
    started_count = 0

    def blocking_runner(command, **kwargs):
        nonlocal started_count
        if command[3] == "fetch":
            with count_lock:
                started_count += 1
                if started_count == 2:
                    two_started.set()
            assert release.wait(5), "test did not release the fetches"
        return subprocess.run(command, **kwargs)

    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [
            pool.submit(repos.fetch_repository, repo_id, config=config, runner=blocking_runner)
            for repo_id in ids[:2]
        ]
        assert two_started.wait(5), "two fetches did not start"
        with pytest.raises(repos.FetchConflict, match="capacity is busy"):
            repos.fetch_repository(ids[2], config=config)
        release.set()
        assert [future.result(timeout=10)["id"] for future in futures] == ids[:2]


def test_fetch_discards_cache_and_updates_behind_from_file_remote(tmp_path: Path):
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git(remote, "init", "-q", "--bare")
    source = make_repo(tmp_path / "source")
    git(source, "remote", "add", "origin", remote.as_uri())
    git(source, "push", "-q", "-u", "origin", "main")
    git(remote, "symbolic-ref", "HEAD", "refs/heads/main")
    clone = tmp_path / "clone"
    subprocess.run(["git", "clone", "-q", remote.as_uri(), str(clone)], check=True, timeout=20)
    repos.clear_cache()
    before = repos.repository_payload(clone)
    assert before["behind"] == 0

    write(source / "tracked.txt", "remote update\n")
    git(source, "commit", "-q", "-am", "remote update")
    git(source, "push", "-q", "origin", "main")

    after = repos.fetch_repository(before["id"], config=repo_config(clone))
    assert after["behind"] == 1
    assert {"name": "main", "ahead": 0, "behind": 1} in after["branches"]
    assert after["fetchHeadUpdatedAt"] is not None
    assert after["status"] == "red"


def test_fetch_failure_redacts_credentials_and_returns_fresh_payload(tmp_path: Path):
    repo = make_repo(tmp_path / "failed-fetch")
    secret = "credential-value-123"
    git(repo, "remote", "add", "origin", f"https://user:{secret}@example.invalid/repo.git")
    repo_id = payload(repo)["id"]

    def failing_runner(command, **kwargs):
        if command[3] == "fetch":
            return subprocess.CompletedProcess(
                command,
                128,
                "",
                f"fatal: unable to access 'https://user:{secret}@example.invalid/repo.git'",
            )
        return subprocess.run(command, **kwargs)

    with pytest.raises(repos.FetchFailed) as caught:
        repos.fetch_repository(repo_id, config=repo_config(repo), runner=failing_runner)
    assert secret not in str(caught.value)
    assert secret not in str(caught.value.payload)
    assert caught.value.payload["id"] == repo_id



def checked_config(*, paths=(), scan_roots=(), dashboard_bot=""):
    return {
        "paths": list(paths),
        "scanRoots": list(scan_roots),
        "scanDepth": 1,
        "dashboardBot": dashboard_bot,
    }


def test_config_paths_trim_copy_quotes_and_expand_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    home = tmp_path / "home"
    repo = make_repo(home / "quoted-repo")
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    monkeypatch.setenv("HOMEDRIVE", home.drive)
    monkeypatch.setenv("HOMEPATH", str(home)[len(home.drive):])

    config, problems = repos.inspect_config_paths(checked_config(paths=['  "~/quoted-repo"  ']))

    assert problems == []
    assert config == checked_config(paths=[str(repo)])


def test_config_paths_reject_relative_missing_file_and_non_git_directory(tmp_path: Path):
    regular_file = tmp_path / "plain.txt"
    write(regular_file, "not a directory\n")
    non_git = tmp_path / "not-a-repository"
    non_git.mkdir()
    missing = tmp_path / "missing"

    _config, problems = repos.inspect_config_paths(checked_config(paths=[
        "relative/repo",
        str(missing),
        str(regular_file),
        str(non_git),
    ]))

    assert [(problem["index"], problem["reason"]) for problem in problems] == [
        (0, "path must be absolute"),
        (1, "path does not exist"),
        (2, "path is not a directory"),
        (3, "path is not a Git repository (.git not found)"),
    ]


def test_config_scan_root_accepts_a_directory_that_is_not_a_repository(tmp_path: Path):
    scan_root = tmp_path / "projects"
    scan_root.mkdir()
    config, problems = repos.inspect_config_paths(checked_config(scan_roots=[str(scan_root)]))
    assert problems == []
    assert config == checked_config(scan_roots=[str(scan_root)])


@pytest.mark.parametrize("network_path", [r"\\server\share", r"\\?\UNC\server\share"])
def test_config_paths_reject_network_paths_before_stat(network_path: str):
    config, problems = repos.inspect_config_paths(checked_config(scan_roots=[network_path]))
    assert config == checked_config()
    assert problems == [{
        "field": "scanRoots",
        "index": 0,
        "path": network_path,
        "reason": "network paths are not allowed because checking them may block",
    }]


def test_config_paths_reject_symbolic_links_and_windows_junctions(tmp_path: Path):
    target = tmp_path / "target"
    target.mkdir()
    link = tmp_path / "linked-root"
    if os.name == "nt":
        result = subprocess.run(["cmd", "/c", "mklink", "/J", str(link), str(target)], capture_output=True, timeout=20)
        assert result.returncode == 0, result.stderr.decode(errors="replace")
    else:
        link.symlink_to(target, target_is_directory=True)
    try:
        config, problems = repos.inspect_config_paths(checked_config(scan_roots=[str(link)]))
        assert config == checked_config()
        assert problems[0]["reason"] == "symbolic links and junctions are not allowed"
    finally:
        if link.exists() or link.is_symlink():
            link.rmdir() if os.name == "nt" else link.unlink()


def test_config_paths_deduplicate_case_insensitively_and_keep_first_spelling(tmp_path: Path):
    repo = make_repo(tmp_path / "CaseRepo")
    first = str(repo)
    second = first.swapcase()
    config, problems = repos.inspect_config_paths(checked_config(paths=[first, second, first]))
    assert problems == []
    assert config == checked_config(paths=[first])


def test_save_config_writes_only_after_all_paths_pass_and_returns_found_count(tmp_path: Path):
    scan_root = tmp_path / "projects"
    scanned = make_repo(scan_root / "scanned")
    explicit = make_repo(tmp_path / "explicit")

    result = repos.save_config(
        checked_config(paths=[str(explicit)], scan_roots=[str(scan_root)]),
        tmp_path / "home",
    )

    assert result["found"] == 2
    assert result["config"] == checked_config(paths=[str(explicit)], scan_roots=[str(scan_root)])
    assert {path.resolve() for path in repos.discover_repositories(result["config"])} == {
        explicit.resolve(),
        scanned.resolve(),
    }
    assert repos.read_config(tmp_path / "home") == result["config"]


def test_save_config_rejection_does_not_replace_existing_file(tmp_path: Path):
    home = tmp_path / "home"
    existing_repo = make_repo(tmp_path / "existing")
    existing = repos.write_config(checked_config(paths=[str(existing_repo)]), home)

    with pytest.raises(repos.ConfigPathError) as caught:
        repos.save_config(checked_config(paths=[str(tmp_path / "missing")]), home)

    assert caught.value.problems[0]["reason"] == "path does not exist"
    assert repos.read_config(home) == existing



@pytest.mark.parametrize("slug", ["desk-bot", "desk_bot_1", "a", "bot-2026_stage"])
def test_dashboard_bot_accepts_valid_slug(slug: str):
    config, problems = repos.inspect_config_paths(checked_config(dashboard_bot=slug))
    assert problems == []
    assert config["dashboardBot"] == slug
    assert repos.validate_config(config)["dashboardBot"] == slug


def test_dashboard_bot_accepts_empty_and_roundtrips(tmp_path: Path):
    value = checked_config(dashboard_bot="")
    assert repos.write_config(value, tmp_path) == value
    assert repos.read_config(tmp_path) == value


@pytest.mark.parametrize(
    ("slug", "reason"),
    [
        ("Desk-Bot", "dashboardBot must contain only lowercase letters, digits, hyphens, and underscores"),
        ("desk.bot", "dashboardBot must contain only lowercase letters, digits, hyphens, and underscores"),
        ("a" * 65, "dashboardBot must be at most 64 characters"),
        (123, "dashboardBot must be a string"),
    ],
)
def test_dashboard_bot_rejections_are_setting_problems(slug, reason: str):
    config, problems = repos.inspect_config_paths(checked_config(dashboard_bot=slug))
    assert config["dashboardBot"] == ""
    assert problems == [{"field": "dashboardBot", "index": 0, "reason": reason}]
    with pytest.raises(repos.ConfigError, match=reason):
        repos.validate_config(checked_config(dashboard_bot=slug))


def test_save_config_rejects_bad_dashboard_bot_without_writing(tmp_path: Path):
    home = tmp_path / "home"
    existing = repos.write_config(checked_config(dashboard_bot="desk-bot"), home)
    with pytest.raises(repos.ConfigPathError) as caught:
        repos.save_config(checked_config(dashboard_bot="Desk Bot"), home)
    assert caught.value.problems[0]["field"] == "dashboardBot"
    assert repos.read_config(home) == existing
