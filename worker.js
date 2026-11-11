const root = "https://cdn.jsdelivr.net/pyodide/v0.27.7/full/";
let runtime;
let ready;
let frozen = false;

async function initialize() {
  self.postMessage({progress: "Loading the Python runtime…"});
  importScripts(root + "pyodide.js");
  runtime = await loadPyodide({indexURL: root});
  self.postMessage({progress: "Loading pandas and statsmodels…"});
  await runtime.loadPackage(["pandas", "statsmodels", "tzdata"]);
  const response = await fetch("forecast_lab.py");
  if (!response.ok) throw Error("Could not load the Python pipeline.");
  runtime.FS.writeFile("forecast_lab.py", await response.text());
  runtime.setStdout({batched: message => self.postMessage({progress: message})});
  await runtime.runPythonAsync(`
import json, math
import forecast_lab as lab

sources, training, config, cv_winners = {}, {}, None, []
holdout_complete = False

def wire(value):
    if isinstance(value, dict):
        return {key: wire(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [wire(item) for item in value]
    if isinstance(value, float) and not math.isfinite(value):
        return None
    return value

def perform(action, p, content):
    global sources, training, config, cv_winners, holdout_complete
    if action == "import":
        raw, audit = lab.read_hourly(content.to_py().tobytes(), p["region"], p["workbook"], p["ending"])
        sources[p["region"]] = raw
        return {"loaded": True}
    if action == "demo":
        sources = lab.demo_hourly(lab.ZONES)
        return {"loaded": True}
    if action == "clean":
        config = lab.validate(p["settings"])
        missing = [region for region in config["REGIONS"] if region not in sources]
        if missing:
            raise ValueError("Add hourly data for " + ", ".join(missing) + ".")
        training, audit = lab.build_training(sources, config)
        return {region: {"daily": list(zip(y.index.strftime("%Y-%m-%d"), y.tolist())),
                         "audit": audit[region]} for region, y in training.items()}
    if action == "diagnose":
        return lab.diagnostics(training[p["region"]])
    if action == "cv":
        rows, cv_winners, info = lab.run_cv(training, config, print)
        return dict(rows=rows, winners=cv_winners, info=info)
    if action == "holdout":
        rows, info = lab.run_holdout(sources, training, config, print)
        holdout_complete = True
        return dict(rows=rows, info=info)
    if action == "forecast":
        if not holdout_complete:
            raise ValueError("Complete final holdout evaluation first.")
        return lab.future_forecast(sources, config, cv_winners, p["region"], p["horizon"])
    raise ValueError("Unknown pipeline action.")
`);
}

let cvReady = false;
self.onmessage = async ({data: {id, action, params, bytes}}) => {
  try {
    ready ??= initialize().catch(error => {ready = null; throw error;});
    await ready;
    if (["import", "demo", "clean", "cv", "diagnose"].includes(action) && frozen)
      throw Error("The run is frozen. Start a fresh session to change inputs.");
    if (action === "holdout") {
      if (!cvReady) throw Error("Run training cross-validation before opening holdout.");
      frozen = true;
    }
    if (["import", "demo", "clean", "cv"].includes(action)) cvReady = false;
    runtime.globals.set("request_action", action);
    runtime.globals.set("request_json", JSON.stringify(params || {}));
    runtime.globals.set("request_content", bytes ? new Uint8Array(bytes) : null);
    const result = await runtime.runPythonAsync(
      "json.dumps(wire(perform(request_action, json.loads(request_json), request_content)), allow_nan=False)"
    );
    if (action === "cv") cvReady = true;
    self.postMessage({id, result: JSON.parse(result)});
  } catch (error) {
    self.postMessage({id, error: String(error.message || error).trim().split("\n").filter(Boolean).at(-1)});
  }
};
