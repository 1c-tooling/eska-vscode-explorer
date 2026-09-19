"""Store publication checks never contact a registry or modify user projects."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from urllib.error import HTTPError
from release_test import load, ROOT


class StoreTests(unittest.TestCase):
    """Exercise the released-asset boundary and both authentication modes."""

    def setUp(self):
        """Create an owned fixture and mock only external process boundaries."""
        self.module = load("publish-stores")
        self.read_remote_digest = self.module.remote_digest
        remote = patch.object(self.module, "remote_digest", return_value=None)
        self.remote = remote.start()
        self.addCleanup(remote.stop)
        directory = tempfile.TemporaryDirectory(prefix="explorer-stores-", dir=Path(os.environ.get("ESKA_TEST_ROOT", ROOT.parent / "eska-playground")))
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.manifest = {"publisher": "1c-tooling", "name": "eska-explorer", "version": "0.1.0", "main": "./out/extension.js"}
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("extension.vsixmanifest", '<PackageManifest><Metadata><Identity Publisher="1c-tooling" Id="eska-explorer" Version="0.1.0"/></Metadata></PackageManifest>')
            archive.writestr("extension/package.json", json.dumps(self.manifest))
            archive.writestr("extension/out/extension.js", "exports.activate = () => {};")
        self.payload = buffer.getvalue()
        self.asset = {"name": "eska-explorer-0.1.0.vsix", "state": "uploaded", "size": len(self.payload), "digest": "sha256:" + hashlib.sha256(self.payload).hexdigest()}
        self.release = {"tag_name": "v0.1.0", "draft": False, "prerelease": False, "assets": [self.asset]}
        environment = {"RUNNER_TEMP": str(self.root), "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": self.module.REPOSITORY, "GITHUB_REF": "refs/heads/main", "GITHUB_EVENT_NAME": "workflow_dispatch"}
        self.environment = patch.dict(os.environ, environment, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def forge(self, *args):
        """Supply a tagged manifest and immutable release bytes without a real forge."""
        if args[:2] == ("git", "merge-base"):
            return ""
        if args[:2] == ("git", "show"):
            return json.dumps(self.manifest)
        if args[:2] == ("gh", "api"):
            return json.dumps(self.release)
        if args[:3] == ("gh", "release", "download"):
            (Path(args[-1]) / self.asset["name"]).write_bytes(self.payload)
            return ""
        raise AssertionError(args)

    def test_dry_run_never_publishes(self):
        """The asset is validated without needing any credentials."""
        with patch.object(self.module, "run", side_effect=self.forge), patch.object(self.module.subprocess, "run") as publish:
            self.module.publish("0.1.0", "token")
            publish.assert_not_called()

    def test_invalid_version_and_local_publish_stop_before_network(self):
        """Untrusted versions and local invocations cannot start publication."""
        with patch.object(self.module, "run") as run:
            for version in ("v0.1.0", "0.1.0-beta", "../main", "01.2.3", "0.0.0"):
                with self.assertRaises(ValueError):
                    self.module.publish(version, "oidc")
            os.environ["GITHUB_REF"] = "refs/heads/feat/explorer"
            with self.assertRaises(RuntimeError):
                self.module.publish("0.1.0", "oidc", False)
            run.assert_not_called()

    def test_incomplete_or_corrupt_release_cannot_publish(self):
        """Metadata and byte mismatches fail before invoking a registry client."""
        for target, key, value in ((self.release, "draft", True), (self.release, "prerelease", True), (self.release, "assets", []), (self.asset, "state", "new"), (self.asset, "size", 1), (self.asset, "digest", "sha256:wrong"), (self.manifest, "version", "0.2.0")):
            with self.subTest(key=key), patch.dict(target, {key: value}), patch.object(self.module, "run", side_effect=self.forge), patch.object(self.module.subprocess, "run") as publish:
                with self.assertRaises(ValueError):
                    self.module.publish("0.1.0", "oidc", False)
                publish.assert_not_called()

    def test_registry_authentication_is_explicit(self):
        """OIDC strips tokens; token mode keeps secrets in the process environment only."""
        for authentication in ("oidc", "token"):
            with self.subTest(authentication=authentication), patch.dict(os.environ, {"OVSX_PAT": "secret"}), patch.object(self.module, "run", side_effect=self.forge), patch.object(self.module.subprocess, "run") as publish:
                self.module.publish("0.1.0", authentication, False)
                publish.assert_called_once()
                command = publish.call_args.args[0]
                self.assertEqual(command[:5], ["bun", "run", "--bun", "ovsx", "publish"])
                self.assertNotIn("secret", command)
                environment = publish.call_args.kwargs["env"]
                if authentication == "oidc":
                    self.assertNotIn("OVSX_PAT", environment)
                    self.assertIn("--trusted-publishing", command)
                else:
                    self.assertEqual(environment["OVSX_PAT"], "secret")
                    self.assertNotIn("--trusted-publishing", command)

    def test_missing_token_fails(self):
        """Token mode must not fall through to implicit OIDC discovery."""
        with patch.object(self.module, "run", side_effect=self.forge), patch.object(self.module.subprocess, "run") as publish:
            with self.assertRaises(RuntimeError):
                self.module.publish("0.1.0", "token", False)
            publish.assert_not_called()

    def test_release_push_and_identical_retry(self):
        """A release push uploads once; an identical existing package needs no upload or token."""
        os.environ["GITHUB_EVENT_NAME"] = "push"
        with patch.dict(os.environ, {"OVSX_PAT": "secret"}), patch.object(self.module, "run", side_effect=self.forge), patch.object(self.module.subprocess, "run") as publish:
            self.module.publish("0.1.0", "token", False)
            publish.assert_called_once()
            publish.reset_mock()
            self.remote.return_value = self.asset["digest"]
            self.module.publish("0.1.0", "token", False)
            publish.assert_not_called()
            self.remote.return_value = "sha256:different"
            with self.assertRaises(ValueError):
                self.module.publish("0.1.0", "token", False)
            publish.assert_not_called()

    def test_pull_request_cannot_publish(self):
        """Even a matching repository and ref cannot authorize a PR-triggered publication."""
        os.environ["GITHUB_EVENT_NAME"] = "pull_request"
        with patch.object(self.module, "run") as run:
            with self.assertRaises(RuntimeError):
                self.module.publish("0.1.0", "token", False)
            run.assert_not_called()

    def test_remote_lookup_distinguishes_missing_from_errors(self):
        """API/network errors and inaccessible existing packages never become a fresh upload."""
        for status in (404, 403, 429, 500):
            with self.subTest(status=status), patch.object(self.module, "urlopen", side_effect=HTTPError("https://open-vsx.org", status, "error", {}, None)):
                if status == 404:
                    self.assertIsNone(self.read_remote_digest("0.1.0"))
                else:
                    with self.assertRaises(HTTPError):
                        self.read_remote_digest("0.1.0")
        metadata = {"namespace": "1c-tooling", "name": "eska-explorer", "version": "0.1.0", "targetPlatform": "universal"}
        with patch.object(self.module, "urlopen", side_effect=[io.BytesIO(json.dumps(metadata).encode()), io.BytesIO(self.payload)]):
            self.assertEqual(self.read_remote_digest("0.1.0"), self.asset["digest"])
        with patch.object(self.module, "urlopen", side_effect=[io.BytesIO(json.dumps(metadata).encode()), HTTPError("https://open-vsx.org", 404, "error", {}, None)]):
            with self.assertRaises(HTTPError):
                self.read_remote_digest("0.1.0")
