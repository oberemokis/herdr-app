"""Print subscription limits of Claude and Codex as one JSON object.

{"claude": {"windows": [{"label", "used", "resets"}]} | {"error"}, "codex": ...}
`used` is percent, `resets` is epoch ms or null. Never refreshes tokens: an
expired Claude token is reported, Claude Code renews it on its next start.
"""

import json
import shutil
import subprocess
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime

CODEX_TIMEOUT = 20


def window_label(minutes):
    if minutes == 10080:
        return "нед"
    if minutes % 1440 == 0:
        return f"{minutes // 1440}д"
    return f"{minutes // 60}ч"


def claude():
    try:
        raw = subprocess.run(
            ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
            capture_output=True, text=True, timeout=10,
        )
        if raw.returncode != 0:
            return {"error": "нет входа в Claude Code"}
        oauth = json.loads(raw.stdout)["claudeAiOauth"]
        if oauth.get("expiresAt", 0) < time.time() * 1000:
            return {"error": "токен истёк, запусти Claude Code"}
        request = urllib.request.Request(
            "https://api.anthropic.com/api/oauth/usage",
            headers={
                "Authorization": f"Bearer {oauth['accessToken']}",
                "anthropic-beta": "oauth-2025-04-20",
            },
        )
        with urllib.request.urlopen(request, timeout=10) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        return {"error": f"HTTP {error.code}"}
    except Exception as error:  # noqa: BLE001 - the footer shows any failure as text
        return {"error": type(error).__name__}

    windows = []
    for key, label in (("five_hour", "5ч"), ("seven_day", "нед")):
        window = data.get(key) or {}
        if window.get("utilization") is None:
            continue
        resets = window.get("resets_at")
        windows.append({
            "label": label,
            "used": window["utilization"],
            "resets": datetime.fromisoformat(resets).timestamp() * 1000 if resets else None,
        })
    return {"windows": windows}


def codex():
    exe = shutil.which("codex")
    if exe is None:
        return {"error": "codex не найден"}

    process = subprocess.Popen(
        [exe, "app-server"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
    )
    killer = threading.Timer(CODEX_TIMEOUT, process.kill)
    killer.start()
    try:
        for message in (
            {"jsonrpc": "2.0", "id": 1, "method": "initialize",
             "params": {"clientInfo": {"name": "herdr-provider-limits", "version": "1"}}},
            {"jsonrpc": "2.0", "method": "initialized"},
            {"jsonrpc": "2.0", "id": 2, "method": "account/rateLimits/read"},
        ):
            process.stdin.write(json.dumps(message) + "\n")
        process.stdin.flush()

        for line in process.stdout:
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get("id") != 2:
                continue
            if "error" in message:
                return {"error": message["error"].get("message", "ошибка app-server")}
            limits = message["result"]["rateLimits"]
            windows = []
            for slot in ("primary", "secondary"):
                window = limits.get(slot)
                if not window:
                    continue
                resets = window.get("resetsAt")
                windows.append({
                    "label": window_label(window.get("windowDurationMins") or 0),
                    "used": window["usedPercent"],
                    "resets": resets * 1000 if resets else None,
                })
            return {"windows": windows}
        return {"error": "нет ответа app-server"}
    except Exception as error:  # noqa: BLE001
        return {"error": type(error).__name__}
    finally:
        killer.cancel()
        process.kill()
        process.wait()


with ThreadPoolExecutor() as pool:
    jobs = {"claude": pool.submit(claude), "codex": pool.submit(codex)}
    print(json.dumps({name: job.result() for name, job in jobs.items()}, ensure_ascii=False))
