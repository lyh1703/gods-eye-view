"""Real file/AST analysis and fake-CLI contracts; no real model inference."""
import copy
import json
import os
from pathlib import Path
import subprocess
import shutil
import tempfile
import unittest
from unittest.mock import patch

try:
    from nexus_v0 import codex_model_router as r
except ModuleNotFoundError:
    import codex_model_router as r


REPO = "lyh1703/project-nexus"


def policy():
    value = copy.deepcopy(r.load_policy())
    for name, model in (("FAST", "fixture-luna"), ("STANDARD", "fixture-sol"),
                        ("DEEP", "fixture-sol"), ("CRITICAL", "fixture-astra")):
        value["profiles"][name]["model"] = model
    return value


def catalog():
    return {"schema": 1, "source": "codex app-server model/list", "inference_calls": 0,
        "cli_version": "codex-cli fixture-1", "models": [
            {"model": name, "reasoning_efforts": ["low", "medium", "high", "xhigh"]}
            for name in ("fixture-luna", "fixture-sol", "fixture-astra")]}


def meta(paths=None, instruction="Implement one ordinary bounded feature.", profile=None):
    value = dict(comment_id=123, key="ROUTER001", repository=REPO,
                 instruction=instruction, allowed_paths=paths or ["nexus_v0/feature.py"])
    if profile is not None:
        value["profile"] = profile
    return value


def context(**updates):
    value = dict(repository=REPO, coordinated_repositories=[REPO], pull_requests=[], incomplete=False)
    value.update(updates)
    return value


def write(root, files):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")


def decide(root, command, ctx=None, caps=None, configured=None):
    return r.choose_route(command, r.source_facts(root, command["allowed_paths"]),
                          ctx or context(), caps or catalog(), configured or policy())


class RouterSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_document_work_is_luna_low_even_when_prose_mentions_security(self):
        write(self.root, {"docs/guide.md": "Discuss security architecture, DROP TABLE and critical failures as prose.\n"})
        command = meta(["docs/guide.md"], "Document critical security architecture and errors.")
        route = decide(self.root, command)
        self.assertEqual((route["profile"], route["model"], route["reasoning_effort"]), ("FAST", "fixture-luna", "low"))

    def test_small_repetitive_test_work_is_fast(self):
        write(self.root, {"tests/test_basic.py": "def test_value():\n    assert 1 == 1\n"})
        self.assertEqual(decide(self.root, meta(["tests/test_basic.py"]))["profile"], "FAST")

    def test_ordinary_code_defaults_to_sol_medium(self):
        write(self.root, {"nexus_v0/feature.py": "def feature(value):\n    return value + 1\n"})
        route = decide(self.root, meta())
        self.assertEqual((route["profile"], route["reasoning_effort"]), ("STANDARD", "medium"))

    def test_large_multi_module_debug_selects_sol_high(self):
        files = {f"nexus_v0/module{i}.py": "def value():\n    return 1\n" for i in range(5)}
        write(self.root, files)
        route = decide(self.root, meta(list(files), "Diagnose and fix the multi-module regression error."))
        self.assertEqual((route["profile"], route["model"], route["reasoning_effort"]), ("DEEP", "fixture-sol", "high"))

    def test_complex_authentication_review_is_selectively_astra_high(self):
        files = {f"nexus_v0/security{i}.py": "def authorize_actor(actor):\n    if actor == 'owner':\n        return True\n    return False\n" for i in range(4)}
        write(self.root, files)
        route = decide(self.root, meta(list(files), "Review and fix authorization failure across modules."))
        self.assertEqual((route["profile"], route["model"], route["reasoning_effort"]), ("CRITICAL", "fixture-astra", "high"))

    def test_extreme_verified_complexity_can_use_supported_xhigh(self):
        files = {f"nexus_v0/security{i}.py": "def authorize_actor(actor):\n    if actor == 'owner': return True\n    return False\n" for i in range(8)}
        write(self.root, files)
        route = decide(self.root, meta(list(files), "Debug and fix the authorization error across modules."))
        self.assertEqual(route["profile"], "CRITICAL")
        self.assertEqual(route["reasoning_effort"], "xhigh")

    def test_multirepository_coordination_does_not_grant_another_repository(self):
        write(self.root, {"nexus_v0/feature.py": "def feature(): return 1\n"})
        command = meta(instruction="Implement integration with https://github.com/lyh1703/project-atlas/pull/80")
        calls = []
        ctx = r.github_context(command, lambda endpoint: calls.append(endpoint))
        route = decide(self.root, command, ctx)
        self.assertEqual(route["profile"], "DEEP")
        self.assertEqual(route["repository"], REPO)
        self.assertEqual(calls, [])
        self.assertEqual(command["allowed_paths"], ["nexus_v0/feature.py"])

    def test_named_projects_mark_coordination_without_cross_repository_reads(self):
        command = meta(instruction="Coordinate the NEXUS interface with ARGUS and ATLAS modules.")
        calls = []
        ctx = r.github_context(command, lambda endpoint: calls.append(endpoint))
        self.assertEqual(decide(self.root, command, ctx)["profile"], "DEEP")
        self.assertEqual(len(ctx["coordinated_repositories"]), 3)
        self.assertEqual(calls, [])

    def test_explicit_profile_overrides_inference_without_changing_paths(self):
        command = meta(["docs/guide.md"], profile="DEEP")
        route = decide(self.root, command)
        self.assertEqual(route["inferred_profile"], "FAST")
        self.assertEqual(route["profile"], "DEEP")
        self.assertIn("explicit_authorized_profile=DEEP", route["reasons"])

    def test_unavailable_explicit_profile_holds_no_model_call(self):
        caps = catalog()
        caps["models"] = [m for m in caps["models"] if m["model"] != "fixture-luna"]
        with patch.object(r.subprocess, "Popen") as spawn, self.assertRaises(r.RouterBlocked):
            decide(self.root, meta(["docs/a.md"], profile="FAST"), caps=caps)
        spawn.assert_not_called()

    def test_auto_fast_capability_miss_is_logged_before_initial_standard_selection(self):
        caps = catalog()
        caps["models"] = [m for m in caps["models"] if m["model"] != "fixture-luna"]
        route = decide(self.root, meta(["docs/a.md"]), caps=caps)
        self.assertEqual(route["profile"], "STANDARD")
        self.assertIn("FAST_unavailable_before_execution_using_supported_STANDARD", route["reasons"])

    def test_unsupported_reasoning_is_never_activated(self):
        caps = catalog()
        caps["models"][1]["reasoning_efforts"] = ["low", "medium"]
        with self.assertRaises(r.RouterBlocked):
            decide(self.root, meta(profile="DEEP"), caps=caps)

    def test_critical_does_not_fall_back_after_missing_capability(self):
        caps = catalog()
        caps["models"] = [m for m in caps["models"] if m["model"] != "fixture-astra"]
        with self.assertRaises(r.RouterBlocked):
            decide(self.root, meta(profile="CRITICAL"), caps=caps)

    def test_incomplete_github_context_is_not_fabricated_or_fast(self):
        command = meta(["docs/a.md"], "Explain the failure in PR #42.")
        ctx = r.github_context(command, lambda endpoint: (_ for _ in ()).throw(OSError("fixture unavailable")))
        self.assertTrue(ctx["incomplete"])
        self.assertEqual(ctx["pull_requests"], [])
        self.assertEqual(decide(self.root, command, ctx)["profile"], "STANDARD")

    def test_actual_mt_pr_metadata_changes_route_with_same_approved_file(self):
        command = meta(instruction="ARGUS MT-74 잔여 오류 해결해")
        def api(endpoint):
            if endpoint.startswith("/issues?"):
                return [dict(number=n, title="MT-74 existing work", pull_request={}) for n in (41, 42)]
            if "/files?" in endpoint:
                return [dict(filename=".github/workflows/postgis.yml")]
            return dict(changed_files=1, mergeable_state="unstable", state="open", head=dict(sha="a" * 40))
        ctx = r.github_context(command, api)
        self.assertEqual(len(ctx["pull_requests"]), 2)
        route = decide(self.root, command, ctx)
        self.assertEqual(route["profile"], "DEEP")
        self.assertIn("actual_pr_requires_integration_verification", route["reasons"])
        self.assertEqual(ctx["ci_status"], "not_queried_no_new_permissions")

    def test_foreign_repository_or_arbitrary_model_profile_is_rejected(self):
        command = meta()
        command["repository"] = "other/private"
        with self.assertRaises(r.RouterBlocked):
            decide(self.root, command)
        with self.assertRaises(r.RouterBlocked):
            decide(self.root, meta(profile="custom-model; rm -rf"))

    def test_source_traversal_and_symlink_are_rejected_before_read(self):
        with self.assertRaises(r.RouterBlocked):
            r.source_facts(self.root, ["../outside.py"])
        if os.name == "posix":
            with tempfile.TemporaryDirectory() as outside:
                secret = Path(outside) / "secret.md"
                secret.write_text("private fixture")
                (self.root / "link.md").symlink_to(secret)
                with self.assertRaises(r.RouterBlocked):
                    r.source_facts(self.root, ["link.md"])

    def test_metrics_do_not_store_source_or_quota_estimates(self):
        write(self.root, {"docs/a.md": "SOURCE_CANARY_NOT_A_REAL_SECRET"})
        route = decide(self.root, meta(["docs/a.md"]))
        self.assertNotIn("SOURCE_CANARY_NOT_A_REAL_SECRET", json.dumps(route))
        self.assertIsNone(route["remaining_account_quota"])
        self.assertEqual(route["max_attempts"], 1)
        self.assertEqual(route["timeout_seconds"], 570)

    def test_model_and_reasoning_options_are_explicit_argv_not_shell(self):
        route = decide(self.root, meta(["docs/a.md"]))
        argv = r.codex_argv(Path("/fixture/codex"), route)
        self.assertEqual(argv[2:6], ["--model", "fixture-luna", "-c", 'model_reasoning_effort="low"'])
        self.assertIn("workspace-write", argv)
        self.assertIn("--ephemeral", argv)
        self.assertNotIn("--dangerously-bypass-approvals-and-sandbox", argv)

    def test_catalog_injection_duplicate_or_wrong_source_is_rejected(self):
        for change in ("duplicate", "bad-name", "source"):
            caps = catalog()
            if change == "duplicate": caps["models"].append(caps["models"][0])
            elif change == "bad-name": caps["models"][0]["model"] = "name\n--dangerous"
            else: caps["source"] = "untrusted model guess"
            with self.subTest(change=change), self.assertRaises(r.RouterBlocked):
                decide(self.root, meta(), caps=caps)


@unittest.skipUnless(os.name == "posix", "WSL CLI process contract is POSIX")
class FakeCLIContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.cli = self.root / "fake-codex"
        self.counter = self.root / "calls.jsonl"

    def tearDown(self):
        self.temp.cleanup()

    def fake(self, failed=False, observation=True, repeated_cursor=False):
        data = catalog()
        models = [dict(model=m["model"], id="ui-" + m["model"], displayName=m["model"], hidden=False, availabilityNux={"message": "Try this supported model"},
                       supportedReasoningEfforts=[dict(reasoningEffort=x) for x in m["reasoning_efforts"]]) for m in data["models"]]
        script = '''#!/usr/bin/env python3
import json,os,sys
from pathlib import Path
counter=Path(COUNTER)
def record(data):
 with counter.open('a') as f: f.write(json.dumps(data)+'\\n')
if '--version' in sys.argv:
 print('codex-cli fixture-1'); raise SystemExit(0)
if 'app-server' in sys.argv:
 for line in sys.stdin:
  request=json.loads(line); method=request.get('method'); record({'rpc':method})
  if method=='initialized': continue
  if method=='initialize': result={'userAgent':'fixture'}
  elif method=='model/list': result={'data': MODELS, 'nextCursor': 'repeat' if REPEAT else None}
  else: raise SystemExit('unapproved RPC')
  print(json.dumps({'id':request['id'],'result':result}),flush=True)
 raise SystemExit(0)
record({'argv':sys.argv[1:],'github_token_present':'GH_TOKEN' in os.environ,'runtime_token_present':'ACTIONS_RUNTIME_TOKEN' in os.environ})
model=sys.argv[sys.argv.index('--model')+1]
effort=json.loads(sys.argv[sys.argv.index('-c')+1].split('=',1)[1])
if FAILED:
 print(json.dumps({'type':'error','message':'fixture quota limit'})); raise SystemExit(7)
if OBSERVATION:
 print('model: '+model,file=sys.stderr); print('reasoning effort: '+effort,file=sys.stderr)
print(json.dumps({'type':'thread.started','thread_id':'fixture'}))
print(json.dumps({'type':'turn.completed','usage':{'input_tokens':23,'cached_input_tokens':10,'output_tokens':7}}))
'''
        script = script.replace("COUNTER", repr(str(self.counter))).replace("MODELS", repr(models))
        script = script.replace("REPEAT", repr(repeated_cursor)).replace("FAILED", repr(failed)).replace("OBSERVATION", repr(observation))
        # setup-python builds can require LD_LIBRARY_PATH; the model environment
        # intentionally omits it. Use the OS Python for this independent fixture.
        interpreter = shutil.which("python3", path="/usr/bin:/bin")
        if interpreter is None:
            self.skipTest("System Python unavailable for clean-environment fixture")
        script = script.replace("#!/usr/bin/env python3", "#!" + interpreter, 1)
        self.cli.write_text(script, encoding="utf-8")
        self.cli.chmod(0o700)

    def setup_run(self):
        command = meta(["docs/proof.md"])
        route = decide(self.root, command)
        for name, data in (("meta", command), ("route", route), ("catalog", catalog()), ("policy", policy())):
            r.save_json(self.root / (name + ".json"), data)
        (self.root / "prompt.txt").write_text("fixture only")
        return route

    def execute(self):
        return r.execute(self.cli, self.root / "route.json", self.root / "meta.json", self.root / "catalog.json",
            self.root / "policy.json", self.root / "prompt.txt", self.root / "events.jsonl",
            self.root / "stderr.txt", self.root / "result.json")

    def calls(self):
        return [json.loads(x) for x in self.counter.read_text().splitlines()]

    def test_probe_only_uses_allowlisted_metadata_rpcs_no_inference(self):
        self.fake()
        result = r.discover_models(self.cli, timeout=5)
        self.assertEqual(len(result["models"]), 3)
        self.assertEqual(result["inference_calls"], 0)
        self.assertEqual({x["rpc"] for x in self.calls()}, {"initialize", "initialized", "model/list"})
        self.assertEqual(result["models"][0]["model"], "fixture-astra")

    def test_catalog_pagination_replay_fails_closed(self):
        self.fake(repeated_cursor=True)
        with self.assertRaises(r.RouterBlocked):
            r.discover_models(self.cli, timeout=5)
        self.assertFalse(any("argv" in x for x in self.calls()))

    def test_exact_options_usage_and_clean_environment_from_real_fake_process(self):
        self.fake()
        route = self.setup_run()
        with patch.dict(os.environ, {"GH_TOKEN": "CANARY_NOT_REAL", "ACTIONS_RUNTIME_TOKEN": "CANARY_NOT_REAL"}):
            self.assertTrue(self.execute())
        result = json.loads((self.root / "result.json").read_text())
        self.assertEqual(result["actual_model"], route["model"])
        self.assertEqual(result["actual_reasoning_effort"], "low")
        self.assertEqual(result["usage"], dict(input_tokens=23, cached_input_tokens=10, output_tokens=7))
        calls = [x for x in self.calls() if "argv" in x]
        self.assertEqual(len(calls), 1)
        self.assertFalse(calls[0]["github_token_present"])
        self.assertFalse(calls[0]["runtime_token_present"])

    def test_quota_error_does_not_retry_or_switch_to_expensive_engine(self):
        self.fake(failed=True)
        route = self.setup_run()
        self.assertFalse(self.execute())
        calls = [x for x in self.calls() if "argv" in x]
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["argv"][2], route["model"])
        result = json.loads((self.root / "result.json").read_text())
        self.assertEqual(result["attempts"], 1)
        self.assertFalse(result["success"])
        self.assertIsNone(result["usage"]["input_tokens"])

    def test_absent_observation_is_unknown_not_copied_from_requested_model(self):
        self.fake(observation=False)
        self.setup_run()
        self.assertTrue(self.execute())
        result = json.loads((self.root / "result.json").read_text())
        self.assertIsNone(result["actual_model"])
        self.assertIsNone(result["actual_reasoning_effort"])
        self.assertEqual(result["observation_source"], "explicit_cli_options_backend_not_reported")

    def test_tampered_route_never_invokes_model(self):
        self.fake()
        route = self.setup_run()
        route["model"] = "fixture-astra"
        r.save_json(self.root / "route.json", route)
        with self.assertRaises(r.RouterBlocked):
            self.execute()
        self.assertFalse(self.counter.exists())

    def test_official_cli_observation_mismatch_is_a_hold(self):
        self.fake()
        self.setup_run()
        text = self.cli.read_text().replace("'model: '+model", "'model: fixture-other'")
        self.cli.write_text(text)
        self.assertFalse(self.execute())
        result = json.loads((self.root / "result.json").read_text())
        self.assertTrue(result["routing_mismatch"])
        self.assertEqual(result["failure_kind"], "routing_mismatch")


if __name__ == "__main__":
    unittest.main()
