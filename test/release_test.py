"""Release automation checks use only owned temporary repositories and fake forge calls."""

import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parent.parent


def load(name):
    """Load a command helper without executing its publishing entry point."""
    spec = importlib.util.spec_from_file_location(name, ROOT / "scripts" / f"{name}.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ReleaseTests(unittest.TestCase):
    """Every filesystem write stays within a uniquely owned playground directory."""

    def setUp(self):
        """Allocate a test directory without altering existing user projects."""
        playground = Path(os.environ.get("ESKA_TEST_ROOT", ROOT.parent / "eska-playground"))
        if not playground.is_absolute() or not playground.is_dir():
            raise RuntimeError("ESKA_TEST_ROOT must name an existing absolute playground directory")
        self.directory = tempfile.TemporaryDirectory(prefix="explorer-release-test-", dir=playground)
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)

    def test_release_requires_matching_changelog(self):
        """A manual version edit cannot silently publish unrelated release notes."""
        module = load("release-version")
        (self.root / "package.json").write_text('{"version":"0.0.0"}')
        self.assertIsNone(module.release_version(self.root))
        (self.root / "package.json").write_text('{"version":"0.1.0"}')
        (self.root / "CHANGELOG.md").write_text("## 0.0.1 (2026-09-18)\n")
        with self.assertRaises(ValueError):
            module.release_version(self.root)
        (self.root / "CHANGELOG.md").write_text("## 0.1.0 (2026-09-18)\n")
        self.assertEqual(module.release_version(self.root), "0.1.0")

    def test_local_execution_cannot_publish(self):
        """A local check must not accidentally open PRs or push branches."""
        module = load("prepare-release")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "false"}), patch.object(module, "run") as run:
            with self.assertRaises(RuntimeError):
                module.prepare()
            run.assert_not_called()

    def test_no_changes_do_not_create_pr(self):
        """A no-op Knope run stops before contacting the forge or pushing."""
        module = load("prepare-release")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": module.REPOSITORY}), \
                patch.object(module, "run", side_effect=["", "a" * 40, "", ""]) as run:
            module.prepare()
            self.assertEqual(len(run.call_args_list), 4)

    def test_foreign_staged_changes_are_rejected(self):
        """Only the version and changelog can enter generated release commits."""
        module = load("prepare-release")
        with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": module.REPOSITORY}), \
                patch.object(module, "run", side_effect=["", "a" * 40, "", "src/extension.ts"]):
            with self.assertRaises(RuntimeError):
                module.prepare()

    @unittest.skipUnless(os.environ.get("KNOPE_TEST_BINARY"), "KNOPE_TEST_BINARY not set")
    def test_pr_branch_creation_and_repeated_run(self):
        """Use real Git branches with a local bare origin; every GitHub call is intercepted."""
        module = load("prepare-release")
        checkout = self.root / "checkout"
        checkout.mkdir()
        origin = self.root / "origin.git"

        def git(*args, cwd=checkout):
            """Keep every Git mutation within this fixture and its local bare origin."""
            return subprocess.check_output(["git", *args], cwd=cwd, text=True, stderr=subprocess.DEVNULL).strip()

        git("init", "-q", "-b", "main")
        git("config", "user.name", "Release test")
        git("config", "user.email", "test@example.invalid")
        for name in ["knope.toml", "package.json", "CHANGELOG.md"]:
            shutil.copyfile(ROOT / name, checkout / name)
        git("add", ".")
        git("commit", "-qm", "feat: Добавлено подключение")
        git("init", "--bare", "-q", str(origin))
        git("remote", "add", "origin", str(origin))
        git("push", "-q", "origin", "main")
        calls = []
        original_run = module.run
        pull_requests = [{"number": 9, "headRefName": "release/eska-explorer-older"}]

        def fake_forge(*args):
            """Delegate only local Git/Knope and record forge actions without contacting GitHub."""
            if args[0] == "gh":
                calls.append(args)
                return json.dumps(pull_requests) if args[1:3] == ("pr", "list") else ""
            if args[0] == "knope":
                return original_run(os.environ["KNOPE_TEST_BINARY"], *args[1:])
            return original_run(*args)

        previous = Path.cwd()
        try:
            os.chdir(checkout)
            with patch.dict(os.environ, {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": module.REPOSITORY,
                                        "RUNNER_TEMP": str(self.root)}), patch.object(module, "run", side_effect=fake_forge):
                module.prepare()
                branch = git("branch", "--show-current")
                self.assertTrue(branch.startswith("release/eska-explorer-"))
                self.assertEqual(git("rev-parse", "HEAD"), git("rev-parse", f"refs/heads/{branch}", cwd=origin))
                self.assertEqual(sum(call[1:3] == ("pr", "create") for call in calls), 1)
                self.assertTrue(any(call[1:3] == ("workflow", "run") for call in calls))
                self.assertTrue(any(call[1:4] == ("pr", "close", "9") for call in calls))
                pull_requests[:] = [{"number": 10, "headRefName": branch}]
                second = self.root / "second"
                git("clone", "-q", "--branch", "main", str(origin), str(second))
                os.chdir(second)
                module.prepare()
                self.assertEqual(sum(call[1:3] == ("pr", "create") for call in calls), 1)
        finally:
            os.chdir(previous)

    @unittest.skipUnless(os.environ.get("KNOPE_TEST_BINARY"), "KNOPE_TEST_BINARY not set")
    def test_real_knope_versions_notes_and_noop(self):
        """Exercise the actual pinned Rust tool without network access or GitHub publication."""
        for name in ["knope.toml", "package.json", "CHANGELOG.md"]:
            shutil.copyfile(ROOT / name, self.root / name)
        manifest = json.loads((self.root / "package.json").read_text())
        manifest["version"] = "0.1.0"
        (self.root / "package.json").write_text(json.dumps(manifest))

        def run(*args):
            """Execute fixture-local Git/Knope commands and surface complete failures."""
            return subprocess.run(args, cwd=self.root, text=True, capture_output=True, check=True).stdout

        run("git", "init", "-q", "-b", "main")
        run("git", "config", "user.name", "Release test")
        run("git", "config", "user.email", "test@example.invalid")
        run("git", "add", ".")
        run("git", "commit", "-qm", "chore: scaffold")
        run("git", "tag", "v0.1.0")
        binary = os.environ["KNOPE_TEST_BINARY"]
        run(binary, "--validate")
        run(binary, "prepare-release")
        self.assertEqual(run("git", "diff", "--cached", "--name-only").strip(), "")
        run("git", "commit", "--allow-empty", "-qm", "fix(explorer): Исправлено подключение")
        run(binary, "prepare-release")
        self.assertEqual(json.loads((self.root / "package.json").read_text())["version"], "0.1.1")
        self.assertIn("Исправлено подключение", (self.root / "CHANGELOG.md").read_text())
        self.assertEqual(set(run("git", "diff", "--cached", "--name-only").splitlines()), {"package.json", "CHANGELOG.md"})
        run("git", "commit", "-qm", "chore(release): Подготовлена версия 0.1.1")
        run("git", "tag", "v0.1.1")
        run("git", "commit", "--allow-empty", "-qm", "feat(explorer): Добавлена возможность")
        run(binary, "prepare-release")
        self.assertEqual(json.loads((self.root / "package.json").read_text())["version"], "0.1.2")
        run("git", "commit", "-qm", "chore(release): Подготовлена версия 0.1.2")
        run("git", "tag", "v0.1.2")
        run("git", "commit", "--allow-empty", "-qm", "feat(explorer)!: Изменён контракт")
        run(binary, "prepare-release")
        self.assertEqual(json.loads((self.root / "package.json").read_text())["version"], "0.2.0")



class VsixReleaseTests(unittest.TestCase):
    """Exercise tag provenance, retries and failure ordering without publishing fixtures."""

    def setUp(self):
        """Reuse the owned playground fixture without inheriting unrelated test methods."""
        ReleaseTests.setUp(self)

    def test_existing_asset_skips_build_and_upload(self):
        """A rerun never replaces a successfully published VSIX."""
        module = load('release-vsix')
        release = {'isDraft': False, 'assets': [{'name': 'eska-explorer-0.0.1.vsix', 'state': 'uploaded', 'size': 123}]}
        with patch.object(module, 'run', return_value=json.dumps(release)) as run:
            module.publish('0.0.1')
            self.assertEqual(run.call_count, 1)

    def test_invalid_release_or_asset_stops(self):
        """Drafts, partial uploads and invalid versions require explicit recovery."""
        module = load('release-vsix')
        for release in [{'isDraft': True, 'assets': []}, {'isDraft': False, 'assets': [
                {'name': 'eska-explorer-0.0.1.vsix', 'state': 'starter', 'size': 0}]}]:
            with patch.object(module, 'run', return_value=json.dumps(release)) as run:
                with self.assertRaises(RuntimeError):
                    module.publish('0.0.1')
                self.assertEqual(run.call_count, 1)
        with patch.object(module, 'run') as run:
            for version in ['0.0.0', '../main', '0.1']:
                with self.assertRaises(ValueError):
                    module.publish(version)
            run.assert_not_called()

    def test_upload_follows_successful_build_and_verification(self):
        """API/build/check failures propagate before any asset upload."""
        module = load('release-vsix')
        for failed_step in [None, 'install', 'package', 'scripts/check-vsix.py']:
            calls = []

            def fake_run(*args, cwd=None):
                """Record tool order and inject a failure at a selected build stage."""
                calls.append(args)
                if failed_step and failed_step in args:
                    raise subprocess.CalledProcessError(1, args)
                return json.dumps({'isDraft': False, 'assets': []}) if args[:3] == ('gh', 'release', 'view') else ''

            with patch.dict(os.environ, {'RUNNER_TEMP': str(self.root)}), \
                    patch.object(module, 'stage_tag', return_value=self.root), patch.object(module, 'run', side_effect=fake_run):
                if failed_step:
                    with self.assertRaises(subprocess.CalledProcessError):
                        module.publish('0.0.1')
                    self.assertFalse(any(call[:3] == ('gh', 'release', 'upload') for call in calls))
                else:
                    module.publish('0.0.1')
                    self.assertEqual(calls[-2], ('python3', 'scripts/check-vsix.py', 'eska-explorer-0.0.1.vsix'))
                    self.assertEqual(calls[-1][:3], ('gh', 'release', 'upload'))
                    self.assertNotIn('--clobber', calls[-1])

    def test_export_uses_tag_instead_of_newer_head(self):
        """A real Git archive keeps a published version independent of later main commits."""
        module = load('release-vsix')
        checkout = self.root / 'repository'
        checkout.mkdir()

        def git(*args):
            """Modify only this test's temporary repository."""
            return subprocess.check_output(['git', *args], cwd=checkout, text=True, stderr=subprocess.DEVNULL).strip()

        git('init', '-q')
        git('config', 'user.name', 'Release test')
        git('config', 'user.email', 'test@example.invalid')
        (checkout / 'package.json').write_text(json.dumps({'version': '0.0.1', 'name': 'eska-explorer', 'publisher': '1c-tooling'}))
        (checkout / 'source.txt').write_text('tagged source')
        git('add', '.')
        git('commit', '-qm', 'feat: Первая версия')
        git('tag', 'v0.0.1')
        (checkout / 'source.txt').write_text('new main code')
        git('add', '.')
        git('commit', '-qm', 'feat: Следующая версия')
        destination = self.root / 'export'
        destination.mkdir()
        original = module.run
        with patch.object(module, 'run', side_effect=lambda *args: original(*args, cwd=checkout)):
            source = module.stage_tag('0.0.1', destination)
            self.assertEqual((source / 'source.txt').read_text(), 'tagged source')
            self.assertFalse((source / '.git').exists())
            git('tag', 'v0.0.2')
            with self.assertRaises(RuntimeError):
                module.stage_tag('0.0.2', self.root)


if __name__ == "__main__":
    unittest.main()
