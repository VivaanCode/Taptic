const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const dotenv = require("dotenv");

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
	cors: {
		origin: "*",
	},
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const SESSION_COOKIE_NAME = "seam_dashboard_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();

function normalizeDatabaseUrl(rawValue) {
	if (!rawValue) {
		return null;
	}

	const match = rawValue.match(/postgres(?:ql)?:\/\/[^\s'\"]+/i);
	if (match) {
		return match[0];
	}

	return rawValue.trim().replace(/^['\"]|['\"]$/g, "");
}

const databaseUrl = normalizeDatabaseUrl(process.env.DATABASE_URL);

if (!databaseUrl) {
	throw new Error("DATABASE_URL is missing from backend/.env");
}

const isLocalDatabase = /(localhost|127\.0\.0\.1)/i.test(databaseUrl);
const pool = new Pool({
	connectionString: databaseUrl,
	ssl: isLocalDatabase ? false : { rejectUnauthorized: false },
});

function generateToken() {
	return crypto.randomBytes(18).toString("hex");
}

function parseCookies(cookieHeader = "") {
	const cookies = {};
	for (const part of cookieHeader.split(";")) {
		const [key, ...valueParts] = part.trim().split("=");
		if (!key) {
			continue;
		}

		cookies[key] = decodeURIComponent(valueParts.join("="));
	}

	return cookies;
}

function createSession(userId) {
	const sessionId = crypto.randomBytes(24).toString("hex");
	sessions.set(sessionId, {
		userId,
		expiresAt: Date.now() + SESSION_TTL_MS,
	});

	return sessionId;
}

function escapeHtml(value) {
	return String(value ?? "")
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

function toInteger(value) {
	const parsed = Number.parseInt(value, 10);
	if (Number.isNaN(parsed)) {
		return 0;
	}

	return parsed;
}

function parseMemberUsernames(memberUsernamesText, leaderUsername) {
	const usernames = memberUsernamesText
		.split(/[,\n]/)
		.map((entry) => entry.trim())
		.filter(Boolean);

	const seen = new Set();
	const normalized = [];

	for (const username of usernames) {
		const key = username.toLowerCase();
		if (key === leaderUsername.toLowerCase()) {
			continue;
		}

		if (seen.has(key)) {
			continue;
		}

		seen.add(key);
		normalized.push(username);
	}

	return normalized;
}

function renderPage(title, bodyContent) {
	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f5f7fb;
      --panel: #ffffff;
      --ink: #1c2430;
      --accent: #1f6feb;
      --muted: #6b7280;
      --border: #dbe3f0;
      --ok: #0f766e;
      --warn: #b45309;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: "Segoe UI", Tahoma, Geneva, Verdana, sans-serif;
      color: var(--ink);
      background: radial-gradient(circle at top right, #e6efff, var(--bg));
      padding: 24px;
    }
    .container {
      max-width: 1080px;
      margin: 0 auto;
    }
    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 16px;
      box-shadow: 0 6px 16px rgba(0, 0, 0, 0.05);
    }
    h1, h2, h3 { margin-top: 0; }
    a {
      color: var(--accent);
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    form { display: grid; gap: 12px; }
    input, textarea, button {
      font: inherit;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px 12px;
      background: #fff;
    }
    button {
      width: auto;
      background: var(--accent);
      color: #fff;
      border: 0;
      cursor: pointer;
    }
    .row {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    th, td {
      border: 1px solid var(--border);
      padding: 8px;
      text-align: left;
    }
    th { background: #f2f6ff; }
    .muted { color: var(--muted); }
    .ok { color: var(--ok); }
    .warn { color: var(--warn); }
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 12px;
    }
    .card {
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px;
      background: #fafcff;
    }
    .card strong {
      display: block;
      font-size: 1.6rem;
      margin-top: 4px;
    }
  </style>
</head>
<body>
  <div class="container">
    ${bodyContent}
  </div>
</body>
</html>`;
}

function renderError(title, message) {
	return renderPage(
		title,
		`<div class="panel"><h1>${escapeHtml(title)}</h1><p class="warn">${escapeHtml(message)}</p><p><a href="/">Back to home</a></p></div>`,
	);
}

async function getAuthenticatedLeader(req) {
	const cookies = parseCookies(req.headers.cookie);
	const sessionId = cookies[SESSION_COOKIE_NAME];

	if (!sessionId) {
		return null;
	}

	const session = sessions.get(sessionId);
	if (!session) {
		return null;
	}

	if (session.expiresAt < Date.now()) {
		sessions.delete(sessionId);
		return null;
	}

	session.expiresAt = Date.now() + SESSION_TTL_MS;

	const result = await pool.query(
		`SELECT u.id, u.username, u.token, u.team_id, t.name AS team_name
		 FROM users u
		 JOIN teams t ON t.id = u.team_id
		 WHERE u.id = $1 AND u.role = 'leader'`,
		[session.userId],
	);

	if (result.rowCount === 0) {
		sessions.delete(sessionId);
		return null;
	}

	return result.rows[0];
}

function serializeForInlineScript(value) {
	return JSON.stringify(value).replace(/</g, "\\u003c");
}

async function getTeamDashboardData(teamId) {
	const summaryResult = await pool.query(
		`SELECT
			COUNT(*)::INT AS total_heartbeats,
			COALESCE(SUM(characters_added + characters_removed + characters_modified), 0)::INT AS total_character_changes,
			COUNT(DISTINCT service)::INT AS services_used,
			MAX(received_at) AS last_heartbeat_at
		 FROM heartbeats
		 WHERE team_id = $1`,
		[teamId],
	);

	const usersResult = await pool.query(
		`SELECT
			u.username,
			u.role,
			COUNT(h.id)::INT AS heartbeat_count,
			COALESCE(SUM(h.characters_added), 0)::INT AS characters_added,
			COALESCE(SUM(h.characters_removed), 0)::INT AS characters_removed,
			COALESCE(SUM(h.characters_modified), 0)::INT AS characters_modified,
			COALESCE(SUM(h.characters_added + h.characters_removed + h.characters_modified), 0)::INT AS total_activity
		 FROM users u
		 LEFT JOIN heartbeats h ON h.user_id = u.id
		 WHERE u.team_id = $1
		 GROUP BY u.id
		 ORDER BY total_activity DESC, u.username ASC`,
		[teamId],
	);

	const dailyResult = await pool.query(
		`SELECT
			TO_CHAR(day::date, 'YYYY-MM-DD') AS day,
			COALESCE(SUM(h.characters_added + h.characters_removed + h.characters_modified), 0)::INT AS total_activity,
			COALESCE(COUNT(h.id), 0)::INT AS heartbeat_count
		 FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS day
		 LEFT JOIN heartbeats h
			ON DATE(h.received_at) = DATE(day)
			AND h.team_id = $1
		 GROUP BY day
		 ORDER BY day ASC`,
		[teamId],
	);

	return {
		summary: summaryResult.rows[0],
		users: usersResult.rows,
		daily: dailyResult.rows,
	};
}

function renderDashboardPage(leaderUsername, leaderSecret) {
	const leaderCredentials = serializeForInlineScript({
		username: leaderUsername,
		secret: leaderSecret,
	});

	return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Team Activity Dashboard</title>
	<script src="https://cdn.tailwindcss.com"></script>
	<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
	<script>
		tailwind.config = {
			theme: {
				extend: {
					colors: {
						glass: {
							100: "rgba(255, 255, 255, 0.1)",
							200: "rgba(255, 255, 255, 0.05)",
						},
					},
				},
			},
		};
	</script>
	<style>
		::-webkit-scrollbar {
			width: 8px;
			height: 8px;
		}
		::-webkit-scrollbar-track {
			background: rgba(255, 255, 255, 0.02);
		}
		::-webkit-scrollbar-thumb {
			background: rgba(255, 255, 255, 0.15);
			border-radius: 10px;
		}
		::-webkit-scrollbar-thumb:hover {
			background: rgba(255, 255, 255, 0.25);
		}
		.glass-panel {
			background: rgba(255, 255, 255, 0.07);
			backdrop-filter: blur(16px);
			-webkit-backdrop-filter: blur(16px);
			border: 1px solid rgba(255, 255, 255, 0.15);
			box-shadow: 0 8px 32px 0 rgba(0, 0, 0, 0.3);
		}
	</style>
</head>
<body class="bg-slate-950 text-slate-200 font-sans antialiased relative min-h-screen overflow-x-hidden">
	<div class="fixed top-[-10%] left-[-10%] w-[500px] h-[500px] bg-indigo-600 rounded-full mix-blend-screen filter blur-[150px] opacity-40 z-0 pointer-events-none"></div>
	<div class="fixed bottom-[-10%] right-[-10%] w-[600px] h-[600px] bg-teal-600 rounded-full mix-blend-screen filter blur-[150px] opacity-30 z-0 pointer-events-none"></div>
	<div class="fixed top-[40%] left-[60%] w-[400px] h-[400px] bg-fuchsia-700 rounded-full mix-blend-screen filter blur-[150px] opacity-30 z-0 pointer-events-none"></div>

	<div class="relative z-10 container mx-auto px-4 py-8 max-w-7xl">
		<header class="glass-panel rounded-2xl p-6 mb-8 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
			<div>
				<h1 class="text-3xl font-bold text-white tracking-tight">Team Dashboard</h1>
				<p class="text-slate-400 mt-1">
					Welcome, <strong class="text-indigo-300" id="leader-name">...</strong>
					(Team: <strong class="text-indigo-300" id="team-name">...</strong>)
				</p>
			</div>
			<div class="flex items-center gap-4 flex-wrap">
				<span class="text-sm text-slate-400">Last Sync: <span id="last-sync" class="text-white">...</span></span>
				<a href="/dashboard/logout" class="bg-white/10 hover:bg-white/20 transition-colors border border-white/10 px-5 py-2 rounded-lg text-sm font-medium text-white backdrop-blur-md">Logout</a>
			</div>
		</header>

		<div id="dashboard-error" class="hidden mb-8 rounded-xl border border-red-400/30 bg-red-500/20 px-4 py-3 text-red-100"></div>

		<div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-6 mb-8">
			<div class="glass-panel rounded-2xl p-6 flex flex-col justify-center relative overflow-hidden">
				<div class="absolute top-0 right-0 p-4 opacity-20">
					<svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/></svg>
				</div>
				<span class="text-sm text-slate-400 font-medium uppercase tracking-wider mb-1">Team Members</span>
				<strong class="text-3xl font-bold text-white" id="stat-members">0</strong>
			</div>

			<div class="glass-panel rounded-2xl p-6 flex flex-col justify-center relative overflow-hidden">
				<div class="absolute top-0 right-0 p-4 opacity-20 text-rose-400">
					<svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
				</div>
				<span class="text-sm text-slate-400 font-medium uppercase tracking-wider mb-1">Total Heartbeats</span>
				<strong class="text-3xl font-bold text-white" id="stat-heartbeats">0</strong>
			</div>

			<div class="glass-panel rounded-2xl p-6 flex flex-col justify-center relative overflow-hidden">
				<div class="absolute top-0 right-0 p-4 opacity-20 text-teal-400">
					<svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>
				</div>
				<span class="text-sm text-slate-400 font-medium uppercase tracking-wider mb-1">Total Char Activity</span>
				<strong class="text-3xl font-bold text-white" id="stat-chars">0</strong>
			</div>

			<div class="glass-panel rounded-2xl p-6 flex flex-col justify-center relative overflow-hidden">
				<div class="absolute top-0 right-0 p-4 opacity-20 text-amber-400">
					<svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M19.3 16.9c.4-.7.7-1.5.7-2.4 0-2.5-2-4.5-4.5-4.5S11 12 11 14.5s2 4.5 4.5 4.5c.9 0 1.7-.3 2.4-.7l3.2 3.2 1.4-1.4-3.2-3.2zm-3.8.1c-1.4 0-2.5-1.1-2.5-2.5s1.1-2.5 2.5-2.5 2.5 1.1 2.5 2.5-1.1 2.5-2.5 2.5zM12 20H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h16c1.1 0 2 .9 2 2v4.1c-.8-.1-1.6-.1-2.5-.1 0 0 0-4 0-4H4v12h8v2z"/></svg>
				</div>
				<span class="text-sm text-slate-400 font-medium uppercase tracking-wider mb-1">Services Used</span>
				<strong class="text-3xl font-bold text-white" id="stat-services">0</strong>
			</div>

			<div class="glass-panel rounded-2xl p-6 flex flex-col justify-center relative overflow-hidden">
				<div class="absolute top-0 right-0 p-4 opacity-20 text-indigo-400">
					<svg class="w-12 h-12" fill="currentColor" viewBox="0 0 24 24"><path d="M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z"/></svg>
				</div>
				<span class="text-sm text-slate-400 font-medium uppercase tracking-wider mb-1">Peak Daily Activity</span>
				<strong class="text-3xl font-bold text-white" id="stat-peak">0</strong>
				<span class="text-xs text-indigo-300 mt-1" id="stat-peak-date">No activity yet</span>
			</div>
		</div>

		<div class="grid grid-cols-1 lg:grid-cols-2 gap-8 mb-8">
			<div class="glass-panel rounded-2xl p-6">
				<h2 class="text-xl font-semibold text-white mb-4">Daily Team Activity (Last 14 Days)</h2>
				<div class="relative h-72 w-full">
					<canvas id="teamActivityChart"></canvas>
				</div>
			</div>

			<div class="glass-panel rounded-2xl p-6">
				<h2 class="text-xl font-semibold text-white mb-4">User Contribution Comparison</h2>
				<div class="relative h-72 w-full">
					<canvas id="userContributionChart"></canvas>
				</div>
			</div>
		</div>

		<div class="glass-panel rounded-2xl p-6 overflow-hidden flex flex-col">
			<h2 class="text-xl font-semibold text-white mb-4">Detailed User Metrics</h2>
			<div class="overflow-x-auto">
				<table class="w-full text-left border-collapse">
					<thead>
						<tr class="border-b border-white/10 text-slate-400 text-sm tracking-wider uppercase">
							<th class="p-4 font-medium">Username</th>
							<th class="p-4 font-medium">Role</th>
							<th class="p-4 font-medium text-right">Heartbeats</th>
							<th class="p-4 font-medium text-right text-emerald-400">Added</th>
							<th class="p-4 font-medium text-right text-rose-400">Removed</th>
							<th class="p-4 font-medium text-right text-amber-400">Modified</th>
							<th class="p-4 font-medium text-right text-white">Total Activity</th>
							<th class="p-4 font-medium text-right text-indigo-300">Efficiency*</th>
						</tr>
					</thead>
					<tbody id="user-table-body" class="divide-y divide-white/5"></tbody>
				</table>
			</div>
			<div class="mt-4 flex justify-between items-center text-xs text-slate-500">
				<span>* Efficiency = Total Activity / Heartbeats (Avg Chars per Heartbeat)</span>
			</div>
		</div>
	</div>

	<script>
		const leaderCredentials = ${leaderCredentials};
		const DASHBOARD_REFRESH_INTERVAL_MS = 30000;
		let teamActivityChartInstance = null;
		let userContributionChartInstance = null;
		let isDashboardLoading = false;

		const formatNumber = (num) => new Intl.NumberFormat("en-US").format(Number(num || 0));

		const formatDate = (dateStr) => {
			if (!dateStr) {
				return "No data yet";
			}

			const date = new Date(dateStr);
			if (Number.isNaN(date.getTime())) {
				return "No data yet";
			}

			return new Intl.DateTimeFormat("en-US", {
				month: "short",
				day: "numeric",
				hour: "2-digit",
				minute: "2-digit",
			}).format(date);
		};

		const escapeHtmlClient = (unsafe) => {
			return String(unsafe || "")
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/\"/g, "&quot;")
				.replace(/'/g, "&#039;");
		};

		function showDashboardError(message) {
			const errorEl = document.getElementById("dashboard-error");
			errorEl.textContent = message;
			errorEl.classList.remove("hidden");
		}

		function clearDashboardError() {
			const errorEl = document.getElementById("dashboard-error");
			errorEl.textContent = "";
			errorEl.classList.add("hidden");
		}

		function buildInitials(username) {
			const value = String(username || "").trim();
			if (!value) {
				return "??";
			}

			const chunk = value.slice(0, 2).toUpperCase();
			return escapeHtmlClient(chunk);
		}

		function renderUserTable(users) {
			const tbody = document.getElementById("user-table-body");

			if (!users.length) {
				tbody.innerHTML = '<tr><td colspan="8" class="p-4 text-center text-slate-500">No user data available</td></tr>';
				return;
			}

			const tableHtml = users.map((user) => {
				const heartbeatCount = Number(user.heartbeat_count || 0);
				const efficiency = heartbeatCount > 0
					? Math.round(Number(user.total_activity || 0) / heartbeatCount)
					: 0;
				const roleValue = String(user.role || "member");
				const roleLabel = roleValue.charAt(0).toUpperCase() + roleValue.slice(1);
				const isLeader = roleValue.toLowerCase() === "leader";
				const roleClass = isLeader
					? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30"
					: "bg-white/5 border border-white/10";

				return "<tr class=\"hover:bg-white/5 transition-colors group\">"
					+ "<td class=\"p-4 font-medium text-white\">"
					+ "<div class=\"flex items-center gap-3\">"
					+ "<div class=\"w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500 to-fuchsia-500 flex items-center justify-center text-xs font-bold\">"
					+ buildInitials(user.username)
					+ "</div>"
					+ escapeHtmlClient(user.username)
					+ "</div>"
					+ "</td>"
					+ "<td class=\"p-4 text-slate-300\">"
					+ "<span class=\"px-2 py-1 rounded-md text-xs font-medium "
					+ roleClass
					+ "\">"
					+ escapeHtmlClient(roleLabel)
					+ "</span>"
					+ "</td>"
					+ "<td class=\"p-4 text-right text-slate-300 font-mono\">"
					+ formatNumber(user.heartbeat_count)
					+ "</td>"
					+ "<td class=\"p-4 text-right text-emerald-300 font-mono\">"
					+ formatNumber(user.characters_added)
					+ "</td>"
					+ "<td class=\"p-4 text-right text-rose-300 font-mono\">"
					+ formatNumber(user.characters_removed)
					+ "</td>"
					+ "<td class=\"p-4 text-right text-amber-300 font-mono\">"
					+ formatNumber(user.characters_modified)
					+ "</td>"
					+ "<td class=\"p-4 text-right text-white font-bold font-mono group-hover:text-indigo-300 transition-colors\">"
					+ formatNumber(user.total_activity)
					+ "</td>"
					+ "<td class=\"p-4 text-right text-indigo-200 font-mono\">"
					+ formatNumber(efficiency)
					+ "/hb</td>"
					+ "</tr>";
			}).join("");

			tbody.innerHTML = tableHtml;
		}

		function renderCharts(daily, users) {
			Chart.defaults.color = "rgba(255, 255, 255, 0.6)";
			Chart.defaults.font.family = "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif";

			const gridOptions = {
				color: "rgba(255, 255, 255, 0.05)",
				drawBorder: false,
			};

			const dailyCtx = document.getElementById("teamActivityChart").getContext("2d");
			const gradientLine = dailyCtx.createLinearGradient(0, 0, 0, 400);
			gradientLine.addColorStop(0, "rgba(45, 212, 191, 0.5)");
			gradientLine.addColorStop(1, "rgba(45, 212, 191, 0.0)");

			if (teamActivityChartInstance) {
				teamActivityChartInstance.destroy();
			}

			teamActivityChartInstance = new Chart(dailyCtx, {
				type: "line",
				data: {
					labels: daily.map((item) => {
						const date = new Date(item.day + "T00:00:00");
						return Number.isNaN(date.getTime()) ? item.day : (date.getMonth() + 1) + "/" + date.getDate();
					}),
					datasets: [{
						label: "Total Character Activity",
						data: daily.map((item) => Number(item.total_activity || 0)),
						borderColor: "#2dd4bf",
						backgroundColor: gradientLine,
						borderWidth: 2,
						pointBackgroundColor: "#0f766e",
						pointBorderColor: "#2dd4bf",
						pointBorderWidth: 2,
						pointRadius: 4,
						pointHoverRadius: 6,
						tension: 0.4,
						fill: true,
					}],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: {
						legend: { display: false },
						tooltip: {
							backgroundColor: "rgba(15, 23, 42, 0.9)",
							titleColor: "#fff",
							bodyColor: "#cbd5e1",
							borderColor: "rgba(255,255,255,0.1)",
							borderWidth: 1,
							padding: 10,
							displayColors: false,
							callbacks: {
								label(context) {
									return "Activity: " + formatNumber(context.raw);
								},
							},
						},
					},
					scales: {
						y: { grid: gridOptions, border: { display: false } },
						x: { grid: gridOptions, border: { display: false } },
					},
				},
			});

			const userCtx = document.getElementById("userContributionChart").getContext("2d");
			const bgColors = [
				"rgba(99, 102, 241, 0.7)",
				"rgba(168, 85, 247, 0.7)",
				"rgba(236, 72, 153, 0.7)",
				"rgba(14, 165, 233, 0.7)",
				"rgba(16, 185, 129, 0.7)",
			];
			const borderColors = ["#6366f1", "#a855f7", "#ec4899", "#0ea5e9", "#10b981"];

			if (userContributionChartInstance) {
				userContributionChartInstance.destroy();
			}

			userContributionChartInstance = new Chart(userCtx, {
				type: "bar",
				data: {
					labels: users.map((user) => user.username),
					datasets: [{
						label: "Total Activity",
						data: users.map((user) => Number(user.total_activity || 0)),
						backgroundColor: users.map((_, index) => bgColors[index % bgColors.length]),
						borderColor: users.map((_, index) => borderColors[index % borderColors.length]),
						borderWidth: 1,
						borderRadius: 6,
						barPercentage: 0.6,
					}],
				},
				options: {
					responsive: true,
					maintainAspectRatio: false,
					plugins: {
						legend: { display: false },
						tooltip: {
							backgroundColor: "rgba(15, 23, 42, 0.9)",
							titleColor: "#fff",
							bodyColor: "#cbd5e1",
							borderColor: "rgba(255,255,255,0.1)",
							borderWidth: 1,
							padding: 10,
							callbacks: {
								label(context) {
									return formatNumber(context.raw) + " chars";
								},
							},
						},
					},
					scales: {
						y: { grid: gridOptions, border: { display: false } },
						x: { grid: gridOptions, border: { display: false } },
					},
				},
			});
		}

		function initDashboard(dashboardData) {
			const leader = dashboardData.leader || {};
			const summary = dashboardData.summary || {};
			const users = Array.isArray(dashboardData.users) ? dashboardData.users : [];
			const daily = Array.isArray(dashboardData.daily) ? dashboardData.daily : [];

			document.getElementById("leader-name").textContent = leader.username || "Unknown Leader";
			document.getElementById("team-name").textContent = leader.team_name || "Unknown Team";
			document.getElementById("last-sync").textContent = formatDate(summary.last_heartbeat_at);

			document.getElementById("stat-members").textContent = formatNumber(users.length);
			document.getElementById("stat-heartbeats").textContent = formatNumber(summary.total_heartbeats);
			document.getElementById("stat-chars").textContent = formatNumber(summary.total_character_changes);
			document.getElementById("stat-services").textContent = formatNumber(summary.services_used);

			if (daily.length > 0) {
				const peakDay = daily.reduce((max, current) => {
					return Number(current.total_activity || 0) > Number(max.total_activity || 0)
						? current
						: max;
				}, daily[0]);

				document.getElementById("stat-peak").textContent = formatNumber(peakDay.total_activity);

				const peakDateObj = new Date(peakDay.day + "T00:00:00");
				if (!Number.isNaN(peakDateObj.getTime())) {
					document.getElementById("stat-peak-date").textContent = "on " + new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(peakDateObj);
				}
			}

			renderUserTable(users);
			renderCharts(daily, users);
		}

		async function loadDashboardData(options = {}) {
			if (isDashboardLoading) {
				return;
			}

			isDashboardLoading = true;
			const suppressErrorBanner = Boolean(options.suppressErrorBanner);

			try {
				const response = await fetch("/api/team-info", {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(leaderCredentials),
				});

				if (!response.ok) {
					throw new Error("Failed to fetch team information");
				}

				const data = await response.json();
				initDashboard(data);
				clearDashboardError();
			} catch (error) {
				console.error("Dashboard fetch failed", error);
				if (!suppressErrorBanner) {
					showDashboardError("Unable to load team information right now. Please refresh and try again.");
				}
			} finally {
				isDashboardLoading = false;
			}
		}

		document.addEventListener("DOMContentLoaded", () => {
			loadDashboardData();
			window.setInterval(() => {
				loadDashboardData({ suppressErrorBanner: true });
			}, DASHBOARD_REFRESH_INTERVAL_MS);
		});
	</script>
</body>
</html>`;
}

async function initializeDatabase() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS teams (
			id SERIAL PRIMARY KEY,
			name TEXT UNIQUE NOT NULL,
			leader_user_id INTEGER,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE TABLE IF NOT EXISTS users (
			id SERIAL PRIMARY KEY,
			team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			username TEXT NOT NULL,
			token TEXT UNIQUE NOT NULL,
			role TEXT NOT NULL CHECK (role IN ('leader', 'member')),
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			UNIQUE (team_id, username)
		);

		CREATE TABLE IF NOT EXISTS heartbeats (
			id BIGSERIAL PRIMARY KEY,
			user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
			team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
			service TEXT NOT NULL,
			document_name TEXT,
			characters_added INTEGER NOT NULL DEFAULT 0,
			characters_removed INTEGER NOT NULL DEFAULT 0,
			characters_modified INTEGER NOT NULL DEFAULT 0,
			received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);

		CREATE INDEX IF NOT EXISTS idx_users_team_id ON users(team_id);
		CREATE INDEX IF NOT EXISTS idx_heartbeats_team_id ON heartbeats(team_id);
		CREATE INDEX IF NOT EXISTS idx_heartbeats_user_id ON heartbeats(user_id);
		CREATE INDEX IF NOT EXISTS idx_heartbeats_received_at ON heartbeats(received_at);
	`);

	await pool.query(`
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS leader_user_id INTEGER;
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
		ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
		ALTER TABLE heartbeats ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
	`);

	await pool.query(`
		DO $$
		BEGIN
			IF NOT EXISTS (
				SELECT 1
				FROM information_schema.table_constraints
				WHERE table_name = 'teams'
				AND constraint_name = 'teams_leader_user_fkey'
			) THEN
				ALTER TABLE teams
				ADD CONSTRAINT teams_leader_user_fkey
				FOREIGN KEY (leader_user_id) REFERENCES users(id) ON DELETE SET NULL;
			END IF;
		END $$;
	`);
}

app.get("/", (req, res) => {
	res.send(
		renderPage(
			"Seam Server",
			`<div class="panel">
        <h1>Seam Server</h1>
        <p class="muted">v0.1.0 - team setup, tokens, heartbeat tracking, and dashboard.</p>
        <p><a href="/teams/new">Create Team</a></p>
        <p><a href="/dashboard/login">Team Leader Login</a></p>
      </div>`,
		),
	);
});

app.get("/teams/new", (req, res) => {
	res.send(
		renderPage(
			"Create Team",
			`<div class="panel">
        <h1>Create Team</h1>
        <p class="muted">Create a team, leader account, and member accounts with tokens in one step.</p>
        <form method="post" action="/teams/new">
          <label>Team name
            <input name="team_name" required maxlength="120" />
          </label>
          <label>Leader username
            <input name="leader_username" required maxlength="120" />
          </label>
          <label>Member usernames (comma or newline separated)
            <textarea name="member_usernames" rows="7" placeholder="alex\npriya\nnoah"></textarea>
          </label>
          <button type="submit">Create Team + Users</button>
        </form>
        <p><a href="/">Back home</a></p>
      </div>`,
		),
	);
});

app.post("/teams/new", async (req, res) => {
	const teamName = String(req.body.team_name || "").trim();
	const leaderUsername = String(req.body.leader_username || "").trim();
	const memberUsernamesText = String(req.body.member_usernames || "");

	if (!teamName || !leaderUsername) {
		res.status(400).send(renderError("Create Team Failed", "Team name and leader username are required."));
		return;
	}

	const memberUsernames = parseMemberUsernames(memberUsernamesText, leaderUsername);
	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		const teamResult = await client.query(
			"INSERT INTO teams(name) VALUES($1) RETURNING id, name",
			[teamName],
		);
		const team = teamResult.rows[0];

		const leaderToken = generateToken();
		const leaderResult = await client.query(
			"INSERT INTO users(team_id, username, token, role) VALUES($1, $2, $3, 'leader') RETURNING id, username, token, role",
			[team.id, leaderUsername, leaderToken],
		);

		await client.query("UPDATE teams SET leader_user_id = $1 WHERE id = $2", [
			leaderResult.rows[0].id,
			team.id,
		]);

		const createdMembers = [];
		for (const memberUsername of memberUsernames) {
			const memberToken = generateToken();
			const memberResult = await client.query(
				"INSERT INTO users(team_id, username, token, role) VALUES($1, $2, $3, 'member') RETURNING username, token, role",
				[team.id, memberUsername, memberToken],
			);
			createdMembers.push(memberResult.rows[0]);
		}

		await client.query("COMMIT");

		const allUsers = [leaderResult.rows[0], ...createdMembers]
			.map(
				(user) => `<tr>
            <td>${escapeHtml(user.username)}</td>
            <td>${escapeHtml(user.role)}</td>
            <td><code>${escapeHtml(user.token)}</code></td>
          </tr>`,
			)
			.join("");

		res.send(
			renderPage(
				"Team Created",
				`<div class="panel">
            <h1 class="ok">Team Created Successfully</h1>
            <p>Team: <strong>${escapeHtml(team.name)}</strong></p>
            <p class="muted">Share each member's token with that user. The leader token is used to log into the dashboard.</p>
            <table>
              <thead>
                <tr>
                  <th>Username</th>
                  <th>Role</th>
                  <th>Assigned Token</th>
                </tr>
              </thead>
              <tbody>${allUsers}</tbody>
            </table>
            <p><a href="/dashboard/login">Go to leader login</a></p>
            <p><a href="/teams/new">Create another team</a></p>
          </div>`,
			),
		);
	} catch (error) {
		await client.query("ROLLBACK");

		if (error.code === "23505") {
			res
				.status(409)
				.send(
					renderError(
						"Create Team Failed",
						"That team name or username already exists. Please choose unique names.",
					),
				);
			return;
		}

		console.error("Failed to create team and users", error);
		res.status(500).send(renderError("Create Team Failed", "Unexpected error while creating the team."));
	} finally {
		client.release();
	}
});

app.get("/dashboard/login", (req, res) => {
	res.send(
		renderPage(
			"Leader Login",
			`<div class="panel">
        <h1>Team Leader Login</h1>
        <p class="muted">Use the leader username and token generated during team setup.</p>
        <form method="post" action="/dashboard/login">
          <label>Username
            <input name="username" required maxlength="120" />
          </label>
          <label>Token
            <input name="token" required maxlength="256" />
          </label>
          <button type="submit">Login</button>
        </form>
        <p><a href="/">Back home</a></p>
      </div>`,
		),
	);
});

app.post("/dashboard/login", async (req, res) => {
	try {
		const username = String(req.body.username || "").trim();
		const token = String(req.body.token || "").trim();

		if (!username || !token) {
			res.status(400).send(renderError("Login Failed", "Username and token are required."));
			return;
		}

		const result = await pool.query(
			`SELECT id
			 FROM users
			 WHERE username = $1 AND token = $2 AND role = 'leader'`,
			[username, token],
		);

		if (result.rowCount === 0) {
			res.status(401).send(renderError("Login Failed", "Invalid leader credentials."));
			return;
		}

		const sessionId = createSession(result.rows[0].id);
		res.setHeader(
			"Set-Cookie",
			`${SESSION_COOKIE_NAME}=${sessionId}; HttpOnly; Path=/; Max-Age=${Math.floor(
				SESSION_TTL_MS / 1000,
			)}; SameSite=Lax`,
		);
		res.redirect("/dashboard");
	} catch (error) {
		console.error("Dashboard login failed", error);
		res.status(500).send(renderError("Login Failed", "Unexpected error during login."));
	}
});

app.get("/dashboard/logout", (req, res) => {
	const cookies = parseCookies(req.headers.cookie);
	const sessionId = cookies[SESSION_COOKIE_NAME];
	if (sessionId) {
		sessions.delete(sessionId);
	}

	res.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`);
	res.redirect("/dashboard/login");
});

app.post("/api/team-info", async (req, res) => {
	try {
		const username = String(req.body.username || "").trim();
		const secret = String(req.body.secret || "").trim();

		if (!username || !secret) {
			res.status(400).json({ error: "username and secret are required" });
			return;
		}

		const leaderResult = await pool.query(
			`SELECT u.id, u.username, u.team_id, t.name AS team_name
			 FROM users u
			 JOIN teams t ON t.id = u.team_id
			 WHERE u.username = $1 AND u.token = $2 AND u.role = 'leader'`,
			[username, secret],
		);

		if (leaderResult.rowCount === 0) {
			res.status(401).json({ error: "Invalid leader credentials" });
			return;
		}

		const leader = leaderResult.rows[0];
		const dashboardData = await getTeamDashboardData(leader.team_id);

		res.json({
			leader: {
				username: leader.username,
				team_name: leader.team_name,
			},
			summary: dashboardData.summary,
			users: dashboardData.users,
			daily: dashboardData.daily,
		});
	} catch (error) {
		console.error("Failed to fetch team information", error);
		res.status(500).json({ error: "Unable to fetch team information" });
	}
});

app.get("/dashboard", async (req, res) => {
	try {
		const leader = await getAuthenticatedLeader(req);
		if (!leader) {
			res.redirect("/dashboard/login");
			return;
		}

		res.send(renderDashboardPage(leader.username, leader.token));
	} catch (error) {
		console.error("Failed to render dashboard", error);
		res.status(500).send(renderError("Dashboard Error", "Unable to load team dashboard right now."));
	}
});

io.on("connection", (socket) => {
	console.log(`Client connected: ${socket.id}`);

	socket.emit("message", "Connected to server");

	socket.on("message", (payload) => {
		console.log(`Message from ${socket.id}:`, payload);
		io.emit("message", payload);
	});

	socket.on("heartbeat", async (payload = {}) => {
		const username = String(payload.username ?? payload.clientUsername ?? "").trim();
		const team = String(payload.team ?? payload.clientTeam ?? "").trim();
		const token = String(payload.token ?? payload.clientToken ?? "").trim();
		const charactersAdded = toInteger(payload.charactersAdded ?? payload.clientCharactersAdded);
		const charactersRemoved = toInteger(payload.charactersRemoved ?? payload.clientCharactersRemoved);
		const charactersModified = toInteger(payload.charactersModified ?? payload.clientCharactersModified);
		const service = String(payload.service ?? "").trim();
		const documentName = String(payload.document_name ?? payload.documentName ?? "").trim();

		if (!username || !team || !token || !service) {
			console.warn(`Invalid heartbeat from ${socket.id}: missing username, team, token, or service`);
			return;
		}

		if (service === "google_docs" && !documentName) {
			console.warn(
				`Invalid heartbeat from ${socket.id}: service is google_docs but document_name is missing`,
			);
			return;
		}

		try {
			const authResult = await pool.query(
				`SELECT u.id AS user_id, u.team_id
				 FROM users u
				 JOIN teams t ON t.id = u.team_id
				 WHERE u.username = $1
				   AND u.token = $2
				   AND t.name = $3`,
				[username, token, team],
			);

			if (authResult.rowCount === 0) {
				console.warn(`Rejected heartbeat from ${socket.id}: invalid username/token/team combination`);
				return;
			}

			const authRow = authResult.rows[0];

			await pool.query(
				`INSERT INTO heartbeats(
					user_id,
					team_id,
					service,
					document_name,
					characters_added,
					characters_removed,
					characters_modified
				 ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
				[
					authRow.user_id,
					authRow.team_id,
					service,
					documentName || null,
					charactersAdded,
					charactersRemoved,
					charactersModified,
				],
			);

			const noCharacterChanges =
				charactersAdded === 0 &&
				charactersRemoved === 0 &&
				charactersModified === 0;

			if (noCharacterChanges) {
				console.log(`heartbeat recieved from ${username}`);
				return;
			}

			console.log("Heartbeat received:", {
				socketId: socket.id,
				username,
				team,
				charactersAdded,
				charactersRemoved,
				charactersModified,
				service,
				document_name: documentName || null,
			});
		} catch (error) {
			console.error(`Failed to process heartbeat from ${socket.id}`, error);
		}
	});

	socket.on("disconnect", () => {
		console.log(`Client disconnected: ${socket.id}`);
	});
});

const PORT = process.env.PORT || 5173;

async function startServer() {
	await initializeDatabase();
	server.listen(PORT, () => {
		console.log(`Server listening on http://localhost:${PORT}`);
	});
}

startServer().catch((error) => {
	console.error("Server startup failed", error);
	process.exit(1);
});

