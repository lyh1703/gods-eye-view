"""Deterministic, capability-gated routing for bounded local Codex tasks.

The probe uses only initialize + model/list. It never starts a thread/turn,
reads credential files, estimates account quota, or invokes an inference.
"""
from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import queue
import re
import signal
import subprocess
import threading
import time

PROFILES = ("FAST", "STANDARD", "DEEP", "CRITICAL")
EFFORTS = frozenset(("minimal", "low", "medium", "high", "xhigh"))
MODEL_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}\Z")


class RouterBlocked(Exception):
    """A stable safe reason, never raw provider exceptions or account details."""


def save_json(path, data):
    Path(path).parent.mkdir(parents=True, exist_ok=True)
    Path(path).write_text(json.dumps(data, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def digest(data):
    return hashlib.sha256(json.dumps(data, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def stop_process(process):
    if process.poll() is None:
        try:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGTERM)
            else:
                process.terminate()
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=3)
        except subprocess.TimeoutExpired:
            if os.name == "posix":
                os.killpg(process.pid, signal.SIGKILL)
            else:
                process.kill()
            process.wait(timeout=3)


def discover_models(cli, timeout=60):
    version = subprocess.run([str(cli), "--version"], capture_output=True, text=True,
                             timeout=10, check=True).stdout.strip()
    if len(version) > 120 or not version.startswith("codex-cli "):
        raise RouterBlocked("CLI_VERSION_UNVERIFIED")
    process = subprocess.Popen([str(cli), "app-server", "--listen", "stdio://"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        text=True, encoding="utf-8", start_new_session=os.name == "posix")
    messages = queue.Queue(maxsize=256)
    deadline = time.monotonic() + timeout

    def read():
        try:
            for _ in range(2000):
                line = process.stdout.readline(250001)
                if not line:
                    break
                if len(line) > 250000:
                    break
                try:
                    messages.put(json.loads(line), timeout=1)
                except (ValueError, queue.Full):
                    break
        finally:
            try:
                messages.put(None, timeout=1)
            except queue.Full:
                pass

    reader = threading.Thread(target=read, daemon=True)
    reader.start()
    sequence = 0

    def send(value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()

    def request(method, params):
        nonlocal sequence
        # This function is intentionally incapable of starting model work.
        if method not in {"initialize", "model/list"}:
            raise RouterBlocked("RPC_NOT_ALLOWLISTED")
        sequence += 1
        send({"jsonrpc": "2.0", "id": sequence, "method": method, "params": params})
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise RouterBlocked("CLI_DISCOVERY_TIMEOUT")
            try:
                message = messages.get(timeout=remaining)
            except queue.Empty:
                raise RouterBlocked("CLI_DISCOVERY_TIMEOUT") from None
            if message is None:
                raise RouterBlocked("CLI_DISCOVERY_ENDED")
            if not isinstance(message, dict):
                raise RouterBlocked("CLI_DISCOVERY_INVALID")
            if "method" in message and "id" in message:
                send({"jsonrpc": "2.0", "id": message["id"], "error": {"code": -32601, "message": "No actions authorized"}})
                continue
            if message.get("id") != sequence:
                continue
            if "error" in message or not isinstance(message.get("result"), dict):
                raise RouterBlocked("CLI_DISCOVERY_REJECTED")
            return message["result"]

    try:
        request("initialize", {"clientInfo": {"name": "nexus_router_probe", "version": "1"}})
        send({"jsonrpc": "2.0", "method": "initialized", "params": {}})
        models, seen, cursor = [], set(), None
        for _ in range(5):
            result = request("model/list", {"includeHidden": False, "limit": 100, "cursor": cursor})
            if not isinstance(result.get("data"), list):
                raise RouterBlocked("CLI_CATALOG_INVALID")
            for model in result["data"]:
                if not isinstance(model, dict) or model.get("hidden") is True:
                    continue
                # availabilityNux is informational first-use copy, not an access veto.
                # Official model/list entries and supported efforts are the capability evidence.
                name = model.get("model")
                efforts = model.get("supportedReasoningEfforts")
                if not isinstance(name, str) or not MODEL_RE.fullmatch(name) or not isinstance(efforts, list):
                    raise RouterBlocked("CLI_MODEL_INVALID")
                supported = sorted({r.get("reasoningEffort") for r in efforts
                                    if isinstance(r, dict) and r.get("reasoningEffort") in EFFORTS})
                if name in seen:
                    raise RouterBlocked("CLI_CATALOG_DUPLICATE")
                seen.add(name)
                models.append({"model": name, "reasoning_efforts": supported,
                               "display_name": str(model.get("displayName", ""))[:120]})
            new_cursor = result.get("nextCursor")
            if not new_cursor:
                break
            if new_cursor == cursor or not isinstance(new_cursor, str):
                raise RouterBlocked("CLI_CATALOG_PAGINATION")
            cursor = new_cursor
        else:
            raise RouterBlocked("CLI_CATALOG_TRUNCATED")
        if not models:
            raise RouterBlocked("CLI_CATALOG_EMPTY")
        return {"schema": 1, "cli_version": version, "source": "codex app-server model/list",
                "observed_at": datetime.now(timezone.utc).isoformat(),
                "inference_calls": 0, "remaining_account_quota": None,
                "models": sorted(models, key=lambda m: m["model"])}
    finally:
        stop_process(process)
        process.stdin.close()
        process.stdout.close()
        reader.join(timeout=2)


def load_policy(path=None):
    file = Path(path) if path else Path(__file__).with_name("codex_router_policy.json")
    policy = json.loads(file.read_text(encoding="utf-8"))
    if (policy.get("schema") != 1 or set(policy.get("profiles", {})) != set(PROFILES)
            or policy.get("max_attempts") != 1 or policy.get("timeout_seconds") != 570):
        raise RouterBlocked("POLICY_INVALID")
    for profile, spec in policy["profiles"].items():
        if (not isinstance(spec.get("model"), str) or not MODEL_RE.fullmatch(spec["model"])
                or spec.get("effort") not in EFFORTS
                or any(v not in EFFORTS for v in spec.get("extra_efforts", []))):
            raise RouterBlocked("POLICY_PROFILE_INVALID")
    return policy


def source_facts(workspace, paths):
    """Inspect only approved regular files; store metrics, never source text."""
    root = Path(workspace).resolve()
    facts = dict(file_count=len(paths), code_files=0, test_files=0, doc_files=0,
        total_bytes=0, branches=0, functions=0, imports=0, modules=[], risks=[],
        truncated=False, file_hashes={})
    modules, risks = set(), set()
    if not 1 <= len(paths) <= 8 or len(set(paths)) != len(paths):
        raise RouterBlocked("SOURCE_PATHS_INVALID")
    for path in paths:
        if not isinstance(path, str):
            raise RouterBlocked("SOURCE_PATH_INVALID")
        p = PurePosixPath(path)
        if (str(p) != path or p.is_absolute()
                or any(s.startswith(".") or s in {"", ".."} for s in p.parts)):
            raise RouterBlocked("SOURCE_PATH_INVALID")
        file = root / path
        if (file.is_symlink() or any(v.is_symlink() for v in file.parents)
                or not file.resolve().is_relative_to(root)):
            raise RouterBlocked("SOURCE_PATH_ESCAPES_WORKSPACE")
        is_test = ("tests" in p.parts or p.name.startswith("test_")
                   or bool(re.search(r"[.]test[.]|[.]spec[.]", p.name)))
        is_doc = p.suffix.lower() in {".md", ".rst", ".txt", ".adoc"}
        facts["test_files" if is_test else "doc_files" if is_doc else "code_files"] += 1
        if not is_test and not is_doc:
            modules.add(str(p.with_suffix("")))
        if not file.exists():
            facts["file_hashes"][path] = None
            continue
        if not file.is_file():
            raise RouterBlocked("SOURCE_NOT_REGULAR")
        size = file.stat().st_size
        facts["total_bytes"] += size
        with file.open("rb") as stream:
            data = stream.read(40001)
        if len(data) > 40000:
            facts["truncated"] = True
            facts["file_hashes"][path] = "bounded-read-only"
            continue
        facts["file_hashes"][path] = hashlib.sha256(data).hexdigest()
        try:
            text = data.decode("utf-8")
        except UnicodeError:
            facts["truncated"] = True
            continue
        if is_doc:
            continue
        literals = []
        try:
            tree = ast.parse(text) if p.suffix == ".py" else None
        except SyntaxError:
            tree = None
            facts["truncated"] = True
        if tree is not None:
            for node in ast.walk(tree):
                facts["branches"] += isinstance(node, (ast.If, ast.For, ast.While, ast.Try, ast.IfExp, ast.BoolOp))
                facts["functions"] += isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
                facts["imports"] += isinstance(node, (ast.Import, ast.ImportFrom))
                if isinstance(node, ast.Constant) and isinstance(node.value, str):
                    literals.append(node.value)
                if not is_test and isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    if re.search(r"authoriz|authenticat|verify_(?:event|claim|token)|validate_access|^approve", node.name):
                        risks.add("authentication_or_approval_boundary")
                if not is_test and isinstance(node, ast.Call):
                    name = node.func.id if isinstance(node.func, ast.Name) else getattr(node.func, "attr", "")
                    if name in {"eval", "exec"} or any(k.arg == "shell" and isinstance(k.value, ast.Constant) and k.value.value is True for k in node.keywords):
                        risks.add("dynamic_execution_boundary")
                    if name in {"submit_order", "place_order", "transfer_funds", "withdraw", "send_transaction"}:
                        risks.add("financial_execution_boundary")
        else:
            facts["branches"] += len(re.findall(r"\b(?:if|for|while|catch|switch)\s*\(", text))
            facts["functions"] += len(re.findall(r"\bfunction\b|=>", text))
            facts["imports"] += len(re.findall(r"\bimport\s|\brequire\(", text))
            literals = [text] if p.suffix in {".sql", ".js", ".mjs", ".ts"} else []
        if not is_test:
            sql = "\n".join(literals)
            if re.search(r"\b(?:DROP|ALTER)\s+(?:TABLE|SCHEMA|POLICY|ROLE)\b|\b(?:GRANT|REVOKE)\b|CREATE\s+POLICY", sql, re.I):
                risks.add("destructive_schema_or_access_change")
            if re.search(r"\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|BEGIN\s+IMMEDIATE)\b", sql, re.I):
                risks.add("persistent_data_integrity")
    facts["modules"], facts["risks"] = sorted(modules), sorted(risks)
    return facts


def github_context(meta, api_get=None):
    """Read bounded current-repository PR context. Never grant foreign access."""
    instruction = meta["instruction"]
    local = meta["repository"]
    known = {"lyh1703/" + n for n in ("project-nexus", "project-atlas", "gods-eye-view", "project-metron")}
    repos = {local}
    for alias, name in (("NEXUS", "project-nexus"), ("ARGUS", "gods-eye-view"),
                        ("ATLAS", "project-atlas"), ("METRON", "project-metron")):
        if re.search(r"\b" + alias + r"\b", instruction, re.I):
            repos.add("lyh1703/" + name)
    for repo in known:
        if repo in instruction:
            repos.add(repo)
    refs = {int(n) for n in re.findall(r"\bPR\s*#?\s*(\d+)\b", instruction, re.I)}
    for owner, repo, number in re.findall(r"https://github[.]com/([^/\s]+)/([^/\s]+)/pull/(\d+)", instruction):
        full = owner + "/" + repo
        if full in known:
            repos.add(full)
        if full == local:
            refs.add(int(number))
    result = {"repository": local, "coordinated_repositories": sorted(repos), "pull_requests": [],
              "incomplete": False, "integration_verification_context": False,
              "ci_status": "not_queried_no_new_permissions"}
    workitems = {int(n) for n in re.findall(r"\bMT[-_ ]?(\d+)\b", instruction, re.I)}
    if api_get is None:
        result["incomplete"] = bool(refs or workitems)
        return result
    try:
        if workitems:
            rows = api_get("/issues?state=open&per_page=100")
            if not isinstance(rows, list):
                raise ValueError("invalid issue context")
            result["incomplete"] |= len(rows) >= 100
            for row in rows:
                markers = {int(n) for n in re.findall(r"\bMT[-_ ]?(\d+)\b", str(row.get("title", "")), re.I)}
                if workitems & markers and "pull_request" in row and isinstance(row.get("number"), int):
                    refs.add(row["number"])
        if len(refs) > 3:
            result["incomplete"] = True
        for number in sorted(refs)[:3]:
            if not 0 < number < 2**31:
                raise ValueError("invalid PR")
            pr = api_get(f"/pulls/{number}")
            files = api_get(f"/pulls/{number}/files?per_page=100")
            if not isinstance(pr, dict) or not isinstance(files, list):
                raise ValueError("invalid PR context")
            filenames = [f["filename"] for f in files if isinstance(f, dict) and isinstance(f.get("filename"), str)]
            count = pr.get("changed_files")
            if type(count) is not int or count < len(filenames):
                raise ValueError("invalid file count")
            result["incomplete"] |= count > len(filenames)
            result["integration_verification_context"] |= any(
                f.startswith((".github/workflows/", "db/", "migrations/"))
                or ".postgres.test." in f for f in filenames)
            result["pull_requests"].append({"number": number, "head_sha": pr.get("head", {}).get("sha"),
                "changed_files": count, "filenames": filenames,
                "mergeable_state": pr.get("mergeable_state", "unknown"), "state": pr.get("state", "unknown")})
    except Exception:
        # Metadata is optional evidence, not authority. Never invent CI success.
        result["incomplete"] = True
    return result


def infer_profile(meta, facts, context):
    instruction = meta["instruction"]
    prs = context.get("pull_requests", [])
    largest_pr = max((p["changed_files"] for p in prs), default=0)
    debug = bool(re.search(r"error|failure|regression|bug|fault|오류|실패|결함", instruction, re.I)
                 and re.search(r"fix|debug|diagnos|root cause|수정|해결|분석|복구", instruction, re.I))
    score = max(0, facts["file_count"] - 2) + max(0, len(facts["modules"]) - 1)
    score += min(2, facts["branches"] // 30) + int(facts["total_bytes"] > 30000)
    score += min(2, facts["imports"] // 12)
    score += (4 if largest_pr >= 12 else 2 if largest_pr >= 4 else 0)
    score += 2 * int(len(prs) > 1)
    score += int(any(p.get("mergeable_state") in {"dirty", "unstable", "blocked"} for p in prs))
    score += 2 * int(bool(debug and (facts["code_files"] or prs)))
    score += int(context.get("integration_verification_context", False))
    coordination = len(context.get("coordinated_repositories", [])) > 1
    score += 3 * int(coordination and facts["code_files"] > 0)
    score += 2 * int(facts["truncated"]) + int(context.get("incomplete", False))
    high_impact = set(facts["risks"]) - {"persistent_data_integrity"}
    score += 2 if high_impact else int(bool(facts["risks"]))
    reasons = [f"approved_files={facts['file_count']}", f"code_modules={len(facts['modules'])}",
        f"source_branches={facts['branches']}", f"linked_prs={len(prs)}", f"largest_pr_files={largest_pr}",
        f"coordination_repositories={len(context.get('coordinated_repositories', []))}"]
    if debug:
        reasons.append("debug_intent_with_structural_context")
    if context.get("integration_verification_context"):
        reasons.append("actual_pr_requires_integration_verification")
    if facts["risks"]:
        reasons.append("source_risk=" + ",".join(facts["risks"]))
    if context.get("incomplete") or facts["truncated"]:
        reasons.append("incomplete_context_no_fast_assumption")
    docs_only = facts["doc_files"] == facts["file_count"]
    tests_only = facts["test_files"] == facts["file_count"]
    if high_impact and score >= 7:
        profile = "CRITICAL"
    elif score >= 6 or (coordination and facts["code_files"] > 0):
        profile = "DEEP"
    elif (facts["file_count"] <= 2 and facts["total_bytes"] <= 24000 and not prs
          and not context.get("incomplete") and not facts["truncated"]
          and (docs_only or tests_only)):
        profile = "FAST"
    else:
        profile = "STANDARD"
    return profile, score, reasons


def choose_route(meta, facts, context, catalog, policy):
    if meta.get("repository") not in policy["repositories"] or context.get("repository") != meta["repository"]:
        raise RouterBlocked("REPOSITORY_NOT_AUTHORIZED")
    if (catalog.get("schema") != 1 or catalog.get("source") != "codex app-server model/list"
            or catalog.get("inference_calls") != 0):
        raise RouterBlocked("CAPABILITIES_UNVERIFIED")
    available = {}
    if not isinstance(catalog.get("models"), list) or not isinstance(catalog.get("cli_version"), str):
        raise RouterBlocked("CATALOG_INVALID")
    for model in catalog["models"]:
        if (not isinstance(model, dict) or not isinstance(model.get("model"), str)
                or not MODEL_RE.fullmatch(model["model"])
                or not isinstance(model.get("reasoning_efforts"), list)
                or any(v not in EFFORTS for v in model["reasoning_efforts"])
                or model["model"] in available):
            raise RouterBlocked("CATALOG_INVALID")
        available[model["model"]] = set(model["reasoning_efforts"])
    inferred, score, reasons = infer_profile(meta, facts, context)
    requested = meta.get("profile", "AUTO")
    if requested not in (*PROFILES, "AUTO"):
        raise RouterBlocked("PROFILE_INVALID")
    chosen = inferred if requested == "AUTO" else requested
    if requested != "AUTO":
        reasons.append("explicit_authorized_profile=" + requested)
    spec = policy["profiles"][chosen]
    supported = lambda s: s.get("enabled") is True and s["effort"] in available.get(s["model"], set())
    if not supported(spec):
        # A pre-invocation capability miss is recorded, never a retry/fallback
        # after a provider/model/quota error. Explicit unavailable FAST holds.
        if chosen == "FAST" and requested == "AUTO" and supported(policy["profiles"]["STANDARD"]):
            reasons.append("FAST_unavailable_before_execution_using_supported_STANDARD")
            chosen, spec = "STANDARD", policy["profiles"]["STANDARD"]
        else:
            raise RouterBlocked("SELECTED_PROFILE_UNSUPPORTED")
    effort = spec["effort"]
    if (chosen == "CRITICAL" and score >= 14 and "xhigh" in spec.get("extra_efforts", [])
            and "xhigh" in available.get(spec["model"], set())):
        effort = "xhigh"
        reasons.append("extreme_verified_complexity_xhigh")
    return {"schema": 1, "repository": meta["repository"], "task_key": meta["key"],
        "requested_profile": requested, "inferred_profile": inferred, "profile": chosen,
        "model": spec["model"], "reasoning_effort": effort, "complexity_score": score,
        "reasons": reasons, "facts": facts, "github_context": context,
        "expected_runtime_class": "short" if chosen == "FAST" else "extended" if chosen in {"DEEP", "CRITICAL"} else "normal",
        "timeout_seconds": 570, "max_attempts": 1, "remaining_account_quota": None,
        "cli_version": catalog["cli_version"], "meta_sha256": digest(meta),
        "policy_sha256": digest(policy), "catalog_sha256": digest(catalog)}


def codex_argv(cli, route):
    if not MODEL_RE.fullmatch(route["model"]) or route["reasoning_effort"] not in EFFORTS:
        raise RouterBlocked("MODEL_OPTION_INVALID")
    return [str(cli), "exec", "--model", route["model"], "-c",
            "model_reasoning_effort=" + json.dumps(route["reasoning_effort"]),
            "--sandbox", "workspace-write", "--ephemeral", "--json", "-"]


def read_execution(events, stderr, returncode, timed_out=False):
    completed, failed, usages, observed_models, observed_efforts = 0, False, [], set(), set()
    file = Path(events)
    if file.stat().st_size > 16000000:
        raise RouterBlocked("CLI_EVENTS_TOO_LARGE")
    for line in file.read_text(encoding="utf-8").splitlines():
        event = json.loads(line)
        if not isinstance(event, dict):
            raise RouterBlocked("CLI_EVENT_INVALID")
        kind = event.get("type")
        failed |= kind in {"turn.failed", "error"}
        if kind in {"thread.started", "turn.started", "turn.completed", "session.started"}:
            if isinstance(event.get("model"), str):
                observed_models.add(event["model"])
            if isinstance(event.get("reasoning_effort"), str):
                observed_efforts.add(event["reasoning_effort"])
        if kind == "turn.completed":
            completed += 1
            usage = event.get("usage")
            if isinstance(usage, dict):
                usages.append({k: v for k, v in usage.items()
                               if k in {"input_tokens", "cached_input_tokens", "output_tokens"} and type(v) is int and v >= 0})
    # Only official stderr header fields, never agent text/command outputs.
    with Path(stderr).open(encoding="utf-8", errors="replace") as stream:
        header = stream.read(16000)
    observed_models.update(re.findall(r"(?m)^model:\s*([A-Za-z0-9._:/-]+)\s*$", header))
    observed_efforts.update(re.findall(r"(?m)^reasoning effort:\s*(minimal|low|medium|high|xhigh)\s*$", header))
    usage = {k: sum(u[k] for u in usages) if len(usages) == completed and usages and all(k in u for u in usages) else None
             for k in ("input_tokens", "cached_input_tokens", "output_tokens")}
    return {"success": returncode == 0 and completed > 0 and not failed and not timed_out,
        "returncode": returncode, "timed_out": timed_out, "completed_turns": completed,
        "observed_models": sorted(observed_models), "observed_reasoning_efforts": sorted(observed_efforts),
        "usage": usage, "usage_source": "official_turn_completed_events" if usages else "not_reported",
        "remaining_account_quota": None, "attempts": 1}


def execute(cli, route_path, meta_path, catalog_path, policy_path, prompt, events, stderr, result_path):
    route = json.loads(Path(route_path).read_text())
    meta = json.loads(Path(meta_path).read_text())
    catalog = json.loads(Path(catalog_path).read_text())
    policy = load_policy(policy_path)
    expected = choose_route(meta, route["facts"], route["github_context"], catalog, policy)
    if any(route.get(k) != expected[k] for k in expected):
        raise RouterBlocked("ROUTING_BINDING_CHANGED")
    version = subprocess.run([str(cli), "--version"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
    if version != route["cli_version"]:
        raise RouterBlocked("CLI_CHANGED_AFTER_DISCOVERY")
    if "base_sha" in route:
        actual = subprocess.run(["git", "rev-parse", "HEAD"], capture_output=True, text=True, timeout=10, check=True).stdout.strip()
        if actual != route["base_sha"]:
            raise RouterBlocked("WORKSPACE_BASE_CHANGED")
    if "base_sha" in route and source_facts(Path.cwd(), meta["allowed_paths"]) != route["facts"]:
        raise RouterBlocked("APPROVED_SOURCE_CHANGED_AFTER_ROUTING")
    argv = codex_argv(cli, route)
    started = time.monotonic()
    timed_out, cancelled = False, False
    # Explicit clean environment also defends callers outside the workflow.
    env = {key: os.environ[key] for key in ("HOME", "PATH", "LANG") if key in os.environ}
    with Path(prompt).open("rb") as inp, Path(events).open("wb") as out, Path(stderr).open("wb") as err:
        process = subprocess.Popen(argv, stdin=inp, stdout=out, stderr=err, env=env,
                                   start_new_session=os.name == "posix")
        previous = {}
        def cancel(signum, frame):
            nonlocal cancelled
            cancelled = True
            stop_process(process)
        if os.name == "posix" and threading.current_thread() is threading.main_thread():
            for sig in (signal.SIGTERM, signal.SIGINT):
                previous[sig] = signal.signal(sig, cancel)
        try:
            process.wait(timeout=570)
        except subprocess.TimeoutExpired:
            timed_out = True
            stop_process(process)
        finally:
            for sig, handler in previous.items():
                signal.signal(sig, handler)
    try:
        result = read_execution(events, stderr, process.returncode, timed_out)
    except (ValueError, OSError, RouterBlocked):
        result = {"success": False, "attempts": 1, "usage": None, "usage_source": "unverified",
                  "remaining_account_quota": None, "observed_models": [], "observed_reasoning_efforts": []}
    mismatch = any(m != route["model"] for m in result["observed_models"]) or any(e != route["reasoning_effort"] for e in result["observed_reasoning_efforts"])
    result.update(profile=route["profile"], executed_model=route["model"], executed_reasoning_effort=route["reasoning_effort"],
        model_options=argv[2:6], elapsed_seconds=round(time.monotonic() - started, 3),
        observation_source="official_cli" if result["observed_models"] else "explicit_cli_options_backend_not_reported",
        actual_model=result["observed_models"][0] if len(result["observed_models"]) == 1 else None,
        actual_reasoning_effort=result["observed_reasoning_efforts"][0] if len(result["observed_reasoning_efforts"]) == 1 else None,
        routing_mismatch=mismatch)
    result["success"] &= not mismatch and not cancelled
    result["failure_kind"] = ("cancelled" if cancelled else "timeout" if timed_out else
        "routing_mismatch" if mismatch else None if result["success"] else "cli_or_model_error")
    save_json(result_path, result)
    print("ROUTER_EXECUTION=" + json.dumps(result, sort_keys=True))
    return result["success"]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    probe = sub.add_parser("probe")
    probe.add_argument("--cli", required=True, type=Path)
    probe.add_argument("--output", required=True, type=Path)
    probe.add_argument("--policy", type=Path)
    run = sub.add_parser("execute")
    for flag in ("cli", "route", "meta", "catalog", "policy", "prompt", "events", "stderr", "result"):
        run.add_argument("--" + flag, required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "probe":
            result = discover_models(args.cli)
            print("ROUTER_CAPABILITIES=" + json.dumps(result, sort_keys=True))
            if args.policy:
                policy = load_policy(args.policy)
                available = {m["model"]: set(m["reasoning_efforts"]) for m in result["models"]}
                for spec in policy["profiles"].values():
                    required = {spec["effort"], *spec.get("extra_efforts", [])}
                    if spec.get("enabled") is not True or not required <= available.get(spec["model"], set()):
                        raise RouterBlocked("CONFIGURED_PROFILE_UNSUPPORTED")
                print("ROUTER_ALL_CONFIGURED_PROFILES=SUPPORTED")
            save_json(args.output, result)
        elif args.command == "execute":
            return 0 if execute(args.cli, args.route, args.meta, args.catalog, args.policy,
                                args.prompt, args.events, args.stderr, args.result) else 2
        return 0
    except (RouterBlocked, OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        print("ROUTER_HOLD=" + (str(exc) if isinstance(exc, RouterBlocked) else "INVALID_OR_UNAVAILABLE_RUNTIME"))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
