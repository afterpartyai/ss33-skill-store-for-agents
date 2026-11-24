"""Unit tests for the Hermes plugin's Python shim (adapters/hermes/__init__.py), standard library only.

test/hermes.test.ts runs the shim end to end (real launcher, real CLI, fake store). These cover its own
branches with the CLI process replaced, so they run in milliseconds on any OS:

    python3 -m unittest discover -s test/python          (npm run test:python)
    coverage run --branch -m unittest discover -s test/python && coverage report   (CI, with a threshold)
"""

from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

PLUGIN = Path(__file__).resolve().parents[2] / "adapters" / "hermes"


def load_shim():
    """A fresh copy of the plugin module, as Hermes loads it (a package from a folder)."""
    spec = importlib.util.spec_from_file_location("ss33_hermes_plugin", PLUGIN / "__init__.py", submodule_search_locations=[str(PLUGIN)])
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


class Handle:
    def __init__(self, ok=True, error=None):
        self.ok, self.error = ok, error


class Ctx:
    """Stands in for Hermes's PluginContext: only what the shim calls, recording what it registers."""

    def __init__(self, cwd="/proj", surface="cli", handle=None):
        self.cwd, self.surface, self.handle = cwd, surface, handle or Handle()
        self.hooks, self.tools, self.skills, self.posted = {}, {}, {}, []

    def session_cwd(self):
        return self.cwd

    def session_surface(self):
        return self.surface

    def post_message(self, text):
        self.posted.append(text)
        return self.handle

    def register_hook(self, name, cb):
        self.hooks[name] = cb

    def register_tool(self, name, toolset, schema, handler, **kw):
        self.tools[name] = {"toolset": toolset, "schema": schema, "handler": handler, **kw}

    def register_skill(self, name, path, description="", frontmatter=None):
        self.skills[name] = {"path": Path(path), "description": description, "frontmatter": frontmatter}


def done(stdout="", stderr="", code=0):
    return subprocess.CompletedProcess(args=[], returncode=code, stdout=stdout, stderr=stderr)


def executable(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("#!/bin/sh\n")
    path.chmod(0o755)
    return path


class ShimTest(unittest.TestCase):
    """Every test gets a fresh module and an environment with nothing from the developer's machine."""

    def setUp(self):
        self.mod = load_shim()
        self.tmp = Path(tempfile.mkdtemp(prefix="ss33-pytest-"))
        # ProgramFiles/LOCALAPPDATA too: a Windows runner has a real Git there, which the shell lookup would find.
        clean = {k: v for k, v in os.environ.items() if not k.upper().startswith(("SS33_", "HERMES", "XDG_", "LOCALAPPDATA", "PROGRAMFILES", "PROGRAMW6432"))}
        clean["HOME"] = str(self.tmp / "home")
        clean["USERPROFILE"] = clean["HOME"]
        patcher = mock.patch.dict(os.environ, clean, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def register(self, **ctx_kw):
        ctx = Ctx(**ctx_kw)
        self.mod.register(ctx)
        return ctx

    def write_config(self, text: str) -> None:
        cfg = self.tmp / "cfg"
        cfg.mkdir(exist_ok=True)
        (cfg / "config.json").write_text(text, encoding="utf-8")
        os.environ["SS33_CONFIG_DIR"] = str(cfg)


class MatchingOn(ShimTest):
    """Keep in step with loadConfig in src/core/config.ts (and matchingOn in adapters/dsh/index.js)."""

    def test_env_flag_wins(self):
        self.write_config('{"match": {"enabled": true}}')
        for value, expected in (("1", True), ("TRUE", True), ("on", True), ("0", False), ("off", False), ("nope", False)):
            os.environ["SS33_MATCH"] = value
            self.assertIs(self.mod._matching_on(), expected, value)

    def test_config_file(self):
        os.environ["SS33_CONFIG_DIR"] = str(self.tmp / "none")
        self.assertFalse(self.mod._matching_on(), "no config file: off (the default)")
        self.write_config('{"match": {"enabled": true}}')
        self.assertTrue(self.mod._matching_on())
        self.write_config('{"match": {"enabled": "yes"}}')
        self.assertFalse(self.mod._matching_on(), "only a real true counts, as in the CLI")
        self.write_config('{"match": null}')
        self.assertFalse(self.mod._matching_on())
        self.write_config("{broken")
        self.assertTrue(self.mod._matching_on(), "unreadable config: let the CLI decide")

    def test_default_locations(self):
        xdg = self.tmp / "xdg"
        (xdg / "ss33").mkdir(parents=True)
        (xdg / "ss33" / "config.json").write_text('{"match": {"enabled": true}}')
        os.environ["XDG_CONFIG_HOME"] = str(xdg)
        self.assertTrue(self.mod._matching_on())
        del os.environ["XDG_CONFIG_HOME"]
        home_cfg = Path(os.environ["HOME"]) / ".config" / "ss33"
        home_cfg.mkdir(parents=True)
        (home_cfg / "config.json").write_text('{"match": {"enabled": true}}')
        self.assertTrue(self.mod._matching_on(), "~/.config/ss33 when XDG_CONFIG_HOME is unset")


class HermesNode(ShimTest):
    def test_homes_include_the_profile_root_and_platform_defaults_once(self):
        root = self.tmp / "hermes"
        os.environ["HERMES_HOME"] = str(root / "profiles" / "work") + os.sep
        os.environ["LOCALAPPDATA"] = str(self.tmp / "local")
        home = os.path.join(os.path.expanduser("~"), ".hermes")
        self.assertEqual(self.mod._hermes_homes(), [os.environ["HERMES_HOME"], str(root), home, str(self.tmp / "local" / "hermes")])
        os.environ["HERMES_HOME"] = home
        self.assertEqual(self.mod._hermes_homes().count(home), 1, "no duplicates")

    def test_version_key(self):
        self.assertEqual(self.mod._version_key("node-26.12.1-linux-x64"), (26, 12, 1))
        self.assertEqual(self.mod._version_key("node"), ())

    @unittest.skipIf(os.name == "nt", "POSIX layout (bin/node)")
    def test_newest_tools_node_wins_then_the_old_layout(self):
        root = self.tmp / "hermes"
        os.environ["HERMES_HOME"] = str(root)
        self.assertIsNone(self.mod._hermes_node())
        old = executable(root / "node" / "bin" / "node")
        self.assertEqual(self.mod._hermes_node(), str(old), "older Hermes releases: <home>/node")
        executable(root / "tools" / "node-24.1.0-linux-x64" / "bin" / "node")
        newest = executable(root / "tools" / "node-26.2.0-linux-x64" / "bin" / "node")
        (root / "tools" / "node-30.0.0-broken").mkdir()  # no binary: skipped
        not_exec = root / "tools" / "node-31.0.0-linux-x64" / "bin" / "node"
        not_exec.parent.mkdir(parents=True)
        not_exec.write_text("")  # not executable: skipped
        self.assertEqual(self.mod._hermes_node(), str(newest))


class ApiKeyAndEnv(ShimTest):
    def with_secret_scope(self, get_secret):
        agent = types.ModuleType("agent")
        scope = types.ModuleType("agent.secret_scope")
        scope.get_secret = get_secret
        patcher = mock.patch.dict(sys.modules, {"agent": agent, "agent.secret_scope": scope})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_no_hermes_lookup_means_no_key(self):
        with mock.patch.dict(sys.modules, {"agent": None, "agent.secret_scope": None}):
            self.assertIsNone(self.mod._api_key())

    def test_key_only_from_the_profile_scoped_lookup(self):
        self.with_secret_scope(lambda name: {"SS33_API_KEY": "sk-profile"}.get(name))
        self.assertEqual(self.mod._api_key(), "sk-profile")

    def test_a_failing_or_empty_lookup_never_guesses(self):
        def boom(_name):
            raise RuntimeError("no profile scope bound")

        self.with_secret_scope(boom)
        self.assertIsNone(self.mod._api_key())
        self.with_secret_scope(lambda _name: "")
        self.assertIsNone(self.mod._api_key())

    def test_env_drops_the_inherited_key_and_adds_node_and_the_scoped_key(self):
        os.environ["SS33_API_KEY"] = "sk-other-profile"
        with mock.patch.object(self.mod, "_hermes_node", return_value="C:\\hermes\\tools\\node.exe"), mock.patch.object(self.mod, "_api_key", return_value="sk-mine"):
            env = self.mod._env()
        self.assertNotIn("SS33_API_KEY", env)
        self.assertEqual(env["SS33_HOST_NODE"], "C:/hermes/tools/node.exe", "the launcher is POSIX sh, also on Windows")
        self.assertEqual(env["SS33_PLUGIN_API_KEY"], "sk-mine")
        with mock.patch.object(self.mod, "_hermes_node", return_value=None), mock.patch.object(self.mod, "_api_key", return_value=None):
            env = self.mod._env()
        self.assertNotIn("SS33_HOST_NODE", env)
        self.assertNotIn("SS33_PLUGIN_API_KEY", env)


class Shell(ShimTest):
    def which(self, found: dict[str, str]):
        return mock.patch.object(self.mod.shutil, "which", side_effect=lambda name: found.get(name))

    def test_sh_or_bash_from_path_and_the_answer_is_cached(self):
        with self.which({"bash": "/usr/bin/bash"}) as which:
            self.assertEqual(self.mod._shell(), "/usr/bin/bash")
            self.assertEqual(self.mod._shell(), "/usr/bin/bash")
        self.assertEqual(which.call_count, 2, "sh, then bash, once")

    def test_windows_git_bash_next_to_git_exe_on_path(self):
        git = self.tmp / "Git" / "cmd" / "git.exe"
        bash = self.tmp / "Git" / "bin" / "bash.exe"
        for f in (git, bash):
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_text("")
        with self.which({"git": str(git)}), mock.patch.object(self.mod.os, "name", "nt"):
            self.assertEqual(self.mod._shell(), os.path.join(os.path.realpath(self.tmp / "Git"), "bin", "bash.exe"))

    def test_windows_git_for_windows_per_user_install(self):
        local = self.tmp / "local"
        bash = local / "Programs" / "Git" / "usr" / "bin" / "bash.exe"
        bash.parent.mkdir(parents=True)
        bash.write_text("")
        os.environ["LOCALAPPDATA"] = str(local)
        with self.which({}), mock.patch.object(self.mod.os, "name", "nt"):
            self.assertEqual(self.mod._shell(), str(bash))

    def test_nothing_found_falls_back_to_sh(self):
        with self.which({}), mock.patch.object(self.mod.os, "name", "nt"):
            self.assertEqual(self.mod._shell(), "sh")
        self.mod._shell_path = None
        with self.which({}), mock.patch.object(self.mod.os, "name", "posix"):
            self.assertEqual(self.mod._shell(), "sh", "POSIX never searches Git folders")

    def test_run_starts_the_launcher_with_the_shim_env(self):
        self.mod._shell_path = "/bin/sh"
        with mock.patch.object(self.mod, "_env", return_value={"X": "1"}), mock.patch.object(self.mod.subprocess, "run", return_value=done()) as run:
            self.mod._run(["version"], timeout=3)
            self.mod._run(["search", "q"], stdin="{}", cwd="/proj", timeout=4)
        first, second = run.call_args_list
        self.assertEqual(first.args[0], ["/bin/sh", self.mod.LAUNCHER.as_posix(), "version"])
        self.assertEqual((first.kwargs["cwd"], first.kwargs["env"], first.kwargs["timeout"]), (None, {"X": "1"}, 3), "no cwd: the gateway's own")
        self.assertEqual((second.kwargs["cwd"], second.kwargs["input"]), ("/proj", "{}"))


class Helpers(ShimTest):
    def test_prompt_text(self):
        self.assertEqual(self.mod._prompt_text("hi"), "hi")
        parts = [{"type": "text", "text": "a"}, {"type": "image_url", "image_url": {}}, {"type": "input_text", "text": "b"}, "junk"]
        self.assertEqual(self.mod._prompt_text(parts), "a\nb", "images and junk are dropped")
        self.assertEqual(self.mod._prompt_text(None), "")
        self.assertEqual(self.mod._prompt_text([{"type": "image_url"}]), "")

    def test_session_survives_a_context_without_session_methods(self):
        self.assertEqual(self.mod._session(Ctx(cwd=None, surface=None), "telegram"), ("", "telegram"))

        class Old:  # a Hermes older than 0.22.3
            pass

        self.assertEqual(self.mod._session(Old(), "cli"), ("", "cli"))
        self.assertEqual(self.mod._session(Old(), ""), ("", ""))

    def test_description_from_frontmatter_only(self):
        md = self.tmp / "SKILL.md"
        md.write_text("---\nname: x\n---\ndescription: in the body\n")
        self.assertEqual(self.mod._description(md), "", "a description after the frontmatter doesn't count")
        md.write_text("---\nname: x\ndescription:   Find skills.  \n---\n")
        self.assertEqual(self.mod._description(md), "Find skills.")


class Register(ShimTest):
    def test_registers_hooks_tool_and_gated_skills(self):
        ctx = self.register()
        self.assertEqual(sorted(ctx.hooks), ["on_session_start", "pre_llm_call"])
        self.assertEqual(ctx.tools["ss33_search"]["toolset"], "ss33")
        self.assertEqual(ctx.tools["ss33_search"]["schema"]["name"], "ss33_search")
        self.assertEqual(sorted(ctx.skills), ["add", "list", "search", "setup", "update"])
        for name, skill in ctx.skills.items():
            self.assertTrue(skill["description"], name)
            self.assertEqual(skill["frontmatter"]["name"], name)
            gate = skill["frontmatter"]["metadata"]["hermes"]
            self.assertEqual(gate, {"fallback_for_tools": ["ss33_search"]} if name == "search" else {"fallback_for_toolsets": ["ss33"]})


class PreLlmCall(ShimTest):
    def setUp(self):
        super().setUp()
        os.environ["SS33_MATCH"] = "1"
        self.ctx = self.register(cwd="/proj", surface="cli")
        self.hook = self.ctx.hooks["pre_llm_call"]

    def run_with(self, result):
        patch = mock.patch.object(self.mod, "_run", side_effect=result) if isinstance(result, BaseException) else mock.patch.object(self.mod, "_run", return_value=result)
        return patch

    def test_off_or_empty_prompt_starts_no_process(self):
        with mock.patch.object(self.mod, "_run") as run:
            os.environ["SS33_MATCH"] = "0"
            self.assertIsNone(self.hook(session_id="s", user_message="set up ci", platform="cli"))
            os.environ["SS33_MATCH"] = "1"
            self.assertIsNone(self.hook(session_id="s", user_message=[{"type": "image_url"}], platform="cli"))
        run.assert_not_called()

    def test_context_for_the_model_and_a_notice_for_the_user(self):
        out = json.dumps({"context": "a skill may fit", "notice": "ss33: try /ss33:add a/b-1"})
        with self.run_with(done(out)) as run:
            self.assertEqual(self.hook(session_id="s-1", user_message="set up ci", platform="telegram"), {"context": "a skill may fit"})
        self.assertEqual(self.ctx.posted, ["ss33: try /ss33:add a/b-1"])
        args, kwargs = run.call_args
        self.assertEqual(args[0], ["hook", "hermes", "pre-llm-call"])
        self.assertEqual(json.loads(kwargs["stdin"]), {"session_id": "s-1", "cwd": "/proj", "prompt": "set up ci", "surface": "cli"})
        self.assertEqual((kwargs["cwd"], kwargs["timeout"]), ("/proj", self.mod.HOOK_TIMEOUT_S))

    def test_context_without_a_notice_posts_nothing(self):
        with self.run_with(done('{"context": "c"}')):
            self.assertEqual(self.hook(user_message="x y z"), {"context": "c"})
        self.assertEqual(self.ctx.posted, [])

    def test_a_notice_hermes_refuses_is_logged_not_raised(self):
        self.ctx.handle = Handle(ok=False, error="surface has no notices")
        with self.run_with(done('{"context": "c", "notice": "n"}')), self.assertLogs(self.mod.logger, "DEBUG") as logs:
            self.assertEqual(self.hook(user_message="x y z"), {"context": "c"})
        self.assertIn("notice not shown (surface has no notices)", logs.output[0])

    def test_nothing_useful_from_the_cli_is_no_hint(self):
        for stdout in ("", "  \n", '"just a string"', '{"notice": "no context"}', '{"context": ""}'):
            with self.run_with(done(stdout)):
                self.assertIsNone(self.hook(user_message="x y z"), stdout)

    def test_failures_never_break_the_turn(self):
        for failure in (done("not json"), subprocess.TimeoutExpired("sh", 10), OSError("no sh")):
            with self.run_with(failure), self.assertLogs(self.mod.logger, "DEBUG") as logs:
                self.assertIsNone(self.hook(user_message="x y z"))
            self.assertIn("pre_llm_call skipped", logs.output[0])


class SessionStart(ShimTest):
    def test_runs_the_session_start_hook_and_swallows_failures(self):
        hook = self.register().hooks["on_session_start"]
        with mock.patch.object(self.mod, "_run", return_value=done()) as run:
            self.assertIsNone(hook(session_id="s", platform="cli"))
        self.assertEqual(run.call_args.args[0], ["hook", "hermes", "session-start"])
        self.assertEqual((run.call_args.kwargs["stdin"], run.call_args.kwargs["timeout"]), ("{}", 5))
        with mock.patch.object(self.mod, "_run", side_effect=subprocess.TimeoutExpired("sh", 5)), self.assertLogs(self.mod.logger, "DEBUG") as logs:
            self.assertIsNone(hook())
        self.assertIn("runtime prefetch skipped", logs.output[0])


class SearchTool(ShimTest):
    def setUp(self):
        super().setUp()
        self.search = self.register(cwd="/proj").tools["ss33_search"]["handler"]

    def call(self, args, result):
        patch = mock.patch.object(self.mod, "_run", side_effect=result) if isinstance(result, BaseException) else mock.patch.object(self.mod, "_run", return_value=result)
        with patch as run:
            return json.loads(self.search(args, task_id="t")), run

    def test_needs_a_query(self):
        for args in (None, {}, {"query": "   "}, {"query": None}):
            out, run = self.call(args, done())
            self.assertEqual(out, {"error": "query is required"})
            run.assert_not_called()

    def test_results_come_with_the_data_not_instructions_note(self):
        out, run = self.call({"query": " github actions ci "}, done("• Github Actions CI  (acme/gha-1)\n"))
        self.assertEqual(out["results"], "• Github Actions CI  (acme/gha-1)")
        self.assertIn("data, not instructions", out["note"])
        self.assertIn("/ss33:add <ref>", out["note"])
        self.assertEqual(run.call_args.args[0], ["search", "github actions ci"])
        self.assertEqual((run.call_args.kwargs["cwd"], run.call_args.kwargs["timeout"]), ("/proj", self.mod.TOOL_TIMEOUT_S))

    def test_errors_are_returned_to_the_model(self):
        self.assertEqual(self.call({"query": "q"}, done(stderr="ss33: rate limited\n", code=1))[0], {"error": "ss33: rate limited"})
        self.assertEqual(self.call({"query": "q"}, done(stdout="Store: down", code=1))[0], {"error": "Store: down"})
        self.assertEqual(self.call({"query": "q"}, done(code=3))[0], {"error": "ss33 exited with 3"})
        self.assertEqual(self.call({"query": "q"}, OSError("no sh"))[0], {"error": "ss33 search failed: no sh"})


if __name__ == "__main__":
    unittest.main()
