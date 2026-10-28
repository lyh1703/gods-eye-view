"""Authorization and actual-git inspection regressions; no model/network calls."""
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch
import codex_direct as c


def command(repository=None, path="docs/direct-test.md"):
    return c.PREFIX + json.dumps(dict(key="TEST001", repository=repository or c.REPO,
        instruction="Perform a bounded authorized documentation edit.", allowed_paths=[path]))


def event():
    issue = dict(number=c.ISSUE, state="open")
    if c.INBOX_IS_PR:
        issue["pull_request"] = {}
    return dict(action="created", repository=dict(full_name=c.REPO), issue=issue,
        comment=dict(id=123, body=command(), user=dict(login=c.OPERATOR, id=c.OPERATOR_ID)))


class RepositoryBoundaryTests(unittest.TestCase):
    def test_exact_repository_operator_and_inbox(self):
        self.assertEqual(c.verify_event(event())[0], 123)
        for field, value in (("repository", dict(full_name="lyh1703/project-nexus")),
                ("issue", dict(number=c.ISSUE + 1, state="open")),
                ("comment", dict(id=123, body=command(), user=dict(login=c.OPERATOR, id=1)))):
            obj = event()
            obj[field] = value
            with self.assertRaises(c.Blocked):
                c.verify_event(obj)
        with self.assertRaises(c.Blocked):
            c.parse_command(command("lyh1703/project-nexus"))

    def test_optional_profile_backward_compatibility_and_live_change(self):
        legacy = c.parse_command(command())
        self.assertNotIn("profile", legacy)
        for profile in ("AUTO", "FAST", "STANDARD", "DEEP", "CRITICAL"):
            self.assertEqual(c.parse_command(c.PREFIX + json.dumps(dict(legacy, profile=profile.lower())))["profile"], profile)
        for extra in ({"model": "arbitrary"}, {"profile": "unknown"}):
            with self.assertRaises(c.Blocked):
                c.parse_command(c.PREFIX + json.dumps(dict(legacy, **extra)))
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "meta.json"
            path.write_text(json.dumps(dict(comment_id=123, **legacy, profile="FAST")))
            live = dict(user=dict(login=c.OPERATOR, id=c.OPERATOR_ID),
                body=c.PREFIX + json.dumps(dict(legacy, profile="CRITICAL")),
                issue_url=f"https://api.github.com/repos/{c.REPO}/issues/{c.ISSUE}")
            with patch.object(c, "comments", return_value=[]), patch.object(c, "api", side_effect=[event()["issue"], live]), patch.object(c, "receipt") as receipt:
                with self.assertRaises(c.Blocked):
                    c.claim(path, "fixture", "1")
                receipt.assert_not_called()

    def test_control_credentials_and_traversal_are_not_model_editable(self):
        for path in ("ops/codex_direct.py", "ops/codex_model_router.py", "ops/codex_router_policy.json", ".github/workflows/test.yml", "docs/.secret",
                     "docs/../secret", "/etc/passwd", "../docs/foo", "docs//foo"):
            with self.subTest(path=path), self.assertRaises(c.Blocked):
                c.parse_command(command(path=path))

    def test_actual_unscoped_change_and_symlink_parent_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            work = root / "work"
            work.mkdir()
            subprocess.run(["git", "init", "-q", str(work)], check=True)
            (work / "docs").mkdir()
            (work / "docs/file.md").write_text("bounded\n")
            meta = root / "meta.json"
            meta.write_text(json.dumps(dict(comment_id=123, key="TEST001", allowed_paths=["docs/file.md"])))
            c.inspect(work, meta, root / "proposal.json")
            (work / "docs/extra.md").write_text("unscoped\n")
            with self.assertRaises(c.Blocked):
                c.inspect(work, meta, root / "proposal.json")

    def test_closed_or_edited_live_command_does_not_claim(self):
        with tempfile.TemporaryDirectory() as directory:
            meta = Path(directory) / "meta.json"
            data = c.parse_command(command())
            meta.write_text(json.dumps(dict(comment_id=123, **data)))
            issue = event()["issue"]
            live = dict(user=dict(login=c.OPERATOR, id=c.OPERATOR_ID), body=command(),
                issue_url=f"https://api.github.com/repos/{c.REPO}/issues/{c.ISSUE}")
            with patch.object(c, "comments", return_value=[]), patch.object(c, "api", side_effect=[dict(issue, state="closed"), live]), patch.object(c, "receipt") as receipt:
                with self.assertRaises(c.Blocked):
                    c.claim(meta, "fixture", "1")
                receipt.assert_not_called()
            live["body"] = command(path="docs/changed.md")
            with patch.object(c, "comments", return_value=[]), patch.object(c, "api", side_effect=[issue, live]), self.assertRaises(c.Blocked):
                c.claim(meta, "fixture", "1")

    def test_prior_task_claim_cannot_consume_usage_again(self):
        with tempfile.TemporaryDirectory() as directory:
            meta = Path(directory) / "meta.json"
            meta.write_text(json.dumps(dict(comment_id=123, **c.parse_command(command()))))
            live = dict(user=dict(login=c.OPERATOR, id=c.OPERATOR_ID), body=command(),
                issue_url=f"https://api.github.com/repos/{c.REPO}/issues/{c.ISSUE}")
            with patch.object(c, "api", side_effect=[event()["issue"], live]), patch.object(c, "comments", return_value=[
                dict(body="DIRECT-CODEX RECEIPT STARTED comment=123 task=TEST001 run=1")]), self.assertRaises(c.Blocked):
                c.claim(meta, "fixture", "2")


    def test_long_bounded_instruction_and_profile(self):
        base = c.parse_command(command())
        text = "Review strictly allowed files. "
        long_instruction = text + ("A" * (8000 - len(text)))
        self.assertEqual(len(long_instruction), 8000)
        body = c.PREFIX + json.dumps({
            **base, "instruction": long_instruction, "profile": "DEEP",
        })
        parsed = c.parse_command(body)
        self.assertEqual(parsed["instruction"], long_instruction)
        self.assertEqual(parsed["profile"], "DEEP")
        self.assertEqual(parsed["allowed_paths"], base["allowed_paths"])

    def test_long_command_utf8_and_invalid_unicode_rejected(self):
        base = c.parse_command(command())
        with self.assertRaisesRegex(c.Blocked, "^instruction invalid$"):
            c.parse_command(c.PREFIX + json.dumps({
                **base, "instruction": "A" * 8001,
            }))
        # Character count alone is insufficient: enforce a byte bound.
        multilingual = c.PREFIX + json.dumps({
            **base, "instruction": "가" * 4000,
        }, ensure_ascii=False)
        self.assertGreater(len(multilingual.encode("utf-8")), 12000)
        with self.assertRaisesRegex(c.Blocked, "^unsupported command$"):
            c.parse_command(multilingual)
        # Escaped lone surrogate decoded from JSON must not enter prompt files.
        invalid = c.PREFIX + json.dumps({
            **base, "instruction": chr(0xD800) * 10,
        })
        with self.assertRaisesRegex(c.Blocked, "^instruction invalid$"):
            c.parse_command(invalid)

    def test_comment_history_small_pages_and_fail_closed_replay_boundary(self):
        receipts = [{"id": i, "body": f"DIRECT-CODEX RECEIPT STARTED comment={i} task=X run=1"}
                    for i in range(35)]
        called = []
        def fake_api(method, endpoint, token):
            self.assertEqual(method, "GET")
            self.assertIn("per_page=12", endpoint)
            page = int(endpoint.rsplit("page=", 1)[1])
            called.append(page)
            return receipts[(page - 1) * 12:page * 12]
        with patch.object(c, "api", side_effect=fake_api):
            observed = c.comments("synthetic-token")
        self.assertEqual(observed, receipts)
        self.assertEqual(called, [1, 2, 3])

        def endless_api(method, endpoint, token):
            page = int(endpoint.rsplit("page=", 1)[1])
            return [{"id": (page - 1) * 12 + i} for i in range(12)]
        with patch.object(c, "api", side_effect=endless_api):
            with self.assertRaisesRegex(c.Blocked, "comment history exceeds safety bound"):
                c.comments("synthetic-token")



if __name__ == "__main__":
    unittest.main()
