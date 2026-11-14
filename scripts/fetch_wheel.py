"""Put the PythonFMU3 wheel the app runs into ``wheels/`` and write ``wheels/manifest.json``.

    python scripts/fetch_wheel.py                 # version from PYTHONFMU3_VERSION (default: latest on PyPI)
    python scripts/fetch_wheel.py --version 1.1.0
    python scripts/fetch_wheel.py --wheel ../PythonFMU3/dist/pythonfmu3-1.1.0-py3-none-any.whl

The wheel must be the one published on PyPI (or built by PythonFMU3's CI): it carries the
prebuilt native libraries that go into every FMU the app builds.
"""
import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WHEELS = ROOT / "wheels"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--version", help="PythonFMU3 version to download from PyPI")
    group.add_argument("--wheel", type=Path, help="use a local wheel file instead of PyPI")
    args = parser.parse_args()

    WHEELS.mkdir(exist_ok=True)
    for old in WHEELS.glob("*.whl"):
        old.unlink()

    if args.wheel:
        wheel = Path(shutil.copy2(args.wheel, WHEELS))
    else:
        spec = f"pythonfmu3=={args.version}" if args.version else "pythonfmu3"
        with tempfile.TemporaryDirectory() as tmp:
            subprocess.run([sys.executable, "-m", "pip", "download", spec, "--no-deps", "--only-binary", ":all:",
                            "--dest", tmp], check=True)
            found = list(Path(tmp).glob("pythonfmu3-*.whl"))
            if not found:
                raise SystemExit("No pythonfmu3 wheel was downloaded")
            wheel = Path(shutil.copy2(found[0], WHEELS))

    with zipfile.ZipFile(wheel) as z:
        names = z.namelist()
        if "pythonfmu3/studio/worker.py" not in names:
            raise SystemExit(f"{wheel.name} has no pythonfmu3.studio: the app needs PythonFMU3 1.1.0 or later")
        platforms = sorted({n.split("/")[3] for n in names if n.startswith("pythonfmu3/resources/binaries/") and n.count("/") >= 4})
    version = wheel.name.split("-")[1]
    manifest = {"wheel": wheel.name, "version": version, "platforms": platforms}
    (WHEELS / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"wheels/{wheel.name}: PythonFMU3 {version}, binaries for {', '.join(platforms) or 'no platforms'}")


if __name__ == "__main__":
    main()
