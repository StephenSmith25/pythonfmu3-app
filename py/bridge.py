"""Bridge between the web app and PythonFMU3, running inside Pyodide (Python in the browser).

The page's Web Worker calls ``call(command, args_json)``; every command returns a JSON
string ``{"ok": true, "result": ...}`` or ``{"ok": false, "error": ..., "traceback": ...}``.
Model files live in the workspace folder, which the worker keeps in the browser's
IndexedDB so they survive page reloads.
"""
import contextlib
import io
import json
import shutil
import sys
import traceback
import zipfile
from pathlib import Path

import pythonfmu3
from pythonfmu3.studio import worker
from pythonfmu3.studio.server import TEMPLATE_INFO, TEMPLATES

WORKSPACE = Path("/home/pyodide/workspace")
UPLOADS = Path("/tmp/uploads")


def _path(relative: str, must_exist: bool = True) -> Path:
    if not relative or "\x00" in relative:
        raise ValueError("empty path")
    path = (WORKSPACE / relative).resolve()
    if path != WORKSPACE and WORKSPACE not in path.parents:
        raise PermissionError(f"{relative} is outside the workspace")
    if must_exist and not path.exists():
        raise FileNotFoundError(relative)
    return path


def _rel(path: Path) -> str:
    return path.resolve().relative_to(WORKSPACE).as_posix()


def _forget_workspace_modules():
    """Drop modules imported from the workspace so edits to helper files take effect."""
    for name, module in list(sys.modules.items()):
        file = getattr(module, "__file__", None) or ""
        if file.startswith(str(WORKSPACE)):
            del sys.modules[name]


# --- commands --------------------------------------------------------------------------

def env(args):
    import importlib.util
    return {
        "version": pythonfmu3.__version__,
        "python": sys.version.split()[0],
        "numpy": importlib.util.find_spec("numpy") is not None,
        "workspace": "browser storage",
    }


def files(args):
    WORKSPACE.mkdir(parents=True, exist_ok=True)
    result = []
    for path in sorted(WORKSPACE.rglob("*")):
        if path.is_file() and path.suffix in (".py", ".fmu") and "__pycache__" not in path.parts:
            result.append({"path": _rel(path), "kind": path.suffix[1:], "size": path.stat().st_size})
    return result


def read(args):
    path = _path(args["path"])
    return {"path": _rel(path), "content": path.read_text(encoding="utf-8")}


def write(args):
    path = _path(args["path"], must_exist=False)
    if path.suffix != ".py":
        raise ValueError("Only .py files can be saved")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(args["content"], encoding="utf-8")
    return {"path": _rel(path)}


def delete(args):
    path = _path(args["path"])
    if path.is_dir():
        raise ValueError("Only files can be deleted")
    path.unlink()
    return {"path": args["path"]}


def analyze(args):
    _forget_workspace_modules()
    return worker.analyze({"path": str(_path(args["path"]))})


def simulate(args):
    _forget_workspace_modules()
    request = dict(args, path=str(_path(args["path"])))
    return worker.simulate_python(request)


def build(args):
    _forget_workspace_modules()
    path = _path(args["path"])
    result = worker.build({"path": str(path), "dest": str(path.parent / "build")})
    result["fmu"] = _rel(Path(result["fmu"]))
    return result


def _fmu_path(args) -> Path:
    if args.get("upload"):
        path = (UPLOADS / args["upload"]).resolve()
        if UPLOADS not in path.parents:
            raise PermissionError("invalid upload")
        return path
    return _path(args["path"])


def inspect(args):
    path = _fmu_path(args)
    return worker.inspect_fmu({"path": str(path), "name": args.get("name") or path.name})


def validate(args):
    result = worker.validate({"fmu": str(_fmu_path(args))})
    if result["tool"] == "built-in" and result["passed"]:
        result["output"] = ("Archive layout, binaries and model description read without problems. "
                            "For a full schema check, run `pythonfmu3 studio` locally with fmusim installed.")
    return result


def templates(args):
    items = []
    for key, (title, iface, cats, desc, tags) in TEMPLATE_INFO.items():
        if (TEMPLATES / f"{key}.py").exists():
            items.append({"id": key, "title": title, "interface": iface, "categories": cats.split(),
                          "description": desc, "tags": tags})
    return items


def use_template(args):
    key = args["id"]
    if key not in TEMPLATE_INFO:
        raise KeyError(key)
    target = _path(args.get("name") or f"{key}.py", must_exist=False)
    if target.exists():
        raise ValueError(f"{_rel(target)} already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(TEMPLATES / f"{key}.py", target)
    return {"path": _rel(target)}


def export_zip(args):
    out = Path("/tmp/pythonfmu3-workspace.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(WORKSPACE.rglob("*")):
            if path.is_file() and "__pycache__" not in path.parts:
                z.write(path, arcname=_rel(path))
    return {"file": str(out)}


COMMANDS = {f.__name__: f for f in (env, files, read, write, delete, analyze, simulate, build,
                                    inspect, validate, templates, use_template, export_zip)}


def call(command: str, args_json: str) -> str:
    captured = io.StringIO()
    try:
        with contextlib.redirect_stdout(captured):
            result = COMMANDS[command](json.loads(args_json or "{}"))
        response = {"ok": True, "result": result}
    except Exception as exc:
        response = {"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}
    response["stdout"] = captured.getvalue()[-8000:]
    return json.dumps(response, default=str)
