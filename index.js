import express from "express";
import axios from "axios";

const app = express();
const PORT = 3800;

// ===== Config =====
const API_BASE = "https://api.iran.liara.ir";
const API_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VySUQiOiI2ODlkOTZkZTFhYTM5ZDAzY2ZiZTAwNmMiLCJ0eXBlIjoiYXV0aCIsImlhdCI6MTc1NzA0NTg1NH0.EcpDp-KPy3XUDISQ95-GTPAL56_MtDOFcKE9-TxxnxE";
const CPU_THRESHOLD_UP = 70.0;
const CPU_THRESHOLD_DOWN = 30.0;
const PLANS = [
  "free",
  "basic",
  "medium-g2",
  "standard-base-g2",
  "standard-plus-g2",
  "pro-g2",
  "pro-plus-g2",
  "pro-max-g2",
];
const COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Service list
const SERVICES = {
  auth: "medium-cloud-auth",
  user: "medium-cloud-user",
  post: "medium-cloud-post",
  comment: "medium-cloud-comment",
  feed: "medium-cloud-feed",
};

// State for each service
const serviceState = {};
Object.keys(SERVICES).forEach((svc) => {
  serviceState[svc] = {
    currentPlanIndex: 0, // start small
    lastResizeTime: 0,
  };
});

// ===== Helpers =====
async function getCpuUsage(projectId) {
  const since = Math.floor(Date.now() / 1000) - 120;
  const url = `${API_BASE}/v1/projects/${projectId}/metrics/cpu?since=${since}`;
  const headers = { Authorization: `Bearer ${API_TOKEN}` };

  try {
    const { data } = await axios.get(url, { headers });
    const values = data.result?.[0]?.values || [];
    const cpuNumbers = values
      .map((v) => parseFloat(v[1]))
      .filter((n) => !isNaN(n));
    if (cpuNumbers.length === 0) return 0;
    return cpuNumbers.reduce((a, b) => a + b, 0) / cpuNumbers.length;
  } catch (err) {
    console.error(`Error fetching CPU usage for ${projectId}:`, err.message);
    return 0;
  }
}

async function resizePlan(service, projectId, newPlan) {
  const url = `${API_BASE}/v1/projects/${projectId}/resize`;
  const headers = { Authorization: `Bearer ${API_TOKEN}` };
  const body = { planID: newPlan };

  try {
    await axios.post(url, body, { headers });
    console.log(`Resized ${service} (${projectId}) to plan: ${newPlan}`);
    serviceState[service].lastResizeTime = Date.now();
  } catch (err) {
    console.error(`Error resizing ${service} (${projectId}):`, err.message);
  }
}

async function checkAndScale(service, projectId) {
  const cpu = await getCpuUsage(projectId);
  const now = Date.now();
  const state = serviceState[service];

  console.log(
    `[${new Date().toISOString()}] [${service}] CPU: ${cpu.toFixed(
      2
    )}%, Plan: ${PLANS[state.currentPlanIndex]}`
  );

  // Enforce cooldown
  if (now - state.lastResizeTime < COOLDOWN_MS) {
    console.log(`⏳ ${service} in cooldown. Skipping.`);
    return;
  }

  if (cpu > CPU_THRESHOLD_UP && state.currentPlanIndex < PLANS.length - 1) {
    state.currentPlanIndex++;
    await resizePlan(service, projectId, PLANS[state.currentPlanIndex]);
  } else if (cpu < CPU_THRESHOLD_DOWN && state.currentPlanIndex > 0) {
    state.currentPlanIndex--;
    await resizePlan(service, projectId, PLANS[state.currentPlanIndex]);
  }
}

// ===== Schedule Auto-Scaling for all services =====
setInterval(() => {
  Object.entries(SERVICES).forEach(([service, projectId]) =>
    checkAndScale(service, projectId)
  );
}, 30 * 1000);

// ===== Express Server =====
app.get("/", (req, res) => {
  const status = {};
  Object.keys(SERVICES).forEach((service) => {
    const state = serviceState[service];
    status[service] = {
      currentPlan: PLANS[state.currentPlanIndex],
      cooldownActive: Date.now() - state.lastResizeTime < COOLDOWN_MS,
    };
  });

  res.json({
    status: "running",
    services: status,
    thresholds: { up: CPU_THRESHOLD_UP, down: CPU_THRESHOLD_DOWN },
    cooldownMinutes: COOLDOWN_MS / 60000,
  });
});

app.listen(PORT, () => {
  console.log(`Multi-service auto-scaler running on http://localhost:${PORT}`);
});
