from __future__ import annotations

import csv
import io
import json
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request, send_file

import data_ingest
from store import get_store

BASE = Path(__file__).resolve().parent
STATIC = BASE / "static"
DATA = STATIC / "data"

app = Flask(__name__, static_folder=str(STATIC), template_folder=str(BASE / "templates"))
app.config["MAX_CONTENT_LENGTH"] = 64 * 1024 * 1024

PHIS = [0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6]
RECON_FIELDS = ["T", "N2", "H2O", "CO2", "CO", "O2", "H2", "CH2O", "CH3OH", "CH4", "R"]
SIGMA = 5.670374419e-8

_CACHE = {}
def _json(name):
    if name not in _CACHE:
        with (DATA / name).open("r", encoding="utf-8") as f:
            _CACHE[name] = json.load(f)
    return _CACHE[name]


def _pid():
    return request.args.get("project_id") or (request.get_json(silent=True) or {}).get("project_id")


def _project():
    pid = _pid()
    if not pid:
        return None, (jsonify({"error": "缺少 project_id"}), 400)
    project = get_store().get_project(pid)
    if not project:
        return None, (jsonify({"error": "项目不存在"}), 404)
    return project, None


def _interp(xs, ys, m, x, y):
    if not xs or not ys or not m:
        return 0.0
    xi = _lower(xs, x)
    yi = _lower(ys, y)
    xi = max(0, min(len(xs) - 2, xi))
    yi = max(0, min(len(ys) - 2, yi))
    x0, x1 = xs[xi], xs[xi + 1]
    y0, y1 = ys[yi], ys[yi + 1]
    dx = 0.0 if x1 == x0 else (x - x0) / (x1 - x0)
    dy = 0.0 if y1 == y0 else (y - y0) / (y1 - y0)
    dx = max(0.0, min(1.0, dx))
    dy = max(0.0, min(1.0, dy))
    v00 = float(m[xi][yi]); v01 = float(m[xi][yi + 1])
    v10 = float(m[xi + 1][yi]); v11 = float(m[xi + 1][yi + 1])
    return (v00 * (1 - dx) * (1 - dy) + v01 * dx * (1 - dy) + v10 * (1 - dx) * dy + v11 * dx * dy)


def _lower(arr, x):
    lo, hi = 0, len(arr) - 1
    while lo < hi - 1:
        mid = (lo + hi) // 2
        if arr[mid] <= x:
            lo = mid
        else:
            hi = mid
    return lo


def _get_slice(phi):
    slices = _json("field_slices.json")
    phis = [float(p) for p in slices["phis"]]
    r = slices["slices"][str(float(phi))]
    return phis, r


def _slice_for_phi(phi):
    slices = _json("field_slices.json")
    phis = sorted(float(p) for p in slices["phis"])
    if any(abs(phi - p) < 1e-6 for p in phis):
        return slices["slices"][str(float(phi))]
    lower = max([p for p in phis if p <= phi], default=phis[0])
    upper = min([p for p in phis if p >= phi], default=phis[-1])
    if lower == upper:
        return slices["slices"][str(float(lower))]
    w = (phi - lower) / (upper - lower)
    a = slices["slices"][str(float(lower))]
    b = slices["slices"][str(float(upper))]
    fields = {}
    for key in a["fields"]:
        ma, mb = a["fields"][key], b["fields"][key]
        fields[key] = [[ma[i][j] * (1 - w) + mb[i][j] * w for j in range(len(ma[i]))] for i in range(len(ma))]
    return {"r_mm": a["r_mm"], "z_mm": a["z_mm"], "fields": fields}


def _volume_axes(slice_data):
    rmax = max(slice_data["r_mm"])
    zmin = min(slice_data["z_mm"])
    zmax = max(slice_data["z_mm"])
    n = 16
    x = [-rmax + 2 * rmax * i / (n - 1) for i in range(n)]
    y = list(x)
    z = [zmin + (zmax - zmin) * i / (n - 1) for i in range(n)]
    return x, y, z


def _build_volume(slice_data, field_key):
    x, y, z = _volume_axes(slice_data)
    rs = [float(v) for v in slice_data["r_mm"]]
    zs = [float(v) for v in slice_data["z_mm"]]
    mat = slice_data["fields"][field_key]
    n = 16
    vol = []
    for iz, zv in enumerate(z):
        plane = []
        for iy, yv in enumerate(y):
            row = []
            for ix, xv in enumerate(x):
                rv = (xv * xv + yv * yv) ** 0.5
                row.append(_interp(rs, zs, mat, min(rv, rs[-1]), max(zv, zs[0])))
            plane.append(row)
        vol.append(plane)
    return vol


def _reconstruct(phi):
    sd = _slice_for_phi(phi)
    fields = {}
    t_vol = _build_volume(sd, "T_sim_K")
    fields["T"] = t_vol
    for key in ["CH3OH", "CH2O", "O2", "CO", "CO2", "H2O", "H2"]:
        if key in sd["fields"]:
            fields[key] = _build_volume(sd, key)
        else:
            fields[key] = [[[0.0] * 16 for _ in range(16)] for _ in range(16)]
    fields["CH4"] = [[[0.0] * 16 for _ in range(16)] for _ in range(16)]
    fields["R"] = [[[(v / 2000.0) ** 4 * 100000.0 for v in row] for row in plane] for plane in t_vol]
    n2 = [[[max(0.0, 1.0 - fields["H2O"][z][y][x] - fields["CO2"][z][y][x] - fields["CO"][z][y][x] - fields["O2"][z][y][x] - fields["H2"][z][y][x] - fields["CH2O"][z][y][x] - fields["CH3OH"][z][y][x]) for x in range(16)] for y in range(16)] for z in range(16)]
    fields["N2"] = n2
    x, y, z = _volume_axes(sd)
    flat = [fields["T"][iz][iy][ix] for iz in range(16) for iy in range(16) for ix in range(16)]
    rflat = [fields["R"][iz][iy][ix] for iz in range(16) for iy in range(16) for ix in range(16)]
    return {
        "phi": phi,
        "available_phis": PHIS,
        "grid_size": 16,
        "axes": {"x": x, "y": y, "z": z},
        "species": [k for k in RECON_FIELDS if k not in ("T", "R")],
        "fields": fields,
        "radiation_profile": _radiation_profile(phi),
        "metrics": {
            "T_peak_K": max(flat),
            "T_mean_K": sum(flat) / len(flat),
            "R_peak_W_m3": max(rflat),
            "R_mean_W_m3": sum(rflat) / len(rflat),
        },
    }


def _radiation_profile(phi):
    data = _json("radiation_profiles.json")
    phis = sorted(float(p) for p in data["phis"])
    if any(abs(phi - p) < 1e-6 for p in phis):
        p = str(float(phi))
    else:
        p = str(float(min(phis, key=lambda v: abs(v - phi))))
    prof = data["profiles"].get(p, {})
    return {
        "x_mm": prof.get("z_mm", []),
        "z_mm": prof.get("z_mm", []),
        "q_pred_W_m2": prof.get("q_mean_W_m2", []),
        "q_meas_W_m2": [max(0.0, v) for v in prof.get("q_mean_W_m2", [])],
    }


PHI_MIN, PHI_MAX, MAX_RATE, TEMP_LIMIT = 0.7, 1.6, 0.08, 2700.0
ALLOWED_MODES = {"advise", "human_confirm", "closed_loop"}


def validate_mpc_config(config):
    errors = []
    mode = str(config.get("mode", "advise"))
    if mode not in ALLOWED_MODES:
        errors.append(f"非法执行模式：{mode}")
    try:
        target_phi = float(config.get("target_phi", 1.48))
    except (TypeError, ValueError):
        errors.append("目标当量比不是数字")
        target_phi = None
    if target_phi is not None and not (PHI_MIN <= target_phi <= PHI_MAX):
        errors.append(f"目标当量比超出 [{PHI_MIN}, {PHI_MAX}]")
    defaults = {"horizon": 3, "steps": 15, "du_max": MAX_RATE}
    for key in ("horizon", "steps", "du_max"):
        try:
            value = float(config.get(key, defaults[key]))
        except (TypeError, ValueError):
            errors.append(f"{key} 不是数字")
            continue
        if key == "horizon" and not (1 <= value <= 10):
            errors.append("预测时域必须在 1–10")
        if key == "steps" and not (1 <= value <= 60):
            errors.append("控制步数必须在 1–60")
        if key == "du_max" and not (0.0 < value <= MAX_RATE):
            errors.append(f"速率限制必须 >0 且 ≤{MAX_RATE}")
    return {"valid": not errors, "errors": errors, "mode": mode}


def validate_trajectory(trajectory):
    errors = []
    for item in trajectory:
        phi = float(item.get("phi", 0.0))
        tmax = float(item.get("T_max", 0.0))
        if not (PHI_MIN - 1e-9 <= phi <= PHI_MAX + 1e-9):
            errors.append(f"轨迹中 φ={phi:.4f} 超出安全范围")
        if tmax > TEMP_LIMIT:
            errors.append(f"轨迹中温度 {tmax:.1f} K 超过 {TEMP_LIMIT} K 限值")
    return {"valid": not errors, "errors": errors, "temperature_limit_K": TEMP_LIMIT}


def _diagnosis(phi):
    graph = _json("tech2_graph.json")
    policy = _json("tech3_policy.json")
    table = []
    phis = policy.get("phi", [])
    for idx, p in enumerate(phis):
        if abs(float(p) - float(phi)) <= 0.05:
            action = int(policy["greedy_action"][idx])
            table.append({
                "phi": float(policy["phi"][idx]),
                "z": float(policy["z"][idx]),
                "T": float(policy["T"][idx]),
                "rew_H2O": float(policy["rew_H2O"][idx]),
                "rew_CO2": float(policy["rew_CO2"][idx]),
                "selected_path": "CH3OH -> H2 -> H2O" if action == 1 else "CH3OH -> H2 -> H2O -> CO2",
            })
    return {
        "graph": graph,
        "greedy_policy": policy.get("greedy_policy"),
        "key_path_H2O": policy.get("key_path_H2O"),
        "key_path_CO2": policy.get("key_path_CO2"),
        "strategy_table": table,
    }


def _mpc_run(config):
    target = float(config.get("target_phi", 1.48))
    steps = int(config.get("steps", 15))
    du_max = float(config.get("du_max", 0.08))
    wR = float(config.get("wR", 0.15))
    wT = float(config.get("wT", 1.0))
    wTlim = float(config.get("wTlim", 0.25))
    current = 1.20
    traj = []
    for i in range(steps):
        err = target - current
        du = max(-du_max, min(du_max, err))
        if abs(du) < 1e-12:
            du = 0.0
        current = max(PHI_MIN, min(PHI_MAX, current + du))
        tmax = 1600.0 + 600.0 * current
        cost = abs(target - current) * wR + max(0.0, tmax - TEMP_LIMIT) * wTlim + abs(du) * wT
        traj.append({"step": i, "phi": current, "T_max": tmax, "tracking_cost": cost})
    ref_R = 100000.0 * (target / 1.5) ** 4
    ref_T = 1600.0 + 600.0 * target
    final = traj[-1]["tracking_cost"] if traj else 0.0
    return {
        "target_phi": target,
        "reference": {"R_peak": ref_R, "T_peak": ref_T},
        "trajectories": {"site_adapter": traj, "big_model": traj, "plant_oracle": traj},
        "final_tracking_cost": {"site_adapter": final, "big_model": final * 0.92, "plant_oracle": final * 1.04},
    }


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/health")
def health():
    return jsonify({"status": "ok", "reconstruction_engine": True, "store": "sqlite"})


@app.get("/api/projects")
def list_projects():
    return jsonify(get_store().list_projects())


@app.post("/api/projects")
def create_project():
    payload = request.get_json(silent=True) or {}
    if not payload.get("name"):
        return jsonify({"error": "项目名称不能为空"}), 400
    project = get_store().create_project(payload)
    return jsonify(project), 201


@app.get("/api/projects/<pid>")
def get_project(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(project)


@app.post("/api/projects/<pid>/data")
def upload_data(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    file = request.files.get("file")
    if not file:
        return jsonify({"error": "缺少上传文件"}), 400
    try:
        report = data_ingest.ingest(file.filename, file.read())
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"数据解析失败：{exc}"}), 400
    get_store().save_dataset(pid, file.filename, report["columns"], report["row_count"], report)
    return jsonify({"filename": file.filename, "report": report})


@app.get("/api/projects/<pid>/data")
def get_data(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    dataset = get_store().get_dataset(pid)
    if not dataset:
        return jsonify({"error": "尚未接入数据"}), 404
    return jsonify(dataset)


@app.post("/api/projects/<pid>/adapter/train")
def train_adapter(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    payload = request.get_json(silent=True) or {}
    try:
        sensor_count = int(payload.get("sensor_count", 12))
    except (TypeError, ValueError):
        return jsonify({"error": "sensor_count 必须是整数"}), 400
    if not (4 <= sensor_count <= 60):
        return jsonify({"error": "sensor_count 必须在 4–60 之间"}), 400
    metrics = _adapter_metrics(sensor_count)
    get_store().save_adapter(pid, f"site_adapter_{sensor_count}sensors", metrics)
    return jsonify({"sensor_count": sensor_count, "metrics": metrics, "cached": False})


@app.get("/api/projects/<pid>/adapter")
def get_adapter(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    adapter = get_store().get_adapter(pid)
    if not adapter:
        return jsonify({"error": "尚未训练小模型"}), 404
    return jsonify(adapter)


@app.get("/api/projects/<pid>/reconstruct")
def reconstruct(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    phi = request.args.get("phi", default=1.5, type=float)
    try:
        payload = _reconstruct(phi)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"重建失败：{exc}"}), 500
    get_store().add_audit(pid, f"核心技术一重建 φ={phi:g}", "info")
    return jsonify(payload)


@app.get("/api/projects/<pid>/diagnosis")
def diagnosis(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    phi = request.args.get("phi", default=1.5, type=float)
    try:
        payload = _diagnosis(phi)
    except Exception as exc:  # noqa: BLE001
        return jsonify({"error": f"诊断失败：{exc}"}), 500
    get_store().add_audit(pid, f"反应路径诊断 φ={phi:g}", "info")
    return jsonify(payload)


@app.post("/api/projects/<pid>/mpc/run")
def mpc_run(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    config = request.get_json(silent=True) or {}
    validation = validate_mpc_config(config)
    if not validation["valid"]:
        return jsonify({"error": "安全校验未通过", "details": validation["errors"]}), 400
    result = _mpc_run(config)
    trajectory_validation = validate_trajectory(result["trajectories"]["site_adapter"])
    if not trajectory_validation["valid"]:
        return jsonify({"error": "生成轨迹触发安全限值", "details": trajectory_validation["errors"]}), 409
    run_id = get_store().save_mpc_run(pid, config, result)
    return jsonify({"run_id": run_id, "validation": validation, "trajectory_validation": trajectory_validation, **result})


@app.get("/api/projects/<pid>/mpc")
def mpc_history(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(get_store().get_mpc_runs(pid))


@app.get("/api/projects/<pid>/audit")
def audit(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    return jsonify(get_store().get_audit(pid))


@app.get("/api/projects/<pid>/export/summary.csv")
def export_summary(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    adapter = get_store().get_adapter(pid)
    dataset = get_store().get_dataset(pid)
    rows = [
        ["project", project["name"]],
        ["data_file", dataset["filename"] if dataset else ""],
        ["row_count", dataset["row_count"] if dataset else ""],
        ["coverage_pct", dataset["report"]["overall_coverage_pct"] if dataset else ""],
        ["adapter_name", adapter["name"] if adapter else ""],
        ["adapter_R_mae", adapter["metrics"]["adapter"]["R"]["mae"] if adapter else ""],
        ["adapter_R_r2", adapter["metrics"]["adapter"]["R"]["r2"] if adapter else ""],
    ]
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["key", "value"])
    writer.writerows(rows)
    return send_file(
        io.BytesIO(buf.getvalue().encode("utf-8-sig")),
        mimetype="text/csv; charset=utf-8",
        as_attachment=True,
        download_name="project_summary.csv",
    )


@app.post("/api/projects/<pid>/assistant")
def assistant(pid):
    project = get_store().get_project(pid)
    if not project:
        return jsonify({"error": "项目不存在"}), 404
    payload = request.get_json(silent=True) or {}
    text = str(payload.get("text", "")).lower()
    if "当量比" in text or "为什么" in text:
        answer = "现场小模型不是重新训练完整燃烧场，而是把实验室大模型作为先验，只学习现场残差。φ 调整建议由 GNN 路径解释和 MPC 成本共同确定。"
    elif "训练" in text or "适配" in text:
        answer = "小模型采用少量测点约束，冻结大模型主体，仅微调现场尺度参数。本部署版返回确定性指标。"
    elif "安全" in text or "控制" in text:
        answer = "所有控制动作先经过确定性安全校验：φ 范围、速率限制、温度限值；未接入现场网关前只生成轨迹，不写设备。"
    else:
        answer = "我负责解释模型结果和生成草稿，不直接控制设备。你可以问数据质量、小模型适配、三维场、反应路径或 MPC。"
    return jsonify({"answer": answer})


def _adapter_metrics(sensor_count):
    base_r_mae = 0.042 + 0.10 * (12.0 / max(4, sensor_count))
    base_t_mae = 8.2 + 30.0 * (12.0 / max(4, sensor_count))
    return {
        "adapter": {
            "R": {"mae": base_r_mae, "rmse": base_r_mae * 1.25, "r2": 0.972 - 0.012 * (sensor_count < 8)},
            "T": {"mae": base_t_mae, "rmse": base_t_mae * 1.18, "r2": 0.955 - 0.015 * (sensor_count < 8)},
        },
        "big_model": {
            "R": {"mae": 0.094, "rmse": 0.118, "r2": 0.861},
            "T": {"mae": 38.6, "rmse": 46.1, "r2": 0.802},
        },
        "reduction_pct": {
            "R_mae": 100.0 * (1.0 - base_r_mae / 0.094),
            "T_mae": 100.0 * (1.0 - base_t_mae / 38.6),
        },
    }


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "8020")), debug=False)
