/* Industrial thermal-chemical multi-field intelligence workbench */
const state = {
  projects: [],
  project: null,
  stage: 0,
  gates: [false, false, false, false],
  stageVisited: [true, false, false, false, false, false, false],
  dataset: null,
  adapter: null,
  adapterResult: null,
  recon: null,
  reconPromise: null,
  diagnosis: null,
  mpc: null,
  audit: [],
  fieldPhi: "1.5",
  fieldVar: "T",
  viewMode: "2d",
  colorscale: "Inferno",
  sensorCount: 12,
};

const STEP_LABELS = [
  ["0", "创建现场项目"],
  ["1", "数据接入与预处理"],
  ["2", "小模型适配训练"],
  ["3", "三维场推理与监控"],
  ["4", "反应路径诊断"],
  ["5", "MPC 控制配置与执行"],
  ["6", "审计、导出与持续优化"],
];

const RECON_FIELDS = [
  ["T", "温度 T / K"],
  ["N2", "N₂ 摩尔分数"],
  ["H2O", "H₂O 摩尔分数"],
  ["CO2", "CO₂ 摩尔分数"],
  ["CO", "CO 摩尔分数"],
  ["O2", "O₂ 摩尔分数"],
  ["H2", "H₂ 摩尔分数"],
  ["CH2O", "CH₂O 摩尔分数"],
  ["CH3OH", "CH₃OH 摩尔分数"],
  ["CH4", "CH₄ 摩尔分数"],
  ["R", "辐射源项 R / W·m⁻³"],
];
const RECON_FIELD_LABEL = Object.fromEntries(RECON_FIELDS);

const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $("toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove("show"), 2600);
}

async function api(path, options = {}) {
  const headers = options.headers || {};
  if (options.body && !(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const res = await fetch(path, { ...options, headers });
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) throw new Error((data && data.error) || `HTTP ${res.status}`);
  return data;
}

function fieldLabel(field) { return RECON_FIELD_LABEL[field] || field; }

function isUnlocked(i) {
  if (i === 0 || i === 6) return true;
  if (i === 1) return state.gates[0];
  if (i === 2) return state.gates[1];
  if (i === 3 || i === 4) return state.gates[2];
  if (i === 5) return state.gates[3];
  return false;
}

function isDone(i) {
  if (i === 0) return state.gates[0];
  if (i === 1) return state.gates[1];
  if (i === 2) return state.gates[2];
  if (i === 3) return state.stageVisited[3];
  if (i === 4) return state.gates[3];
  if (i === 5) return !!state.mpc;
  if (i === 6) return state.audit.length > 2;
  return false;
}

function renderStepper() {
  const nav = $("stepper");
  nav.innerHTML = STEP_LABELS.map(([num, label], i) => {
    const unlocked = isUnlocked(i);
    const done = isDone(i);
    const active = state.stage === i;
    const cls = ["step", unlocked ? "unlocked" : "", active ? "active" : "", done ? "done" : ""].filter(Boolean).join(" ");
    return `<button class="${cls}" data-stage="${i}"><span class="num">${num}</span><span>${label}</span></button>`;
  }).join("");
  nav.querySelectorAll(".step").forEach(btn => btn.addEventListener("click", () => goStage(+btn.dataset.stage)));
}

function goStage(i) {
  if (!isUnlocked(i)) { toast("请先完成上一个确认门"); return; }
  state.stage = i;
  state.stageVisited[i] = true;
  renderStepper();
  renderStage(i);
}

function updateGateBadge() {
  const passed = state.gates.filter(Boolean).length;
  const badge = $("gateBadge");
  badge.textContent = passed >= 4 ? "确认门已通过" : `确认门 ${passed}/4`;
  badge.className = `badge ${passed >= 4 ? "ok" : passed > 0 ? "warn" : "muted"}`;
}

function setStageGates(gates) {
  state.gates = gates;
  if (state.project) localStorage.setItem(`gates_${state.project.id}`, JSON.stringify(gates));
  updateGateBadge();
  renderStepper();
}

async function bootstrap() {
  try {
    const health = await api("/api/health");
    if (health.status === "ok") {
      $("engineStatus").textContent = "模型服务在线 · SQLite 项目库";
      $("engineStatus").parentElement.classList.add("online");
    }
  } catch (e) { $("engineStatus").textContent = "模型服务不可用"; }
  const projects = await api("/api/projects");
  state.projects = projects;
  const saved = localStorage.getItem("projectId");
  const pid = saved || (projects[0] && projects[0].id) || null;
  await selectProject(pid);
  $("projectSelect").addEventListener("change", e => selectProject(e.target.value));
  $("newProjectBtn").addEventListener("click", () => {
    localStorage.removeItem("projectId");
    state.project = null;
    state.gates = [false, false, false, false];
    state.stage = 0;
    $("projectTitle").textContent = "尚未创建项目";
    updateGateBadge();
    renderStepper();
    renderStage(0);
  });
  initAssistant();
}

async function selectProject(pid) {
  if (!pid) {
    state.project = null; state.dataset = null; state.adapter = null; state.audit = [];
    state.gates = [false, false, false, false];
    $("projectTitle").textContent = "尚未创建项目";
    $("projectSelect").innerHTML = `<option value="">未选择项目</option>`;
    updateGateBadge(); renderStepper(); renderStage(0); return;
  }
  localStorage.setItem("projectId", pid);
  state.project = await api(`/api/projects/${pid}`);
  $("projectTitle").textContent = state.project.name;
  $("projectSelect").innerHTML = state.projects.map(p => `<option value="${p.id}" ${p.id === pid ? "selected" : ""}>${p.name}</option>`).join("");
  const savedGates = localStorage.getItem(`gates_${pid}`);
  state.gates = savedGates ? JSON.parse(savedGates) : [true, false, false, false];
  try { state.dataset = await api(`/api/projects/${pid}/data`); state.gates[1] = !!state.dataset.report.passed; } catch (e) { state.dataset = null; }
  try { state.adapter = await api(`/api/projects/${pid}/adapter`); } catch (e) { state.adapter = null; }
  try { state.audit = await api(`/api/projects/${pid}/audit`); } catch (e) { state.audit = []; }
  setStageGates(state.gates);
  renderStage(state.stage || 0);
}

function renderStage(i) {
  const panel = $("stagePanel");
  const renderers = [renderStage0, renderStage1, renderStage2, renderStage3, renderStage4, renderStage5, renderStage6];
  panel.innerHTML = renderers[i]();
  if (i === 0) bindStage0();
  if (i === 1) bindStage1();
  if (i === 2) bindStage2();
  if (i === 3) bindStage3();
  if (i === 4) bindStage4();
  if (i === 5) bindStage5();
  if (i === 6) bindStage6();
}

function renderStage0() {
  return `
  <div class="section-head"><div class="sub">STAGE 0</div><h2>创建现场项目</h2><p>项目是数据、模型和控制策略的隔离边界。</p></div>
  <div class="card-grid two">
    <div class="card"><div class="card-title"><span class="title-dot"></span>项目基础信息</div>
      <div class="form-grid">
        <label class="field">项目名称<input id="projectName" value="特富中试炉·工业现场" /></label>
        <label class="field">炉型 / 燃烧器<input id="furnaceType" value="轴对称工业圆管炉" /></label>
        <label class="field">燃料类型<input id="fuelType" value="CH₃OH（默认）" /></label>
        <label class="field">炉膛长度 L<input id="length" value="1.2 m" /></label>
        <label class="field">炉膛半径 Rc<input id="radius" value="0.25 m" /></label>
        <label class="field">压力<input id="pressure" value="1 atm" /></label>
      </div>
    </div>
    <div class="card"><div class="card-title"><span class="title-dot"></span>可用设备清单</div>
      <div class="device-list"><span class="chip">K 型热电偶 × 4</span><span class="chip">水冷式热流辐射仪</span><span class="chip">烟气分析仪</span><span class="chip">工业相机</span><span class="chip">OPC UA / Modbus / MQTT 网关</span></div>
      <div class="metric-line"><span>确认门 0</span><strong>场景资料完整后进入数据接入</strong></div>
    </div>
  </div>
  <div class="action-row"><button class="btn primary" id="saveProjectBtn">保存项目并进入阶段 1</button></div>`;
}

function bindStage0() {
  $("saveProjectBtn").addEventListener("click", async () => {
    const payload = {
      name: $("projectName").value.trim(),
      furnace: $("furnaceType").value.trim(),
      fuel: $("fuelType").value.trim(),
      geometry: { length: $("length").value.trim(), radius: $("radius").value.trim(), pressure: $("pressure").value.trim() },
      devices: ["K型热电偶", "热流辐射仪", "烟气分析仪", "工业相机", "OPC UA/Modbus/MQTT网关"],
    };
    if (!payload.name) { toast("请填写项目名称"); return; }
    try {
      const project = await api("/api/projects", { method: "POST", body: JSON.stringify(payload) });
      state.project = project;
      state.projects.unshift({ id: project.id, name: project.name, created_at: project.created_at });
      localStorage.setItem("projectId", project.id);
      $("projectTitle").textContent = project.name;
      setStageGates([true, false, false, false]);
      state.stage = 1; renderStepper(); renderStage(1); toast("项目已创建");
    } catch (e) { toast(e.message); }
  });
}

function renderStage1() {
  const report = state.dataset ? state.dataset.report : null;
  return `
  <div class="section-head"><div class="sub">STAGE 1</div><h2>数据接入与预处理</h2><p>上传 CSV/Excel，后端执行单位换算、异常值剔除、缺失值标记与质量报告。</p></div>
  <div class="card-grid two">
    <div class="card"><div class="card-title"><span class="title-dot"></span>数据上传</div>
      <input type="file" id="fileInput" accept=".csv,.xlsx,.xls" />
      <div class="action-row"><button class="btn primary" id="uploadBtn">解析并生成质量报告</button><button class="btn ghost" id="loadSampleBtn">加载实验室样例</button><button class="btn ghost" id="loadCfdBtn">加载1D仿真数据</button></div>
    </div>
    <div class="card"><div class="card-title"><span class="title-dot"></span>数据质量报告</div><div id="qualityReport" class="info-stack">${report ? qualityReportHtml(report) : "尚未接入数据"}</div></div>
  </div>
  <div class="action-row"><button class="btn primary" id="gate1Btn" ${!state.gates[1] ? "disabled" : ""}>确认门 1 通过，进入小模型训练</button></div>`;
}

function qualityReportHtml(report) {
  return `<div class="metric-line"><span>文件</span><strong>${state.dataset.filename}</strong></div>
    <div class="metric-line"><span>行数</span><strong>${report.row_count}</strong></div>
    <div class="metric-line"><span>总体覆盖率</span><strong>${report.overall_coverage_pct.toFixed(1)}%</strong></div>
    <div class="metric-line"><span>异常率</span><strong>${report.overall_outlier_pct.toFixed(1)}%</strong></div>
    <div class="metric-line"><span>质量结论</span><strong>${report.passed ? "合格" : "不合格"}</strong></div>
    <div class="metric-line"><span>字段</span><strong>${report.numeric_columns.join(", ")}</strong></div>`;
}

function bindStage1() {
  $("uploadBtn").addEventListener("click", () => { const file = $("fileInput").files[0]; if (!file) { toast("请选择文件"); return; } uploadDataset(file); });
  $("loadSampleBtn").addEventListener("click", loadSampleDataset);
  $("loadCfdBtn").addEventListener("click", loadCfdDataset);
  $("gate1Btn").addEventListener("click", () => { state.gates[1] = true; setStageGates(state.gates); goStage(2); });
}

async function uploadDataset(file) {
  const form = new FormData(); form.append("file", file);
  try {
    const result = await api(`/api/projects/${state.project.id}/data`, { method: "POST", body: form });
    state.dataset = result; state.gates[1] = !!result.report.passed; setStageGates(state.gates); renderStage(1); toast(result.report.message);
  } catch (e) { toast(e.message); }
}

async function loadSampleDataset() {
  try {
    const res = await fetch("/static/data/sample_site_data.csv");
    const blob = await res.blob();
    const file = new File([blob], "sample_site_data.csv", { type: "text/csv" });
    await uploadDataset(file);
  } catch (e) { toast(e.message); }
}

async function loadCfdDataset() {
  try {
    const res = await fetch("/static/data/site_cfd_training_full.csv");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const file = new File([blob], "site_cfd_training_full.csv", { type: "text/csv" });
    await uploadDataset(file);
  } catch (e) { toast(e.message); }
}

function renderStage2() {
  const adapter = state.adapter;
  return `
  <div class="section-head"><div class="sub">STAGE 2</div><h2>小模型适配训练</h2><p>实验室大模型提供物理先验，现场小模型只学习残差；训练完成需工程师验收。</p></div>
  <div class="card-grid two">
    <div class="card"><div class="card-title"><span class="title-dot"></span>训练配置</div>
      <label class="field">现场测点数量<select id="sensorCount">${[4,6,8,12,16,24].map(n => `<option value="${n}" ${n === state.sensorCount ? "selected" : ""}>${n} 个测点</option>`).join("")}</select></label>
      <div class="action-row"><button class="btn primary" id="trainBtn">训练现场适配器</button></div>
    </div>
    <div class="card"><div class="card-title"><span class="title-dot"></span>训练评估</div><div id="trainMetrics" class="info-stack">${adapter ? adapterMetricsHtml(adapter.metrics) : "等待训练…"}</div></div>
  </div>
  <div class="action-row"><button class="btn primary" id="acceptModelBtn" ${!state.adapter ? "disabled" : ""}>验收模型并写入注册表</button></div>`;
}

function adapterMetricsHtml(metrics) {
  const r = metrics.adapter.R; const t = metrics.adapter.T;
  const big = metrics.big_model || { R: {}, T: {} };
  return `<div class="metric-line"><span>现场小模型 · 辐射 MAE</span><strong>${r.mae.toFixed(3)}</strong></div>
    <div class="metric-line"><span>现场小模型 · 辐射 R²</span><strong>${r.r2.toFixed(3)}</strong></div>
    <div class="metric-line"><span>现场小模型 · 温度 MAE</span><strong>${t.mae.toFixed(2)}</strong></div>
    <div class="metric-line"><span>现场小模型 · 温度 R²</span><strong>${t.r2.toFixed(3)}</strong></div>
    <div class="metric-line"><span>实验室大模型 · 辐射 MAE</span><strong>${big.R.mae ? big.R.mae.toFixed(3) : "—"}</strong></div>
    <div class="metric-line"><span>实验室大模型 · 温度 MAE</span><strong>${big.T.mae ? big.T.mae.toFixed(2) : "—"}</strong></div>
    <div class="metric-line"><span>相对大模型误差下降</span><strong>${metrics.reduction_pct.R_mae.toFixed(1)}%</strong></div>`;
}

function bindStage2() {
  $("sensorCount").addEventListener("change", e => { state.sensorCount = +e.target.value; });
  $("trainBtn").addEventListener("click", trainAdapter);
  $("acceptModelBtn").addEventListener("click", acceptModel);
}

async function trainAdapter() {
  const btn = $("trainBtn"); btn.disabled = true; btn.textContent = "训练中…";
  $("trainMetrics").innerHTML = `<div class="metric-line"><span>状态</span><strong>正在训练 Ridge 残差适配器…</strong></div>`;
  try {
    const result = await api(`/api/projects/${state.project.id}/adapter/train`, { method: "POST", body: JSON.stringify({ sensor_count: state.sensorCount }) });
    state.adapterResult = result;
    state.adapter = await api(`/api/projects/${state.project.id}/adapter`);
    state.gates[2] = false; setStageGates(state.gates); renderStage(2); toast("小模型训练完成，等待验收");
  } catch (e) { toast(e.message); } finally { btn.disabled = false; btn.textContent = "训练现场适配器"; }
}

function acceptModel() { state.gates[2] = true; setStageGates(state.gates); toast("模型已验收并写入注册表"); goStage(3); }

function renderStage3() {
  return `
  <div class="section-head"><div class="sub">STAGE 3</div><h2>三维场推理与监控</h2><p>调用核心技术一，把稀疏观测重建为 16×16×16 的 T/Y/R 状态场。选择任意物理场，中心轴向切片与三维体渲染都会跟随切换。</p></div>
  <div class="card control-card">
    <div class="control-grid">
      <div class="control-group">
        <span class="control-label">当量比 φ</span>
        <select id="fieldPhi" class="control-select">${reconPhiOptions()}</select>
      </div>
      <div class="control-group field-select-group">
        <span class="control-label">显示物理场</span>
        <div class="field-picker" id="fieldPicker">
          ${RECON_FIELDS.map(([key,label]) => `<button type="button" class="field-chip ${key === state.fieldVar ? "active" : ""}" data-field="${key}" title="${label}">${key}</button>`).join("")}
        </div>
      </div>
      <div class="control-group">
        <span class="control-label">视图模式</span>
        <div class="segmented" id="viewModePicker">
          <button type="button" class="seg ${state.viewMode === "2d" ? "active" : ""}" data-view="2d">中心轴向切片</button>
          <button type="button" class="seg ${state.viewMode === "3d" ? "active" : ""}" data-view="3d">三维体渲染</button>
        </div>
      </div>
      <div class="control-group">
        <span class="control-label">配色方案</span>
        <select id="fieldColorscale" class="control-select">${["Inferno","Viridis","Plasma","Jet"].map(c => `<option ${c === state.colorscale ? "selected" : ""}>${c}</option>`).join("")}</select>
      </div>
    </div>
  </div>
  <div class="card-grid two">
    <div class="card field-card">
      <div class="card-title"><span class="title-dot"></span><span id="fieldPlotTitle">正在加载重建场…</span></div>
      <div id="fieldPlot" class="plot large"></div>
    </div>
    <div class="card side-card">
      <div class="card-title"><span class="title-dot"></span>重建状态</div>
      <div id="fieldInfo" class="info-stack"></div>
      <div class="card-title" style="margin-top:18px"><span class="title-dot"></span>当前场统计</div>
      <div id="fieldStats" class="info-stack"></div>
    </div>
  </div>
  <div class="card"><div class="card-title"><span class="title-dot"></span>轴向辐射热流剖面</div><div id="radPlot" class="plot medium"></div></div>`;
}

function reconPhiOptions() {
  return [0.7,0.8,0.9,1.0,1.1,1.2,1.3,1.4,1.5,1.6].map(p => `<option value="${p}" ${+state.fieldPhi === p ? "selected" : ""}>${p.toFixed(2)}</option>`).join("");
}

function bindStage3() {
  $("fieldPhi").addEventListener("change", e => { state.fieldPhi = e.target.value; refreshStage3(); });
  $("fieldPicker").addEventListener("click", e => {
    const btn = e.target.closest(".field-chip");
    if (!btn) return;
    state.fieldVar = btn.dataset.field;
    $("fieldPicker").querySelectorAll(".field-chip").forEach(b => b.classList.toggle("active", b === btn));
    renderField();
  });
  $("viewModePicker").addEventListener("click", e => {
    const btn = e.target.closest(".seg");
    if (!btn) return;
    state.viewMode = btn.dataset.view;
    $("viewModePicker").querySelectorAll(".seg").forEach(b => b.classList.toggle("active", b === btn));
    renderField();
  });
  $("fieldColorscale").addEventListener("change", e => { state.colorscale = e.target.value; renderField(); });
  refreshStage3();
}

function ensureReconstruction(phi) {
  if (state.recon && state.recon.phi === phi) return Promise.resolve(state.recon.data);
  if (state.reconPromise && state.reconPromise.phi === phi) return state.reconPromise.promise;
  const promise = api(`/api/projects/${state.project.id}/reconstruct?phi=${encodeURIComponent(phi)}`)
    .then(data => {
      if (state.fieldPhi === phi) state.recon = { phi, data };
      if (state.reconPromise && state.reconPromise.phi === phi) state.reconPromise = null;
      return data;
    })
    .catch(err => {
      if (state.reconPromise && state.reconPromise.phi === phi) state.reconPromise = null;
      throw err;
    });
  state.reconPromise = { phi, promise };
  return promise;
}

function refreshStage3() { renderField(); renderRadiation(); }

function makeRZSlice(data, field) {
  const volume = data.fields[field];
  const nz = volume.length, ny = volume[0].length, nx = volume[0][0].length;
  const midY = Math.floor(ny / 2), startX = Math.floor(nx / 2);
  const values = [];
  for (let iz = 0; iz < nz; iz++) {
    const row = [];
    for (let ix = startX; ix < nx; ix++) row.push(volume[iz][midY][ix]);
    values.push(row);
  }
  return { x: data.axes.x.slice(startX), y: data.axes.z, z: values };
}

function originAxes() {
  return {
    showgrid: true, gridcolor: "rgba(255,255,255,.08)", zeroline: false,
    showline: true, linecolor: "#e9edf3", linewidth: 1.2,
    ticks: "outside", ticklen: 5, tickwidth: 1, tickcolor: "#e9edf3",
  };
}

async function renderField() {
  const plot = $("fieldPlot"); if (!plot) return;
  if ($("fieldInfo")) $("fieldInfo").innerHTML = `<div class="metric-line"><span>重建状态</span><strong>正在调用核心技术一…</strong></div>`;
  let data;
  try { data = await ensureReconstruction(state.fieldPhi); } catch (err) {
    if ($("fieldInfo")) $("fieldInfo").innerHTML = `<div class="metric-line"><span>重建失败</span><strong>${err.message}</strong></div>`;
    if ($("fieldStats")) $("fieldStats").innerHTML = "";
    if ($("fieldPlotTitle")) $("fieldPlotTitle").textContent = "重建失败";
    return;
  }
  const field = Object.prototype.hasOwnProperty.call(data.fields, state.fieldVar) ? state.fieldVar : "T";
  const label = fieldLabel(field);
  const config = { responsive: true, displayModeBar: true };
  const volume = data.fields[field];
  const ax = data.axes.x, ay = data.axes.y, az = data.axes.z;
  const nx = ax.length, ny = ay.length, nz = az.length;
  const X = [], Y = [], Z = [], V = [];
  for (let iz = 0; iz < nz; iz++) for (let iy = 0; iy < ny; iy++) for (let ix = 0; ix < nx; ix++) {
    const v = volume[iz][iy][ix];
    X.push(ax[ix]); Y.push(ay[iy]); Z.push(az[iz]); V.push(v);
  }
  const vmin = Math.min(...V), vmax = Math.max(...V), span = vmax - vmin || 1;

  if (state.viewMode === "3d") {
    const trace = {
      type: "volume", x: X, y: Y, z: Z, value: V,
      isomin: vmin + 0.03 * span, isomax: vmax, opacity: 0.20,
      surface: { show: true, count: 10, fill: 0.85, pattern: "odd" },
      colorscale: state.colorscale, showscale: true,
      lighting: { ambient: 0.55, diffuse: 0.85, specular: 0.40, roughness: 0.55, fresnel: 0.12 },
      colorbar: { title: { text: label, font: { color: "#e9edf3", size: 11 } }, tickfont: { color: "#e9edf3", size: 10 }, thickness: 16 },
      caps: { x: { show: true }, y: { show: true }, z: { show: true } },
      slices: { x: { show: false }, y: { show: false }, z: { show: false } },
    };
    const sceneAxis = title => ({
      backgroundcolor: "#000000", gridcolor: "rgba(255,255,255,.08)", zerolinecolor: "rgba(255,255,255,.18)", showbackground: true,
      title: { text: title, font: { size: 11, color: "#e9edf3" } }, tickfont: { color: "#e9edf3", size: 10 },
    });
    const layout = {
      paper_bgcolor: "#000000", plot_bgcolor: "#000000", height: 800, margin: { l: 10, r: 10, t: 72, b: 10 },
      font: { family: "Microsoft YaHei, Segoe UI, Arial", color: "#e9edf3", size: 12 },
      title: { text: `核心技术一三维重建 · ${label} · φ=${state.fieldPhi}`, font: { size: 16, color: "#ffffff" } },
      scene: { bgcolor: "#000000", xaxis: sceneAxis("x / mm"), yaxis: sceneAxis("y / mm"), zaxis: sceneAxis("z / mm"), aspectmode: "data", camera: { eye: { x: 1.4, y: 1.4, z: 1.1 } } },
    };
    Plotly.react("fieldPlot", [trace], layout, config);
  } else {
    const slice = makeRZSlice(data, field);
    const trace = {
      type: "heatmap", x: slice.x, y: slice.y, z: slice.z,
      colorscale: state.colorscale, zmin: vmin, zmax: vmax, showscale: true,
      colorbar: { title: { text: label, font: { color: "#e9edf3", size: 11 } }, tickfont: { color: "#e9edf3", size: 10 }, thickness: 14 },
      hovertemplate: `${label}=%{z:.6g}<extra></extra>`,
    };
    const layout = {
      paper_bgcolor: "#000000", plot_bgcolor: "#000000", height: 800, margin: { l: 62, r: 90, t: 66, b: 58 },
      font: { family: "Microsoft YaHei, Segoe UI, Arial", color: "#e9edf3", size: 12 },
      title: { text: `核心技术一 · ${label} · 中心轴向切片（φ=${state.fieldPhi}）`, font: { size: 16, color: "#ffffff" } },
      xaxis: { ...originAxes(), title: { text: "r / mm", font: { size: 12, color: "#e9edf3" } } },
      yaxis: { ...originAxes(), title: { text: "z / mm", font: { size: 12, color: "#e9edf3" } } },
    };
    Plotly.react("fieldPlot", [trace], layout, config);
  }

  const m = data.metrics;
  if ($("fieldPlotTitle")) $("fieldPlotTitle").textContent = `${label} · φ=${state.fieldPhi} · ${state.viewMode === "3d" ? "三维体渲染" : "中心轴向切片"}`;
  if ($("fieldInfo")) $("fieldInfo").innerHTML = `
    <div class="metric-line"><span>当前工况</span><strong>φ=${state.fieldPhi}</strong></div>
    <div class="metric-line"><span>重建引擎</span><strong>核心技术一</strong></div>
    <div class="metric-line"><span>重建网格</span><strong>${data.grid_size} × ${data.grid_size} × ${data.grid_size}</strong></div>
    <div class="metric-line"><span>显示变量</span><strong>${label}</strong></div>
    <div class="metric-line"><span>温度峰值 / 均值</span><strong>${m.T_peak_K.toFixed(1)} / ${m.T_mean_K.toFixed(1)} K</strong></div>
    <div class="metric-line"><span>辐射峰值 / 均值</span><strong>${m.R_peak_W_m3.toExponential(2)} / ${m.R_mean_W_m3.toExponential(2)} W/m³</strong></div>`;
  if ($("fieldStats")) $("fieldStats").innerHTML = fieldStatsHtml(field, label, V);
}

function formatFieldValue(value, field) {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (field === "T" || field === "R") return abs >= 1000 ? value.toExponential(3) : value.toFixed(3);
  return abs >= 1000 || abs < 0.001 ? value.toExponential(3) : value.toFixed(5);
}

function fieldStatsHtml(field, label, values) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const std = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return `<div class="metric-line"><span>当前场</span><strong>${label}</strong></div>
    <div class="metric-line"><span>最小值</span><strong>${formatFieldValue(min, field)}</strong></div>
    <div class="metric-line"><span>最大值</span><strong>${formatFieldValue(max, field)}</strong></div>
    <div class="metric-line"><span>平均值</span><strong>${formatFieldValue(mean, field)}</strong></div>
    <div class="metric-line"><span>标准差</span><strong>${formatFieldValue(std, field)}</strong></div>
    <div class="metric-line"><span>网格单元</span><strong>${values.length}</strong></div>`;
}

async function renderRadiation() {
  const plot = $("radPlot"); if (!plot) return;
  let data;
  try { data = await ensureReconstruction(state.fieldPhi); } catch (err) { return; }
  const p = data.radiation_profile;
  const traces = [
    { type: "scatter", mode: "lines", x: p.z_mm, y: p.q_pred_W_m2, name: "核心技术一预测", line: { color: "#e60008", width: 2.2 } },
    { type: "scatter", mode: "markers", x: p.z_mm, y: p.q_meas_W_m2, name: "实测热流", marker: { size: 6, color: "#4f8bff" } },
  ];
  const layout = {
    paper_bgcolor: "#000000", plot_bgcolor: "#000000", height: 420,
    font: { family: "Microsoft YaHei, Segoe UI, Arial", color: "#e9edf3", size: 12 },
    title: { text: `轴向辐射热流剖面 φ=${state.fieldPhi}`, font: { size: 15, color: "#fff" } },
    xaxis: { ...originAxes(), title: { text: "z / mm", font: { size: 12, color: "#e9edf3" } } },
    yaxis: { ...originAxes(), title: { text: "q / W·m⁻²", font: { size: 12, color: "#e9edf3" } } },
    margin: { l: 66, r: 26, t: 60, b: 54 },
  };
  Plotly.react("radPlot", traces, layout, { responsive: true, displayModeBar: false });
}

function renderStage4() {
  return `
  <div class="section-head"><div class="sub">STAGE 4</div><h2>反应路径诊断与调控建议</h2><p>将重建场输入 GNN，计算节点/边贡献并识别关键反应路径。</p></div>
  <div class="toolbar"><label>当量比 φ<select id="diagPhi">${reconPhiOptions()}</select></label></div>
  <div class="card-grid two">
    <div class="card"><div class="card-title"><span class="title-dot"></span>反应网络节点—边贡献</div><div id="graphPlot" class="plot medium"></div></div>
    <div class="card"><div class="card-title"><span class="title-dot"></span>当前策略</div><div id="strategyTable" class="table-wrap"></div></div>
  </div>
  <div class="action-row"><button class="btn primary" id="gate3Btn">确认调控目标与约束，进入 MPC</button></div>`;
}

function bindStage4() {
  $("diagPhi").addEventListener("change", e => { state.fieldPhi = e.target.value; loadDiagnosis(); });
  $("gate3Btn").addEventListener("click", () => { state.gates[3] = true; setStageGates(state.gates); goStage(5); });
  loadDiagnosis();
}

async function loadDiagnosis() {
  try { state.diagnosis = await api(`/api/projects/${state.project.id}/diagnosis?phi=${encodeURIComponent(state.fieldPhi)}`); } catch (e) { toast(e.message); return; }
  const d = state.diagnosis;
  renderGraphPlot(d.graph);
  $("strategyTable").innerHTML = strategyTableHtml(d);
}

function renderGraphPlot(graph) {
  const nodes = graph.nodes;
  const edges = graph.edges || [];
  const pos = nodes.map((n, i) => {
    const ang = (2 * Math.PI * i) / nodes.length - Math.PI / 2;
    return { x: Math.cos(ang), y: Math.sin(ang) };
  });
  const edgeTraces = edges.map(e => {
    const a = pos[e.source_idx], b = pos[e.target_idx];
    return { type: "scatter", mode: "lines", x: [a.x, b.x], y: [a.y, b.y], line: { width: 1.5 + Math.min(Math.abs(e.value) * 14, 7), color: e.value >= 0 ? "rgba(230,0,8,.72)" : "rgba(79,139,255,.72)" }, hovertext: `${e.rxn_label}<br>贡献 ${e.value.toFixed(3)}`, hoverinfo: "text", showlegend: false };
  });
  const nodeTrace = {
    type: "scatter", mode: "markers+text", x: pos.map(p => p.x), y: pos.map(p => p.y), text: nodes.map(n => n.species), textposition: "top center",
    marker: { size: 16, color: nodes.map(n => n.value >= 0 ? "#e60008" : "#4f8bff"), line: { color: "#fff", width: 1 } },
    hovertext: nodes.map(n => `${n.species}<br>贡献 ${n.value.toFixed(3)}`), hoverinfo: "text",
  };
  const layout = { paper_bgcolor: "#000000", plot_bgcolor: "#000000", height: 420, margin: { l: 20, r: 20, t: 40, b: 20 }, font: { family: "Microsoft YaHei, Segoe UI, Arial", color: "#e9edf3", size: 12 }, title: { text: `反应因果图 φ=${state.fieldPhi}`, font: { size: 15, color: "#fff" } }, xaxis: { visible: false, range: [-1.25, 1.25] }, yaxis: { visible: false, range: [-1.35, 1.35] } };
  Plotly.react("graphPlot", [...edgeTraces, nodeTrace], layout, { responsive: true, displayModeBar: false });
}

function strategyTableHtml(d) {
  const rows = (d.strategy_table || []).slice(0, 12).map(row => `<tr><td>${row.phi.toFixed(2)}</td><td>${row.z.toFixed(1)}</td><td>${row.T.toFixed(1)}</td><td>${row.selected_path}</td></tr>`).join("");
  return `<table><thead><tr><th>φ</th><th>z/mm</th><th>T/K</th><th>推荐路径</th></tr></thead><tbody>${rows || '<tr><td colspan="4">暂无策略样本</td></tr>'}</tbody></table>`;
}

function renderStage5() {
  const result = state.mpc;
  return `
  <div class="section-head"><div class="sub">STAGE 5</div><h2>MPC 控制配置与执行</h2><p>控制动作先经过确定性安全校验，再生成设定值轨迹；当前未连接现场网关，不会写入设备。</p></div>
  <div class="card-grid two">
    <div class="card">
      <div class="card-title"><span class="title-dot"></span>控制配置</div>
      <div class="form-grid">
        <label class="field">执行模式
          <select id="mpcMode">
            <option value="advise">只建议，不写现场</option>
            <option value="human_confirm">人工确认后逐步下发</option>
            <option value="closed_loop">安全限位内闭环执行</option>
          </select>
        </label>
        <label class="field">目标当量比 φ<input id="mpcTargetPhi" type="number" step="0.01" min="0.7" max="1.6" value="1.48" /></label>
        <label class="field">预测时域 H<input id="mpcHorizon" type="number" min="1" max="10" value="3" /></label>
        <label class="field">控制步数 N<input id="mpcSteps" type="number" min="1" max="60" value="15" /></label>
        <label class="field">单步速率上限 Δφ<input id="mpcDuMax" type="number" step="0.01" min="0.01" max="0.08" value="0.08" /></label>
        <label class="field">辐射权重 wR<input id="mpcWR" type="number" step="0.01" min="0" value="0.15" /></label>
        <label class="field">温度权重 wT<input id="mpcWT" type="number" step="0.01" min="0" value="1.0" /></label>
        <label class="field">温度软限权重 wTlim<input id="mpcWTlim" type="number" step="0.01" min="0" value="0.25" /></label>
      </div>
      <div class="device-list"><span class="chip">OPC UA / Modbus / MQTT</span><span class="chip">φ 执行器</span><span class="chip">速率限位 0.08</span><span class="chip">温度联锁 2700 K</span></div>
      <div class="action-row"><button class="btn primary" id="mpcRunBtn">生成设定值轨迹并做安全校验</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="title-dot"></span>控制目标与约束</div>
      <div class="info-stack">
        <div class="metric-line"><span>目标场</span><strong>峰值温度 / 辐射剖面</strong></div>
        <div class="metric-line"><span>组分约束</span><strong>O₂ 下限、CO 上限</strong></div>
        <div class="metric-line"><span>目标范围</span><strong>φ ∈ [0.7, 1.6]</strong></div>
        <div class="metric-line"><span>安全温度限</span><strong>2700 K</strong></div>
        <div class="metric-line"><span>执行策略</span><strong>先建议 → 人工确认 → 闭环</strong></div>
      </div>
    </div>
  </div>
  <div class="card" id="mpcResultCard">${result ? mpcResultHtml(result) : `<div class="info-stack"><div class="metric-line"><span>状态</span><strong>尚未生成 MPC 轨迹</strong></div></div>`}</div>`;
}

function mpcResultHtml(result) {
  const traj = result.trajectories && result.trajectories.site_adapter ? result.trajectories.site_adapter : [];
  const rows = traj.slice(0, 20).map(item => `<tr><td>${item.step}</td><td>${item.phi.toFixed(4)}</td><td>${item.T_max.toFixed(1)}</td><td>${item.tracking_cost.toExponential(3)}</td></tr>`).join("");
  const validation = result.validation || { valid: true, errors: [] };
  const trajectoryValidation = result.trajectory_validation || { valid: true, errors: [] };
  const cost = result.final_tracking_cost || {};
  return `
    <div class="card-title"><span class="title-dot"></span>MPC 执行结果</div>
    <div class="card-grid three">
      <div class="info-stack">
        <div class="metric-line"><span>现场小模型末步代价</span><strong>${cost.site_adapter ? cost.site_adapter.toExponential(3) : "—"}</strong></div>
        <div class="metric-line"><span>实验室大模型末步代价</span><strong>${cost.big_model ? cost.big_model.toExponential(3) : "—"}</strong></div>
        <div class="metric-line"><span>真实对象末步代价</span><strong>${cost.plant_oracle ? cost.plant_oracle.toExponential(3) : "—"}</strong></div>
        <div class="metric-line"><span>目标辐射峰值</span><strong>${result.reference ? result.reference.R_peak.toFixed(1) : "—"} W/m²</strong></div>
        <div class="metric-line"><span>目标峰值温度</span><strong>${result.reference ? result.reference.T_peak.toFixed(1) : "—"} K</strong></div>
      </div>
      <div class="info-stack">
        <div class="metric-line"><span>配置安全校验</span><strong style="color:${validation.valid ? "#2ec27e" : "#ff2b31"}">${validation.valid ? "通过" : "未通过"}</strong></div>
        <div class="metric-line"><span>轨迹安全校验</span><strong style="color:${trajectoryValidation.valid ? "#2ec27e" : "#ff2b31"}">${trajectoryValidation.valid ? "通过" : "未通过"}</strong></div>
        <div class="metric-line"><span>执行模式</span><strong>${validation.mode || "advise"}</strong></div>
        <div class="metric-line"><span>轨迹步数</span><strong>${traj.length}</strong></div>
        <div class="metric-line"><span>安全温度限</span><strong>${trajectoryValidation.temperature_limit_K || 2700} K</strong></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>步</th><th>φ</th><th>T_max/K</th><th>跟踪代价</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="4">无轨迹</td></tr>'}</tbody>
        </table>
      </div>
    </div>`;
}

function bindStage5() {
  $("mpcRunBtn").addEventListener("click", runMpc);
}

async function runMpc() {
  if (!state.project) { toast("请先创建现场项目"); return; }
  const btn = $("mpcRunBtn");
  btn.disabled = true;
  btn.textContent = "MPC 求解中…";
  const config = {
    mode: $("mpcMode").value,
    target_phi: +$("mpcTargetPhi").value,
    horizon: +$("mpcHorizon").value,
    steps: +$("mpcSteps").value,
    du_max: +$("mpcDuMax").value,
    wR: +$("mpcWR").value,
    wT: +$("mpcWT").value,
    wTlim: +$("mpcWTlim").value,
    sensor_count: state.sensorCount,
  };
  try {
    const result = await api(`/api/projects/${state.project.id}/mpc/run`, { method: "POST", body: JSON.stringify(config) });
    state.mpc = result;
    try { state.audit = await api(`/api/projects/${state.project.id}/audit`); } catch (e) { state.audit = []; }
    renderStage(5);
    toast("MPC 轨迹已生成并通过确定性安全校验");
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "生成设定值轨迹并做安全校验";
  }
}

function renderStage6() {
  const audit = state.audit || [];
  return `
  <div class="section-head"><div class="sub">STAGE 6</div><h2>审计、导出与持续优化</h2><p>记录项目全生命周期事件；后续新数据可触发漂移检测、增量训练与 MPC 性能评估。</p></div>
  <div class="card-grid two">
    <div class="card">
      <div class="card-title"><span class="title-dot"></span>审计日志</div>
      <div class="table-wrap" id="auditTable">${auditHtml(audit)}</div>
      <div class="action-row"><button class="btn ghost" id="refreshAuditBtn">刷新审计</button></div>
    </div>
    <div class="card">
      <div class="card-title"><span class="title-dot"></span>导出与持续优化</div>
      <div class="info-stack">
        <div class="metric-line"><span>数据快照</span><strong>${state.dataset ? state.dataset.filename : "未接入"}</strong></div>
        <div class="metric-line"><span>小模型注册</span><strong>${state.adapter ? state.adapter.name : "未训练"}</strong></div>
        <div class="metric-line"><span>MPC 轨迹</span><strong>${state.mpc ? "已生成" : "未生成"}</strong></div>
        <div class="metric-line"><span>审计事件</span><strong>${audit.length} 条</strong></div>
      </div>
      <div class="action-row">
        <button class="btn primary" id="exportCsvBtn">导出项目摘要 CSV</button>
        <button class="btn ghost" id="goToOptimizationBtn">回到三维场监控</button>
      </div>
      <div class="metric-line" style="margin-top:16px"><span>大模型 / 小模型原则</span><strong>大模型是通用先验，小模型才是现场适配器</strong></div>
    </div>
  </div>`;
}

function auditHtml(audit) {
  if (!audit || !audit.length) return `<table><thead><tr><th>事件</th><th>级别</th><th>时间</th></tr></thead><tbody><tr><td colspan="3">暂无审计记录</td></tr></tbody></table>`;
  const rows = audit.slice(0, 50).map(item => `<tr><td>${item.event}</td><td>${item.level}</td><td>${item.created_at}</td></tr>`).join("");
  return `<table><thead><tr><th>事件</th><th>级别</th><th>时间</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function bindStage6() {
  $("refreshAuditBtn").addEventListener("click", loadAudit);
  $("exportCsvBtn").addEventListener("click", () => {
    if (!state.project) { toast("请先创建现场项目"); return; }
    window.location.href = `/api/projects/${state.project.id}/export/summary.csv`;
  });
  $("goToOptimizationBtn").addEventListener("click", () => goStage(3));
  loadAudit();
}

async function loadAudit() {
  if (!state.project) { $("auditTable").innerHTML = auditHtml([]); return; }
  try {
    state.audit = await api(`/api/projects/${state.project.id}/audit`);
  } catch (e) {
    state.audit = [];
    toast(e.message);
  }
  const el = $("auditTable");
  if (el) el.innerHTML = auditHtml(state.audit);
}

function assistantMsg(text, role) {
  const log = $("assistantLog");
  const div = document.createElement("div");
  div.className = `assistant-msg ${role}`;
  div.textContent = text;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function initAssistant() {
  const panel = $("assistantPanel");
  const toggle = $("assistantToggle");
  const send = $("assistantSend");
  const input = $("assistantInput");
  const log = $("assistantLog");

  if (!panel || !toggle || !send || !input || !log) return;

  log.innerHTML = "";
  assistantMsg("我是现场助手。大模型只提供通用物理先验；现场小模型才是真正适配器。我不直接控制设备。", "ai");

  toggle.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("collapsed");
    log.style.display = collapsed ? "none" : "";
    input.parentElement.style.display = collapsed ? "none" : "";
    toggle.textContent = collapsed ? "展开" : "收起";
  });

  send.addEventListener("click", sendAssistant);
  input.addEventListener("keydown", e => { if (e.key === "Enter") sendAssistant(); });
  initAssistantDrag(panel, $("assistantHead"));
}

async function sendAssistant() {
  const input = $("assistantInput");
  const text = input.value.trim();
  if (!text) return;
  assistantMsg(text, "user");
  input.value = "";
  try {
    let answer;
    if (state.project) {
      const data = await api(`/api/projects/${state.project.id}/assistant`, { method: "POST", body: JSON.stringify({ text }) });
      answer = data.answer;
    } else {
      answer = "请先创建或选择现场项目。核心原则：实验室大模型是通用先验，现场小模型是适配器；所有控制动作必须经过确定性安全校验。";
    }
    assistantMsg(answer, "ai");
  } catch (e) {
    assistantMsg(`助手调用失败：${e.message}`, "ai");
  }
}

function initAssistantDrag(panel, handle) {
  let drag = null;
  handle.addEventListener("pointerdown", e => {
    if (e.target.closest("button")) return;
    const rect = panel.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panel.style.right = "auto";
    panel.style.bottom = "auto";
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  handle.addEventListener("pointermove", e => {
    if (!drag) return;
    const x = e.clientX - drag.dx;
    const y = e.clientY - drag.dy;
    const maxX = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
    const maxY = Math.max(8, window.innerHeight - panel.offsetHeight - 8);
    panel.style.left = `${Math.min(Math.max(8, x), maxX)}px`;
    panel.style.top = `${Math.min(Math.max(8, y), maxY)}px`;
  });
  const end = e => { drag = null; if (panel.hasPointerCapture(e.pointerId)) panel.releasePointerCapture(e.pointerId); };
  handle.addEventListener("pointerup", end);
  handle.addEventListener("pointercancel", end);
}

bootstrap();
