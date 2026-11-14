# PythonFMU3 Studio (web)

Write, check, simulate and build [FMI 3.0](https://fmi-standard.org) FMUs from Python,
entirely in your browser: no install, and your models never leave your computer.

**Open it:** https://stephensmith25.github.io/pythonfmu3-app/

It's the web version of `pythonfmu3 studio` from
[PythonFMU3](https://github.com/StephenSmith25/PythonFMU3). Python runs in the browser tab
with [Pyodide](https://pyodide.org), so it's a static site with no server.

| | Web app | `pythonfmu3 studio` (local) |
| --- | --- | --- |
| Editor with live checks, FMU block, modelDescription.xml | Yes | Yes |
| Python-preview simulation with sliders and plots | Yes | Yes |
| Build and download FMUs | Yes (Windows and Linux binaries from the PyPI package) | Yes (your local build) |
| Inspector for any FMU | Yes | Yes |
| Templates | Yes | Yes |
| AI Assistant that writes, checks, simulates and fixes models | Yes (your Anthropic API key) | No |
| Simulate the FMU in fmusim or FMPy | No | Yes |
| Models importing packages Pyodide doesn't have (e.g. PyTorch) | No | Yes |
| Where files live | This browser (download them, or export a .zip) | A folder on your computer |

## The Assistant

The **Assistant** tab is a Claude agent that designs models for you. Describe what you
want ("a water tank with an inflow input and the level as output") and it writes the
model, runs the Studio's checks, simulates it, fixes whatever fails and builds the FMU.
The file opens in the editor, so you can keep working on it yourself.

It uses your own [Anthropic API key](https://console.anthropic.com/settings/keys): the
key is kept in this browser (if you tick *Remember*) and sent only to Anthropic's API,
and usage is billed to your account. Your model code is sent to Anthropic while you use
the Assistant; nothing else in the app leaves your browser.

## How it works

- `index.html`, `app.js`, `app.css`: the Studio interface (plain JavaScript).
- `worker.js`: a Web Worker that loads Pyodide, keeps your files in the browser's
  IndexedDB, installs the PythonFMU3 wheel, and runs Python off the main thread.
- `agent.js`: the Assistant. It calls the Anthropic Messages API from the browser, with
  tools that map onto the same bridge commands the Studio's buttons use.
- `py/bridge.py`: the Python side. It calls PythonFMU3's own Studio code
  (`pythonfmu3.studio.worker`), so both versions behave the same.
- `wheels/`: the PythonFMU3 wheel the app runs. Not committed: the deploy workflow
  downloads it from PyPI, because the PyPI wheel carries the prebuilt native libraries
  that go into every FMU. Needs PythonFMU3 1.1.0 or later.

## Deploying

The workflow in `.github/workflows/deploy.yml` publishes the site to GitHub Pages:

1. In the repository's **Settings → Pages**, set **Source** to **GitHub Actions** (once).
2. Push to `main`. The workflow downloads the latest PythonFMU3 wheel from PyPI,
   assembles the site and deploys it.

It also runs weekly to pick up new PythonFMU3 releases. To bundle a specific version, run
the workflow by hand (**Actions → Deploy to GitHub Pages → Run workflow**) and enter it,
or set a repository variable `PYTHONFMU3_VERSION`.

## Running it locally

```bash
python scripts/fetch_wheel.py            # latest PythonFMU3 from PyPI into wheels/
python -m http.server 8000
```

Then open http://localhost:8000. To try an unreleased PythonFMU3, pass a wheel built with
binaries: `python scripts/fetch_wheel.py --wheel path/to/pythonfmu3-X-py3-none-any.whl`.

To work offline, download a Pyodide release (`pyodide-core-<version>.tar.bz2` plus the
NumPy package, or the full release) into `pyodide/` and open
http://localhost:8000/?pyodide=./pyodide/.

## Privacy

Everything runs in your browser. Your models are stored in this browser's IndexedDB and
are never uploaded, except to Anthropic's API while you use the Assistant. The page loads Pyodide from the jsDelivr CDN.
