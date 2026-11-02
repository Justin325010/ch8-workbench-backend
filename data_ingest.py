"""Lightweight data ingestion with CSV/Excel support."""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path


EXPECTED_COLUMNS = {
    "phi": ["phi", "equivalence_ratio", "当量比"],
    "z_mm": ["z_mm", "z", "axial_mm", "轴向位置"],
    "r_mm": ["r_mm", "r", "radial_mm", "径向位置"],
    "T_K": ["T_K", "T_sim_K", "temperature_K", "温度_K"],
    "T_C": ["Tg_mean_C", "T_C", "temperature_C"],
    "CO2": ["CO2", "co2"],
    "H2O": ["H2O", "h2o"],
    "CO": ["CO", "co"],
    "CH3OH": ["CH3OH", "methanol"],
    "CH4": ["CH4", "ch4"],
    "O2": ["O2", "o2"],
    "H2": ["H2", "h2"],
    "CH2O": ["CH2O", "ch2o"],
    "q_W_m2": ["heat_flux_mean_W_m2", "q_W_m2", "热流"],
    "timestamp": ["timestamp", "time", "时间"],
}


def _read_csv(content: bytes):
    text = None
    for enc in ("utf-8-sig", "utf-8", "gbk"):
        try:
            text = content.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    if text is None:
        raise ValueError("无法识别 CSV 编码")
    reader = csv.reader(io.StringIO(text))
    rows = [row for row in reader if row]
    if not rows:
        raise ValueError("CSV 为空")
    headers = [str(c).strip() for c in rows[0]]
    data = rows[1:]
    return headers, data


def _read_xlsx(content: bytes):
    try:
        from openpyxl import load_workbook
    except Exception as exc:  # pragma: no cover
        raise ValueError("服务器未安装 openpyxl，无法解析 Excel") from exc
    wb = load_workbook(io.BytesIO(content), read_only=True, data_only=True)
    ws = wb.active
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        raise ValueError("Excel 为空")
    headers = ["" if c is None else str(c).strip() for c in rows[0]]
    data = [[("" if c is None else c) for c in r] for r in rows[1:]]
    return headers, data


def _normalize(headers, rows):
    rename = {}
    for canonical, aliases in EXPECTED_COLUMNS.items():
        for alias in aliases:
            for h in headers:
                if h.lower() == alias.lower():
                    rename[h] = canonical
                    break
            if canonical in rename.values() and any(k in rename for k in [alias]):
                break
    norm_headers = [rename.get(h, h) for h in headers]
    seen = set()
    columns = []
    for h in norm_headers:
        if h in seen:
            continue
        seen.add(h)
        columns.append(h)
    return columns, rows


def _numeric_values(values):
    out = []
    for v in values:
        if v is None or v == "":
            continue
        try:
            out.append(float(v))
        except (TypeError, ValueError):
            continue
    return out


def _quantile(xs, q):
    xs = sorted(xs)
    if not xs:
        return 0.0
    pos = q * (len(xs) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(xs) - 1)
    frac = pos - lo
    return xs[lo] * (1 - frac) + xs[hi] * frac


def ingest(filename: str, content: bytes) -> dict:
    suffix = Path(filename).suffix.lower()
    if suffix == ".csv":
        headers, rows = _read_csv(content)
    elif suffix in {".xlsx", ".xls"}:
        headers, rows = _read_xlsx(content)
    else:
        raise ValueError("仅支持 CSV / Excel 文件")

    columns, rows = _normalize(headers, rows)
    row_count = len(rows)
    col_values = {c: [row[i] if i < len(row) else "" for row in rows] for i, c in enumerate(columns)}

    numeric_columns = []
    for c in columns:
        nums = _numeric_values(col_values[c])
        if nums and len(nums) >= max(1, int(row_count * 0.5)):
            numeric_columns.append(c)

    coverage = {}
    outliers = {}
    for c in numeric_columns:
        nums = _numeric_values(col_values[c])
        coverage[c] = 100.0 * len(nums) / row_count if row_count else 0.0
        outliers[c] = _outlier_rate(nums)

    z_col = "z_mm" if "z_mm" in columns else "z"
    r_col = "r_mm" if "r_mm" in columns else "r"
    spatial_coverage = None
    if z_col in columns and r_col in columns:
        zs = _numeric_values(col_values[z_col])
        rs = _numeric_values(col_values[r_col])
        if zs and rs:
            spatial_coverage = {
                "z_min": min(zs), "z_max": max(zs),
                "r_min": min(rs), "r_max": max(rs),
                "z_span": max(zs) - min(zs),
                "r_span": max(rs) - min(rs),
            }

    time_continuity = None
    if "timestamp" in columns:
        vals = [str(v) for v in col_values["timestamp"] if v not in (None, "")]
        if vals:
            time_continuity = {"start": vals[0], "end": vals[-1], "monotonic": vals == sorted(vals)}

    overall_coverage = sum(coverage.values()) / len(coverage) if coverage else 0.0
    overall_outlier = sum(outliers.values()) / len(outliers) if outliers else 0.0
    passed = overall_coverage >= 90.0 and overall_outlier <= 10.0
    return {
        "row_count": row_count,
        "columns": columns,
        "numeric_columns": numeric_columns,
        "overall_coverage_pct": overall_coverage,
        "overall_outlier_pct": overall_outlier,
        "coverage_by_column": coverage,
        "outlier_by_column": outliers,
        "spatial_coverage": spatial_coverage,
        "time_continuity": time_continuity,
        "passed": passed,
        "message": "数据质量合格" if passed else "覆盖率或异常率未达到进入训练的最低要求",
    }


def _outlier_rate(nums):
    if len(nums) < 8:
        return 0.0
    q1 = _quantile(nums, 0.25)
    q3 = _quantile(nums, 0.75)
    iqr = q3 - q1
    if iqr <= 1e-12:
        return 0.0
    lower, upper = q1 - 3.0 * iqr, q3 + 3.0 * iqr
    return 100.0 * sum(1 for x in nums if x < lower or x > upper) / len(nums)
