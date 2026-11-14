/* Web Worker: runs Python (Pyodide) and PythonFMU3 off the page's main thread. */
"use strict";

const WORKSPACE = "/home/pyodide/workspace";
const MUTATING = new Set(["write", "delete", "build", "use_template"]);
let py = null;
let bridge = null;

function progress(step) { self.postMessage({ type: "progress", step }); }

function syncfs(populate) {
  return new Promise((resolve, reject) => py.FS.syncfs(populate, (err) => (err ? reject(err) : resolve())));
}

async function init(config) {
  progress("Downloading Python (first visit only)…");
  importScripts(config.pyodideIndexURL + "pyodide.js");
  py = await loadPyodide({ indexURL: config.pyodideIndexURL });

  progress("Opening your saved files…");
  py.FS.mkdirTree(WORKSPACE);
  py.FS.mount(py.FS.filesystems.IDBFS, {}, WORKSPACE);
  await syncfs(true);

  progress("Installing PythonFMU3…");
  const manifest = await (await fetch(config.wheelManifest, { cache: "no-cache" })).json();
  const wheel = await (await fetch(new URL(manifest.wheel, new URL(config.wheelManifest, self.location.href)))).arrayBuffer();
  py.unpackArchive(wheel, "zip", { extractDir: "/lib/python3.13/site-packages" });
  try {
    await py.loadPackage("numpy");     // for array models and the surrogate template
  } catch (err) {
    console.warn("NumPy could not be loaded", err);
  }
  const source = await (await fetch(config.bridge, { cache: "no-cache" })).text();
  py.FS.writeFile("/home/pyodide/bridge.py", source);
  py.runPython("import sys; sys.path.insert(0, '/home/pyodide'); import bridge");
  bridge = py.pyimport("bridge");
  return { pyodide: py.version, pythonfmu3: manifest.version };
}

async function call(cmd, args) {
  const response = JSON.parse(bridge.call(cmd, JSON.stringify(args || {})));
  if (MUTATING.has(cmd) && response.ok) await syncfs(false);
  return response;
}

self.onmessage = async ({ data }) => {
  const { id, cmd, args } = data;
  try {
    let result;
    if (cmd === "init") {
      result = { ok: true, result: await init(args) };
    } else if (cmd === "readBytes") {
      const path = args.absolute ? args.path : `${WORKSPACE}/${args.path}`;
      const bytes = py.FS.readFile(path);
      self.postMessage({ id, response: { ok: true, result: bytes.buffer } }, [bytes.buffer]);
      return;
    } else if (cmd === "upload") {
      // args.target: "workspace" (a .py file) or "inspect" (an FMU to look at)
      const dir = args.target === "workspace" ? WORKSPACE : "/tmp/uploads";
      py.FS.mkdirTree(dir);
      py.FS.writeFile(`${dir}/${args.name}`, new Uint8Array(args.data));
      if (args.target === "workspace") await syncfs(false);
      result = { ok: true, result: { name: args.name } };
    } else {
      result = await call(cmd, args);
    }
    self.postMessage({ id, response: result });
  } catch (err) {
    self.postMessage({ id, response: { ok: false, error: String(err && err.message || err), traceback: String(err && err.stack || "") } });
  }
};
