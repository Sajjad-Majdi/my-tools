"""Run mini-swe-agent on a task with a Gemini web model (your own Google login, no API key).

    python run.py "task text" [--model gemini-4-hydrogen] [--cwd DIR] [--steps 30] [--out traj.json]

Commands run in bash (Git Bash on Windows), hidden, one at a time. Exit code 0 when the agent finished.
"""
import argparse
import os
import pathlib
import subprocess
import sys

import yaml

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import minisweagent
import minisweagent.environments.local as local
from minisweagent.agents.default import DefaultAgent
from minisweagent.environments.local import LocalEnvironment
from gweb_model import GwebModel

BASH = os.environ.get("GWEB_AGENT_BASH", r"C:\Program Files\Git\bin\bash.exe" if os.name == "nt" else "/bin/bash")


def _run(command, cwd, env, timeout):
    """Same as mini-swe-agent's runner, but always bash and never a console window."""
    p = subprocess.Popen([BASH, "-lc", command], text=True, cwd=cwd, env=env, encoding="utf-8", errors="replace",
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         creationflags=0x08000000 if os.name == "nt" else 0)
    try:
        out, _ = p.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        p.kill()
        out, _ = p.communicate()
        raise subprocess.TimeoutExpired(command, timeout, output=out)
    return subprocess.CompletedProcess(command, p.returncode, stdout=out)


local._run = _run


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("task")
    ap.add_argument("--model", default=os.environ.get("GWEB_AGENT_MODEL", "gemini-4-hydrogen"))
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--steps", type=int, default=30)
    ap.add_argument("--timeout", type=int, default=120, help="seconds per shell command")
    ap.add_argument("--out", default="")
    a = ap.parse_args()

    cfg = yaml.safe_load((pathlib.Path(minisweagent.__file__).parent / "config" / "mini_textbased.yaml").read_text(encoding="utf-8"))
    agent_cfg = cfg.get("agent", {})
    agent_cfg["step_limit"] = a.steps
    agent_cfg["cost_limit"] = 0
    if a.out:
        agent_cfg["output_path"] = a.out
    model_cfg = {k: v for k, v in cfg.get("model", {}).items() if k not in ("model_name", "model_class", "model_kwargs")}
    model = GwebModel(model_name=a.model, **model_cfg)
    env = LocalEnvironment(cwd=a.cwd, timeout=a.timeout)
    result = DefaultAgent(model, env, **agent_cfg).run(task=a.task)
    print("EXIT", result.get("exit_status"), flush=True)
    print(str(result.get("submission", ""))[:4000])
    return 0 if str(result.get("exit_status", "")).lower() in ("submitted", "completed") else 1


if __name__ == "__main__":
    sys.exit(main())
