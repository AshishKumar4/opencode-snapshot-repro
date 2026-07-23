import { Sandbox as BaseSandbox, getSandbox } from "@cloudflare/sandbox";
import { createOpencode } from "@cloudflare/sandbox/opencode";
import type { Config } from "@opencode-ai/sdk/v2";

interface Env {
	Sandbox: DurableObjectNamespace<Sandbox>;
	REPRO_TOKEN: string;
}

export class Sandbox extends BaseSandbox<Env> {}

const DIRECTORY = "/workspace";
const SANDBOX_ID = "snapshot-repro";
const DEFAULT_FILE_COUNT = 1_000;
const MAX_FILE_COUNT = 100_000;

function getFileCount(url: URL): number {
	const value = Number(url.searchParams.get("files") ?? DEFAULT_FILE_COUNT);
	if (!Number.isInteger(value) || value < 10 || value > MAX_FILE_COUNT) {
		throw new Error(`files must be an integer from 10 to ${MAX_FILE_COUNT}`);
	}
	return value;
}

function isAuthorized(request: Request, env: Env): boolean {
	return (
		typeof env.REPRO_TOKEN === "string" &&
		env.REPRO_TOKEN.length >= 16 &&
		request.headers.get("authorization") === `Bearer ${env.REPRO_TOKEN}`
	);
}

function getOpencodeConfig(): Config {
	return {
		snapshot: true,
		model: "openai/gpt-4o-mini",
		provider: {
			openai: {
				options: {
					apiKey: "snapshot-repro",
					baseURL: "http://127.0.0.1:1/v1",
				},
			},
		},
	};
}

function getReproSandbox(env: Env) {
	return getSandbox(env.Sandbox, SANDBOX_ID);
}

async function setup(request: Request, env: Env): Promise<Response> {
	const count = getFileCount(new URL(request.url));
	const sandbox = getReproSandbox(env);
	const generator = [
		'import { mkdirSync, writeFileSync } from "node:fs";',
		'import { join } from "node:path";',
		`const count = ${count};`,
		'const root = "/workspace/generated";',
		"for (let i = 0; i < count; i++) {",
		'  const directory = join(root, String(Math.floor(i / 1000)).padStart(4, "0"));',
		"  mkdirSync(directory, { recursive: true });",
		'  writeFileSync(join(directory, String(i).padStart(6, "0") + ".txt"), "snapshot repro\\n");',
		"}",
	].join("\n");
	const encodedGenerator = btoa(generator);
	const setupCommands = [
		"set -eu",
		"pkill -f '[o]pencode serve' 2>/dev/null || true",
		"rm -rf /workspace/.git /workspace/.gitignore /workspace/.opencode /workspace/generated",
		"rm -f /tmp/snapshot-git.log",
		"cd /workspace",
		"git init -q",
		"git config user.name snapshot-repro",
		"git config user.email snapshot-repro@example.com",
		"git commit -q --allow-empty -m baseline",
		`bun -e "$(printf %s '${encodedGenerator}' | base64 -d)"`,
	].join("; ");
	const command = `set +e; (${setupCommands}) > /tmp/repro-setup.log 2>&1; code=$?; cat /tmp/repro-setup.log; printf '\n__REPRO_EXIT__%s\n' "$code"`;

	const startedAt = Date.now();
	const result = await sandbox.exec(command, { timeout: 120_000 });
	const capturedExit = result.stdout.match(/__REPRO_EXIT__(\d+)/)?.[1];
	if (capturedExit !== "0") {
		return Response.json(
			{
				success: false,
				exitCode: capturedExit ? Number(capturedExit) : result.exitCode,
				output: result.stdout.replace(/\n__REPRO_EXIT__\d+\n?$/, ""),
				stderr: result.stderr,
			},
			{ status: 500 },
		);
	}
	return Response.json({
		success: true,
		files: count,
		durationMs: Date.now() - startedAt,
		directory: DIRECTORY,
	});
}

async function start(env: Env): Promise<Response> {
	const sandbox = getReproSandbox(env);
	const { client } = await createOpencode(sandbox, {
		directory: DIRECTORY,
		config: getOpencodeConfig(),
	});
	const session = await client.session.create({
		directory: DIRECTORY,
		title: "Snapshot hang reproduction",
	});
	if (!session.data) {
		throw new Error(`session creation failed: ${JSON.stringify(session.error)}`);
	}
	const accepted = await client.session.promptAsync({
		sessionID: session.data.id,
		directory: DIRECTORY,
		model: { providerID: "openai", modelID: "gpt-4o-mini" },
		parts: [{ type: "text", text: "List the top-level files, then reply with one sentence." }],
	});
	if (accepted.error) {
		throw new Error(`prompt dispatch failed: ${JSON.stringify(accepted.error)}`);
	}
	return Response.json(
		{
			success: true,
			sessionId: session.data.id,
			message: "Prompt accepted. Poll /status?session=<sessionId>.",
		},
		{ status: 202 },
	);
}

interface OsProcess {
	pid: number;
	ppid: number;
	elapsedSeconds: number;
	cpuPercent: number;
	memoryPercent: number;
	rssBytes: number;
	virtualBytes: number;
	state: string;
	command: string;
}

function parseProcesses(output: string): OsProcess[] {
	const processes: OsProcess[] = [];
	for (const line of output.split("\n")) {
		const match = line
			.trim()
			.match(/^(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
		if (!match) continue;
		processes.push({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			elapsedSeconds: Number(match[3]),
			cpuPercent: Number(match[4]),
			memoryPercent: Number(match[5]),
			rssBytes: Number(match[6]) * 1024,
			virtualBytes: Number(match[7]) * 1024,
			state: match[8],
			command: match[9],
		});
	}
	return processes;
}

function parseResourceStats(output: string) {
	const values = new Map<string, string>();
	for (const line of output.split("\n")) {
		const separator = line.indexOf("=");
		if (separator === -1) continue;
		values.set(line.slice(0, separator), line.slice(separator + 1));
	}
	const number = (key: string): number | null => {
		const value = values.get(key);
		if (!value || value === "max") return null;
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	};
	const disk = (values.get("disk") ?? "").trim().split(/\s+/);
	return {
		memory: {
			currentBytes: number("memoryCurrent"),
			limitBytes: number("memoryMax"),
		},
		cpu: {
			usageUsec: number("cpu.usage_usec"),
			userUsec: number("cpu.user_usec"),
			systemUsec: number("cpu.system_usec"),
			nrThrottled: number("cpu.nr_throttled"),
			throttledUsec: number("cpu.throttled_usec"),
		},
		pids: {
			current: number("pidsCurrent"),
			limit: number("pidsMax"),
		},
		disk: {
			totalBytes: Number(disk[0]) || null,
			usedBytes: Number(disk[1]) || null,
			availableBytes: Number(disk[2]) || null,
			usedPercent: Number(disk[3]?.replace("%", "")) || null,
		},
		loadAverage: values.get("loadAverage") ?? null,
		uptimeSeconds: number("uptimeSeconds"),
	};
}

async function status(request: Request, env: Env): Promise<Response> {
	const sandbox = getReproSandbox(env);
	const { client } = await createOpencode(sandbox, {
		directory: DIRECTORY,
		config: getOpencodeConfig(),
	});
	const [sessionStatus, managedProcesses, processTable, fileCount, snapshotLog, resourceOutput] =
		await Promise.all([
		client.session.status({ directory: DIRECTORY }),
		sandbox.listProcesses(),
		sandbox.exec(
			"ps -eo pid=,ppid=,etimes=,pcpu=,pmem=,rss=,vsz=,stat=,args= --sort=-pcpu",
		),
		sandbox.exec("find /workspace/generated -type f 2>/dev/null | wc -l"),
		sandbox.exec("cat /tmp/snapshot-git.log 2>/dev/null || true"),
		sandbox.exec(
			[
				"printf 'memoryCurrent='; cat /sys/fs/cgroup/memory.current 2>/dev/null || true",
				"printf 'memoryMax='; cat /sys/fs/cgroup/memory.max 2>/dev/null || true",
				"printf 'pidsCurrent='; cat /sys/fs/cgroup/pids.current 2>/dev/null || true",
				"printf 'pidsMax='; cat /sys/fs/cgroup/pids.max 2>/dev/null || true",
				"sed 's/^/cpu./; s/ /=' /sys/fs/cgroup/cpu.stat 2>/dev/null || true",
				"printf 'disk='; df -B1 --output=size,used,avail,pcent /workspace 2>/dev/null | tail -n 1",
				"printf 'loadAverage='; cat /proc/loadavg 2>/dev/null || true",
				"printf 'uptimeSeconds='; cut -d' ' -f1 /proc/uptime 2>/dev/null || true",
			].join("; "),
		),
	]);
	const requestedSession = new URL(request.url).searchParams.get("session");
	const osProcesses = parseProcesses(processTable.stdout);
	return Response.json({
		sampledAt: Date.now(),
		requestedSession,
		sessionStatus: sessionStatus.data ?? null,
		managedProcesses: managedProcesses.map((process) => ({
			id: process.id,
			status: process.status,
			command: process.command,
		})),
		osProcesses,
		snapshotProcesses: osProcesses.filter(
			(process) =>
				process.command.includes("opencode") ||
				process.command.includes("--git-dir") ||
				process.command === "sleep 3600",
		),
		resources: parseResourceStats(resourceOutput.stdout),
		snapshotGitLog: snapshotLog.stdout,
		fileCount: Number(fileCount.stdout.trim()),
	});
}

function home(): Response {
	return new Response(
		String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenCode Snapshot Hang Reproduction</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#090a0c;color:#f4f4f5;--orange:#f6821f;--panel:#111318;--panel-2:#171a20;--line:#292d36;--muted:#979ca8;--green:#57d18a;--yellow:#f7bd5b;--red:#ff6b6b}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 75% 0,#24180f 0,transparent 26rem),#090a0c;min-height:100vh}main{width:min(1180px,calc(100% - 32px));margin:0 auto;padding:36px 0 64px}.eyebrow{font:600 11px/1.2 ui-monospace,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--orange)}h1{font-size:clamp(28px,5vw,48px);line-height:1.02;letter-spacing:-.04em;margin:10px 0 14px;max-width:780px}p{color:var(--muted);line-height:1.6;margin:0}.lede{max-width:760px;font-size:15px}.origin{display:inline-flex;align-items:center;gap:8px;margin-top:18px;padding:7px 10px;border:1px solid var(--line);border-radius:999px;background:#0d0f13;font:12px ui-monospace,monospace;color:#c9cbd1}.dot{width:7px;height:7px;border-radius:50%;background:var(--green);box-shadow:0 0 12px var(--green)}.panel{border:1px solid var(--line);background:linear-gradient(180deg,var(--panel-2),var(--panel));border-radius:14px;margin-top:22px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 18px;border-bottom:1px solid var(--line)}.panel-head h2{font-size:14px;margin:0}.panel-body{padding:18px}.auth-grid{display:grid;grid-template-columns:minmax(220px,1fr) 150px;gap:10px}.token-state{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid #2f4439;border-radius:8px;padding:9px 12px;background:#0e1713;color:var(--green);font-size:13px}.token-state button{padding:7px 10px}input,button{font:inherit;border:1px solid #3a3f49;border-radius:8px;padding:11px 12px;background:#0d0f13;color:#f4f4f5}input:focus{outline:2px solid #f6821f55;border-color:var(--orange)}button{cursor:pointer;font-weight:650;transition:.15s ease}button:hover{border-color:#717784;transform:translateY(-1px)}button:disabled{opacity:.45;cursor:wait;transform:none}.primary{background:var(--orange);border-color:var(--orange);color:#180d04}.danger{color:#ff9b9b}.steps{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-top:14px}.step{text-align:left;display:flex;align-items:center;gap:10px}.step span{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:#292d36;font:700 11px ui-monospace,monospace}.step.active{border-color:var(--orange)}.step.active span{background:var(--orange);color:#170c03}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-top:22px}.metric{padding:14px;border:1px solid var(--line);border-radius:11px;background:#101217}.metric-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.08em}.metric-value{font:650 21px/1.2 ui-monospace,monospace;margin-top:9px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metric-sub{font-size:11px;color:var(--muted);margin-top:5px}.bar{height:3px;background:#2a2e36;border-radius:2px;margin-top:10px;overflow:hidden}.bar i{display:block;height:100%;width:0;background:var(--orange);transition:width .3s}.status-pill{font:700 11px ui-monospace,monospace;text-transform:uppercase;padding:5px 8px;border-radius:99px;background:#292d36}.status-pill.busy{background:#3b2c13;color:var(--yellow)}.status-pill.ready{background:#143322;color:var(--green)}.status-pill.error{background:#3a1719;color:var(--red)}.table-wrap{overflow:auto;max-height:420px}table{width:100%;border-collapse:collapse;font:12px ui-monospace,monospace}th{position:sticky;top:0;background:#15181e;color:var(--muted);font-weight:600;text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}td{padding:9px 12px;border-bottom:1px solid #20232a;white-space:nowrap}td.command{max-width:620px;overflow:hidden;text-overflow:ellipsis}.snapshot-row{background:#2a1c0c;color:#ffd199}.empty{padding:34px;text-align:center;color:var(--muted)}pre{margin:0;white-space:pre-wrap;overflow-wrap:anywhere;background:#0b0d10;color:#c7cad1;padding:16px;font:12px/1.55 ui-monospace,monospace;max-height:320px;overflow:auto}.evidence{border-left:3px solid var(--orange)}details summary{cursor:pointer;padding:13px 16px;color:var(--muted);font-size:12px}.footer{display:flex;justify-content:space-between;gap:20px;margin-top:18px;font-size:12px;color:#717784}.footer a{color:#b8bbc3}.spin{display:inline-block;width:12px;height:12px;border:2px solid #ffffff44;border-top-color:#fff;border-radius:50%;animation:spin .7s linear infinite}.auth-modal{position:fixed;inset:0;z-index:20;display:grid;place-items:center;padding:20px;background:rgba(4,5,7,.82);backdrop-filter:blur(12px)}.auth-modal[hidden]{display:none}.auth-card{width:min(440px,100%);border:1px solid #3a3f49;border-radius:16px;padding:24px;background:#14171c;box-shadow:0 28px 90px #000}.auth-card h2{margin:8px 0 10px;font-size:24px}.auth-card p{margin-bottom:18px}.auth-card form{display:grid;gap:10px}.auth-card button{width:100%}.auth-error{min-height:18px;color:var(--red);font-size:12px}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:850px){.metrics{grid-template-columns:repeat(3,1fr)}}@media(max-width:600px){main{width:min(100% - 20px,1180px);padding-top:22px}.auth-grid,.steps{grid-template-columns:1fr}.metrics{grid-template-columns:repeat(2,1fr)}.panel-head{align-items:flex-start;flex-direction:column}.footer{flex-direction:column}}
</style>
</head>
<body>
<div id="authModal" class="auth-modal" role="dialog" aria-modal="true" aria-labelledby="authTitle"><div class="auth-card"><div class="eyebrow">Authentication required</div><h2 id="authTitle">Enter the deployment token</h2><p>Use the <code>REPRO_TOKEN</code> configured when this Worker was deployed. It is kept only for this browser tab.</p><form id="authForm"><input id="token" type="password" autocomplete="current-password" minlength="16" placeholder="REPRO_TOKEN" required autofocus><button id="authSubmit" class="primary" type="submit">Continue to reproduction</button><div id="authError" class="auth-error" role="alert"></div></form></div></div>
<main>
<header><div class="eyebrow">Cloudflare Sandbox · OpenCode 1.17.4</div><h1>Snapshot liveness laboratory</h1><p class="lede">Reproduce an OpenCode session blocked by its private Git snapshot. No model credentials, no inference spend, and no large repository required.</p><div class="origin"><span class="dot"></span><span id="origin"></span></div></header>
<section class="panel"><div class="panel-head"><h2>Reproduction controls</h2><span id="phase" class="status-pill">Not started</span></div><div class="panel-body"><div class="auth-grid"><div class="token-state"><span>✓ Token accepted for this tab</span><button id="changeToken" type="button">Change</button></div><input id="files" type="number" min="10" max="100000" value="1000" title="Generated files"></div><div class="steps"><button id="setup" class="step primary"><span>1</span>Setup repository</button><button id="start" class="step"><span>2</span>Start reproduction</button><button id="status" class="step"><span>3</span>Refresh telemetry</button></div><div class="footer"><span>Run the steps in order. Telemetry refreshes every two seconds.</span><button id="reset" class="danger">Destroy sandbox</button></div></div></section>
<section class="metrics"><div class="metric"><div class="metric-label">Session</div><div id="sessionMetric" class="metric-value">—</div><div id="sessionSub" class="metric-sub">No session</div></div><div class="metric"><div class="metric-label">CPU</div><div id="cpuMetric" class="metric-value">—</div><div class="metric-sub">cgroup live sample</div></div><div class="metric"><div class="metric-label">Memory</div><div id="memoryMetric" class="metric-value">—</div><div id="memorySub" class="metric-sub">current / limit</div><div class="bar"><i id="memoryBar"></i></div></div><div class="metric"><div class="metric-label">Disk</div><div id="diskMetric" class="metric-value">—</div><div id="diskSub" class="metric-sub">used / total</div><div class="bar"><i id="diskBar"></i></div></div><div class="metric"><div class="metric-label">Processes</div><div id="processMetric" class="metric-value">—</div><div id="processSub" class="metric-sub">container PIDs</div></div><div class="metric"><div class="metric-label">Files</div><div id="fileMetric" class="metric-value">—</div><div class="metric-sub">generated worktree</div></div></section>
<section class="panel"><div class="panel-head"><h2>Live container processes</h2><span id="sampleTime" class="metric-sub">No sample</span></div><div class="table-wrap"><table><thead><tr><th>PID</th><th>PPID</th><th>Age</th><th>CPU</th><th>RSS</th><th>State</th><th>Command</th></tr></thead><tbody id="processRows"><tr><td colspan="7" class="empty">Run setup to start the container.</td></tr></tbody></table></div></section>
<section class="panel evidence"><div class="panel-head"><h2>Snapshot evidence</h2><span class="metric-sub">Expected Git child and intercepted command</span></div><pre id="evidence">Waiting for reproduction.</pre></section>
<section class="panel"><details><summary>Raw API response</summary><pre id="output">Enter the deployment token, then click Setup repository.</pre></details></section>
<div class="footer"><span>Metrics are instantaneous readings from the container via Sandbox SDK.</span><a href="https://github.com/AshishKumar4/opencode-snapshots-bug" target="_blank" rel="noreferrer">Source and manual steps ↗</a></div>
</main>
<script>
const token = document.querySelector('#token');
const authModal = document.querySelector('#authModal');
const authForm = document.querySelector('#authForm');
const authSubmit = document.querySelector('#authSubmit');
const authError = document.querySelector('#authError');
const changeToken = document.querySelector('#changeToken');
const files = document.querySelector('#files');
const output = document.querySelector('#output');
const phase = document.querySelector('#phase');
const processRows = document.querySelector('#processRows');
const evidence = document.querySelector('#evidence');
let sessionId = sessionStorage.getItem('snapshotReproSession') || '';
token.value = sessionStorage.getItem('snapshotReproToken') || '';
let timer;
let previousCpu;
document.querySelector('#origin').textContent = location.origin;
function bytes(value) {
  if (value == null) return '—';
  const units = ['B','KiB','MiB','GiB']; let index = 0; let size = value;
  while (size >= 1024 && index < units.length - 1) { size /= 1024; index++; }
  return size.toFixed(index > 1 ? 1 : 0) + ' ' + units[index];
}
function age(seconds) {
  if (seconds < 60) return seconds + 's';
  if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + (seconds % 60) + 's';
  return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
}
function setPhase(label, kind) {
  phase.textContent = label; phase.className = 'status-pill ' + (kind || '');
}
function cell(value, className) { const td = document.createElement('td'); td.textContent = value; if (className) td.className = className; return td; }
function render(data) {
  const state = data.requestedSession && data.sessionStatus && data.sessionStatus[data.requestedSession];
  const stateName = state && state.type ? state.type : (data.managedProcesses.some(p => p.status === 'running') ? 'ready' : 'idle');
  document.querySelector('#sessionMetric').textContent = stateName;
  document.querySelector('#sessionSub').textContent = data.requestedSession || 'Container only';
  setPhase(stateName === 'busy' ? 'Snapshot blocked' : stateName, stateName === 'busy' ? 'busy' : 'ready');
  const currentCpu = data.resources && data.resources.cpu && data.resources.cpu.usageUsec;
  let cpu = null;
  if (previousCpu && currentCpu != null) cpu = Math.max(0, (currentCpu - previousCpu.usage) / ((data.sampledAt - previousCpu.at) * 1000) * 100);
  if (currentCpu != null) previousCpu = { usage: currentCpu, at: data.sampledAt };
  document.querySelector('#cpuMetric').textContent = cpu == null ? 'sampling…' : cpu.toFixed(1) + '%';
  const memory = data.resources && data.resources.memory || {};
  document.querySelector('#memoryMetric').textContent = bytes(memory.currentBytes);
  document.querySelector('#memorySub').textContent = bytes(memory.currentBytes) + ' / ' + bytes(memory.limitBytes);
  const memoryPct = memory.limitBytes ? memory.currentBytes / memory.limitBytes * 100 : 0;
  document.querySelector('#memoryBar').style.width = Math.min(100, memoryPct) + '%';
  const disk = data.resources && data.resources.disk || {};
  document.querySelector('#diskMetric').textContent = disk.usedPercent == null ? '—' : disk.usedPercent + '%';
  document.querySelector('#diskSub').textContent = bytes(disk.usedBytes) + ' / ' + bytes(disk.totalBytes);
  document.querySelector('#diskBar').style.width = Math.min(100, disk.usedPercent || 0) + '%';
  document.querySelector('#processMetric').textContent = String(data.osProcesses.length);
  document.querySelector('#processSub').textContent = (data.resources.pids.current || data.osProcesses.length) + ' cgroup PIDs';
  document.querySelector('#fileMetric').textContent = Number(data.fileCount || 0).toLocaleString();
  document.querySelector('#sampleTime').textContent = 'Updated ' + new Date(data.sampledAt).toLocaleTimeString();
  processRows.replaceChildren();
  for (const process of data.osProcesses) {
    const row = document.createElement('tr');
    if (process.command.includes('--git-dir') || process.command === 'sleep 3600') row.className = 'snapshot-row';
    row.append(cell(String(process.pid)), cell(String(process.ppid)), cell(age(process.elapsedSeconds)), cell(process.cpuPercent.toFixed(1) + '%'), cell(bytes(process.rssBytes)), cell(process.state), cell(process.command, 'command'));
    processRows.append(row);
  }
  if (!data.osProcesses.length) processRows.innerHTML = '<tr><td colspan="7" class="empty">No processes reported.</td></tr>';
  const snapshot = data.snapshotProcesses.map(p => p.command).join('\n');
  evidence.textContent = (data.snapshotGitLog || 'Snapshot Git command has not started yet.') + (snapshot ? '\n\nLive process:\n' + snapshot : '');
  output.textContent = JSON.stringify(data, null, 2);
}
async function request(path, method = 'GET', quiet = false) {
  sessionStorage.setItem('snapshotReproToken', token.value);
  if (!quiet) output.textContent = method + ' ' + path + '\nWorking...';
  const response = await fetch(path, { method, headers: { authorization: 'Bearer ' + token.value } });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { status: response.status, body: text }; }
  if (!quiet) output.textContent = JSON.stringify(body, null, 2);
  if (!response.ok) throw new Error('Request failed: ' + response.status);
  return body;
}
function run(button, action) {
  return async () => {
    document.querySelectorAll('button').forEach(b => b.disabled = true);
    const original = button.innerHTML; button.innerHTML = '<i class="spin"></i> Working';
    try { await action(); } catch (error) { setPhase('Error', 'error'); output.textContent += '\n\n' + error.message; }
    finally { document.querySelectorAll('button').forEach(b => b.disabled = false); button.innerHTML = original; }
  };
}
const setup = document.querySelector('#setup');
const start = document.querySelector('#start');
const status = document.querySelector('#status');
const reset = document.querySelector('#reset');
async function authenticate() {
  const value = token.value.trim();
  if (value.length < 16) { authError.textContent = 'Enter the complete token (at least 16 characters).'; return; }
  authSubmit.disabled = true; authSubmit.textContent = 'Checking token…'; authError.textContent = '';
  try {
    const response = await fetch('/auth', { headers: { authorization: 'Bearer ' + value } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || 'Token was not accepted.');
    sessionStorage.setItem('snapshotReproToken', value); authModal.hidden = true; setPhase('Ready', 'ready');
  } catch (error) { authError.textContent = error.message; }
  finally { authSubmit.disabled = false; authSubmit.textContent = 'Continue to reproduction'; }
}
authForm.addEventListener('submit', event => { event.preventDefault(); authenticate(); });
changeToken.addEventListener('click', () => { authError.textContent = ''; authModal.hidden = false; token.focus(); });
if (token.value) authenticate(); else token.focus();
async function refresh(quiet = false) {
  if (!sessionId) { if (!quiet) output.textContent = 'Start the reproduction first.'; return; }
  const data = await request('/status?session=' + encodeURIComponent(sessionId), 'GET', quiet);
  render(data);
}
setup.onclick = run(setup, async () => { clearInterval(timer); await request('/setup?files=' + encodeURIComponent(files.value), 'POST'); setPhase('Repository ready', 'ready'); });
start.onclick = run(start, async () => {
  const body = await request('/start', 'POST');
  sessionId = body.sessionId;
  sessionStorage.setItem('snapshotReproSession', sessionId);
  setPhase('Starting snapshot', 'busy');
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => refresh(true).catch(() => {}), 2000);
});
status.onclick = run(status, () => refresh());
reset.onclick = run(reset, async () => {
  clearInterval(timer);
  await request('/reset', 'POST');
  sessionStorage.removeItem('snapshotReproSession');
  sessionId = '';
  previousCpu = null;
  setPhase('Destroyed', '');
  processRows.innerHTML = '<tr><td colspan="7" class="empty">Sandbox destroyed.</td></tr>';
  evidence.textContent = 'Waiting for reproduction.';
});
</script>
</body>
</html>`,
		{ headers: { "content-type": "text/html; charset=utf-8" } },
	);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		if (request.method === "GET" && url.pathname === "/") return home();
		if (request.method === "GET" && url.pathname === "/favicon.ico") {
			return new Response(null, { status: 204, headers: { "cache-control": "public, max-age=86400" } });
		}
		if (request.method === "GET" && url.pathname === "/health") {
			return Response.json({
				ok: true,
				tokenConfigured: typeof env.REPRO_TOKEN === "string" && env.REPRO_TOKEN.length >= 16,
			});
		}
		if (typeof env.REPRO_TOKEN !== "string" || env.REPRO_TOKEN.length < 16) {
			return Response.json(
				{ error: "REPRO_TOKEN is not configured. Add the Worker secret and reload." },
				{ status: 503 },
			);
		}
		if (!isAuthorized(request, env)) return new Response("Unauthorized", { status: 401 });
		if (request.method === "GET" && url.pathname === "/auth") {
			return Response.json({ ok: true });
		}

		try {
			if (request.method === "POST" && url.pathname === "/setup") return await setup(request, env);
			if (request.method === "POST" && url.pathname === "/start") return await start(env);
			if (request.method === "GET" && url.pathname === "/status") return await status(request, env);
			if (request.method === "POST" && url.pathname === "/reset") {
				await getReproSandbox(env).destroy();
				return Response.json({ success: true });
			}
			return new Response("Not found", { status: 404 });
		} catch (error) {
			return Response.json(
				{ success: false, error: error instanceof Error ? error.message : "Unknown error" },
				{ status: 500 },
			);
		}
	},
};
