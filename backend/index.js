const crypto = require("crypto");
const express = require("express");
const fs = require("fs/promises");
const http = require("http");
const path = require("path");
const { Pool } = require("pg");
const { Server } = require("socket.io");
const dotenv = require("dotenv");
const OpenAI = require("openai");

dotenv.config({ path: path.join(__dirname, ".env") });

const DASHBOARD_TEMPLATE_PATH = path.join(__dirname, "dashboard.html");
const LOGIN_TEMPLATE_PATH = path.join(__dirname, "dashboard-login.html");
const HOME_TEMPLATE_PATH = path.join(__dirname, "home.html");
const TEAM_NEW_TEMPLATE_PATH = path.join(__dirname, "team-new.html");
const TEAM_SUCCESS_TEMPLATE_PATH = path.join(__dirname, "team-success.html");
const ERROR_TEMPLATE_PATH = path.join(__dirname, "error.html");

let dashboardTemplateCache = null;
let loginTemplateCache = null;
let homeTemplateCache = null;
let teamNewTemplateCache = null;
let teamSuccessTemplateCache = null;
let errorTemplateCache = null;

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
	cors: {
		origin: "*",
	},
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use("/static", express.static(path.join(__dirname, "public")));

const SESSION_COOKIE_NAME = "taptic_dashboard_session";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
const socketPresenceById = new Map();
const userSocketsByKey = new Map();
const pendingTabRequests = new Map();

// Keystroke tracking structures
const keystrokesByUser = new Map(); // Map of "team::username" => { buffer: string, lastUpdate: timestamp }
const aiEvaluationsByUser = new Map(); // Map of "team::username" => { evaluation: string, lastEvaluated: timestamp }
const keystrokeMonitoringActive = new Map(); // Map of "team::username" => boolean (is being monitored by leader)

// OpenAI client for task evaluation
const openaiClient = new OpenAI({
	baseURL: 'https://api.featherless.ai/v1',
	apiKey: process.env.FEATHERLESS_API_KEY || 'FEATHERLESS_API_KEY'
});

function buildUserPresenceKey(teamName, username) {
	return `${String(teamName || "").trim().toLowerCase()}::${String(username || "").trim().toLowerCase()}`;
}

function setSocketPresence(socketId, teamName, username, token, teamId = null, lastSeenAt = Date.now()) {
	const normalizedTeamName = String(teamName || "").trim();
	const normalizedUsername = String(username || "").trim();

	if (!normalizedTeamName || !normalizedUsername) {
		return;
	}

	const key = buildUserPresenceKey(normalizedTeamName, normalizedUsername);
	const existing = socketPresenceById.get(socketId);

	if (existing && existing.key !== key) {
		const oldSet = userSocketsByKey.get(existing.key);
		if (oldSet) {
			oldSet.delete(socketId);
			if (oldSet.size === 0) {
				userSocketsByKey.delete(existing.key);
			}
		}
	}

	let socketIds = userSocketsByKey.get(key);
	if (!socketIds) {
		socketIds = new Set();
		userSocketsByKey.set(key, socketIds);
	}

	socketIds.add(socketId);
	socketPresenceById.set(socketId, {
		key,
		teamName: normalizedTeamName,
		teamId: teamId === null ? null : Number(teamId),
		username: normalizedUsername,
		token: String(token || "").trim(),
		lastSeenAt,
	});

	return socketPresenceById.get(socketId);
}

function removeSocketPresence(socketId) {
	const existing = socketPresenceById.get(socketId);
	if (!existing) {
		return null;
	}

	const socketIds = userSocketsByKey.get(existing.key);
	if (socketIds) {
		socketIds.delete(socketId);
		if (socketIds.size === 0) {
			userSocketsByKey.delete(existing.key);
		}
	}

	socketPresenceById.delete(socketId);
	return existing;
}

function getOnlineSocketIdsForUser(teamName, username) {
	const key = buildUserPresenceKey(teamName, username);
	const socketIds = userSocketsByKey.get(key);
	if (!socketIds) {
		return [];
	}

	const online = [];

	for (const socketId of socketIds) {
		const metadata = socketPresenceById.get(socketId);
		if (!metadata) {
			socketIds.delete(socketId);
			continue;
		}

		if (!io.sockets.sockets.has(socketId)) {
			socketIds.delete(socketId);
			socketPresenceById.delete(socketId);
			continue;
		}

		online.push(socketId);
	}

	if (socketIds.size === 0) {
		userSocketsByKey.delete(key);
	}

	return online;
}

function getOnlineUsernamesForTeam(teamName) {
	const normalizedTeamName = String(teamName || "").trim().toLowerCase();
	if (!normalizedTeamName) {
		return [];
	}

	const usernames = new Set();

	for (const [socketId, metadata] of socketPresenceById.entries()) {
		if (!metadata || metadata.teamName.toLowerCase() !== normalizedTeamName) {
			continue;
		}

		if (!io.sockets.sockets.has(socketId)) {
			removeSocketPresence(socketId);
			continue;
		}

		usernames.add(metadata.username);
	}

	return Array.from(usernames);
}

function emitPresenceUpdated(metadata, online) {
	if (!metadata) {
		return;
	}

	io.emit("presence_updated", {
		online: Boolean(online),
		team_id: metadata.teamId,
		team_name: metadata.teamName,
		username: metadata.username,
		timestamp: Date.now(),
	});
}

function extractSocketCredentials(payload = {}) {
	const username = String(payload.username ?? payload.clientUsername ?? "").trim();
	const team = String(payload.team ?? payload.clientTeam ?? "").trim();
	const token = String(payload.token ?? payload.clientToken ?? "").trim();

	if (!username || !team || !token) {
		return null;
	}

	return { username, team, token };
}

async function authenticateSocketIdentity(username, team, token) {
	const authResult = await pool.query(
		`SELECT u.id AS user_id, u.username, u.token, u.team_id, t.name AS team_name
		 FROM users u
		 JOIN teams t ON t.id = u.team_id
		 WHERE u.username = $1
		   AND u.token = $2
		   AND t.name = $3`,
		[username, token, team],
	);

	if (authResult.rowCount === 0) {
		return null;
	}

	return authResult.rows[0];
}

async function registerSocketPresenceFromCredentials(socket, rawCredentials) {
	const credentials = extractSocketCredentials(rawCredentials || {});
	if (!credentials) {
		return null;
	}

	const existing = socketPresenceById.get(socket.id);
	const nextKey = buildUserPresenceKey(credentials.team, credentials.username);
	if (existing && existing.key === nextKey && existing.token === credentials.token) {
		existing.lastSeenAt = Date.now();
		return existing;
	}

	const authRow = await authenticateSocketIdentity(credentials.username, credentials.team, credentials.token);
	if (!authRow) {
		return null;
	}

	const metadata = setSocketPresence(
		socket.id,
		authRow.team_name,
		authRow.username,
		authRow.token,
		authRow.team_id,
		Date.now(),
	);

	emitPresenceUpdated(metadata, true);
	return metadata;
}

async function evaluateTaskWithAI(recentText, projectDescription, username) {
	try {
		const response = await openaiClient.chat.completions.create({
			model: 'Qwen/Qwen2.5-7B-Instruct',
			messages: [
				{ 
					role: 'system', 
					content: `You are evaluating if a team member is staying on task. The project description describes what they should be working on. Recent text is what they have been typing. Evaluate if they are staying on task. Keep your response under 150 characters. Do not use markdown or any formatting other than unicode characters. Be direct and concise.` 
				},
				{ 
					role: 'user', 
					content: `Project Description: ${projectDescription}\n\nRecent Activity from ${username}: ${recentText}\n\nAre they staying on task? Provide a brief evaluation.` 
				}
			],
			max_tokens: 100,
			temperature: 0.7,
		});

		return response.choices[0].message.content || "Unable to evaluate.";
	} catch (error) {
		console.error("AI evaluation error:", error);
		return "AI evaluation error.";
	}
}

function getUserKey(team, username) {
	return `${String(team || "").trim().toLowerCase()}::${String(username || "").trim().toLowerCase()}`;
}

function startKeystrokeMonitoring(team, username) {
	const key = getUserKey(team, username);
	keystrokeMonitoringActive.set(key, true);
	
	if (!keystrokesByUser.has(key)) {
		keystrokesByUser.set(key, {
			buffer: "",
			lastUpdate: Date.now()
		});
	}
	
	console.log(`Started keystroke monitoring for ${username} in team ${team}`);
}

function stopKeystrokeMonitoring(team, username) {
	const key = getUserKey(team, username);
	keystrokeMonitoringActive.delete(key);
	keystrokesByUser.delete(key);
	aiEvaluationsByUser.delete(key);
	
	console.log(`Stopped keystroke monitoring for ${username} in team ${team}`);
}


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
	max: 20,
	min: 2,
	idleTimeoutMillis: 30000,
	connectionTimeoutMillis: 5000,
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

async function getHomeTemplate() {
	if (homeTemplateCache === null) {
		homeTemplateCache = await fs.readFile(HOME_TEMPLATE_PATH, "utf-8");
	}

	return homeTemplateCache;
}

async function getTeamNewTemplate() {
	if (teamNewTemplateCache === null) {
		teamNewTemplateCache = await fs.readFile(TEAM_NEW_TEMPLATE_PATH, "utf-8");
	}

	return teamNewTemplateCache;
}

async function getTeamSuccessTemplate() {
	if (teamSuccessTemplateCache === null) {
		teamSuccessTemplateCache = await fs.readFile(TEAM_SUCCESS_TEMPLATE_PATH, "utf-8");
	}

	return teamSuccessTemplateCache;
}

async function getErrorTemplate() {
	if (errorTemplateCache === null) {
		errorTemplateCache = await fs.readFile(ERROR_TEMPLATE_PATH, "utf-8");
	}

	return errorTemplateCache;
}

async function renderErrorPage(title, message) {
	const template = await getErrorTemplate();
	return template
		.replace("__ERROR_TITLE__", escapeHtml(title))
		.replace("__ERROR_MESSAGE__", escapeHtml(message));
}

const EXTENSION_ID = process.env.EXTENSION_ID || "klniilncinffnpjkdnocpnbhkhacpkof";

async function renderTeamSuccessPage(teamName, users, serverUrl = "") {
	const template = await getTeamSuccessTemplate();

	const userRows = users
		.map(
			(user) => {
				const installUrl = `${serverUrl || "https://taptic.live"}/install?username=${encodeURIComponent(user.username)}&team=${encodeURIComponent(teamName)}&token=${encodeURIComponent(user.token)}&serverUrl=${encodeURIComponent(serverUrl)}`;
				const safeInstallUrl = escapeHtml(installUrl);
				const safeToken = escapeHtml(user.token);
				const isLeader = String(user.role || "").toLowerCase() === "leader";

				const valueMarkup = isLeader
					? `<code class="text-xs flex-1 min-w-[220px] break-all" style="color: var(--color-accent);">${safeToken}</code>`
					: `<a href="${safeInstallUrl}" class="text-xs flex-1 min-w-[220px] break-all underline-offset-2 hover:underline" style="color: var(--color-accent);" target="_blank" rel="noopener noreferrer">${safeInstallUrl}</a>`;

				const copyButtonLabel = isLeader ? "Copy Token" : "Copy Link";
				const copyValue = isLeader ? safeToken : safeInstallUrl;
				return `
				<tr class="border-b border-black/5 table-row-hover" style="color: var(--color-text-main);">
              <td class="px-4 py-3">${escapeHtml(user.username)}</td>
              <td class="px-4 py-3">
                <span class="role-pill ${
					user.role === "leader" ? "role-pill-leader" : ""
				} px-2 py-1 text-xs font-medium">
                  ${escapeHtml(user.role)}
                </span>
              </td>
              <td class="px-4 py-3">
                <div class="space-y-2">
                  <div class="flex items-center gap-2 flex-wrap">
	                    ${valueMarkup}
	                    <button type="button" class="copy-value-btn px-2 py-1 rounded text-xs font-medium transition-colors whitespace-nowrap" data-value="${copyValue}" style="background: var(--color-accent-glow); color: var(--color-accent); border: 1px solid var(--color-accent); cursor: pointer;">${copyButtonLabel}</button>
                  </div>
                </div>
              </td>
            </tr>`;
			}
		)
		.join("");

	return template.replace("__TEAM_NAME__", escapeHtml(teamName)).replace("__USER_ROWS__", userRows);
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
			COUNT(*)::INT AS total_pings,
			COALESCE(SUM(characters_added + characters_removed + characters_modified), 0)::INT AS total_character_changes,
			COUNT(DISTINCT service)::INT AS services_used,
			MAX(received_at) AS last_ping_at
		 FROM pings
		 WHERE team_id = $1`,
		[teamId],
	);

	const usersResult = await pool.query(
		`SELECT
			u.username,
			u.role,
			COUNT(h.id)::INT AS ping_count,
			MIN(h.received_at) AS first_ping_at,
			MAX(h.received_at) AS last_ping_at,
			COALESCE(EXTRACT(EPOCH FROM (MAX(h.received_at) - MIN(h.received_at))) / 60, 0)::FLOAT AS tracked_minutes,
			COALESCE(SUM(h.characters_added), 0)::INT AS characters_added,
			COALESCE(SUM(h.characters_removed), 0)::INT AS characters_removed,
			COALESCE(SUM(h.characters_modified), 0)::INT AS characters_modified,
			COALESCE(SUM(h.characters_added + h.characters_removed + h.characters_modified), 0)::INT AS total_activity
		 FROM users u
		 LEFT JOIN pings h ON h.user_id = u.id
		 WHERE u.team_id = $1
		 GROUP BY u.id
		 ORDER BY total_activity DESC, u.username ASC`,
		[teamId],
	);

	const dailyResult = await pool.query(
		`SELECT
			TO_CHAR(day::date, 'YYYY-MM-DD') AS day,
			COALESCE(SUM(h.characters_added + h.characters_removed + h.characters_modified), 0)::INT AS total_activity,
			COALESCE(COUNT(h.id), 0)::INT AS ping_count
		 FROM generate_series(CURRENT_DATE - INTERVAL '13 days', CURRENT_DATE, INTERVAL '1 day') AS day
		 LEFT JOIN pings h
			ON DATE(h.received_at) = DATE(day)
			AND h.team_id = $1
		 GROUP BY day
		 ORDER BY day ASC`,
		[teamId],
	);

	const hourlyResult = await pool.query(
		`SELECT
			hour_bucket AS hour,
			COALESCE(SUM(h.characters_added + h.characters_removed + h.characters_modified), 0)::INT AS total_activity,
			COALESCE(COUNT(h.id), 0)::INT AS ping_count
		 FROM generate_series(
			date_trunc('hour', NOW()) - INTERVAL '11 hours',
			date_trunc('hour', NOW()),
			INTERVAL '1 hour'
		 ) AS hour_bucket
		 LEFT JOIN pings h
			on date_trunc('hour', h.received_at) = hour_bucket
			AND h.team_id = $1
		 GROUP BY hour_bucket
		 ORDER BY hour_bucket ASC`,
		[teamId],
	);

	return {
		summary: summaryResult.rows[0],
		users: usersResult.rows,
		daily: dailyResult.rows,
		hourly: hourlyResult.rows,
	};
}

async function getDashboardTemplate() {
	if (dashboardTemplateCache === null) {
		dashboardTemplateCache = await fs.readFile(DASHBOARD_TEMPLATE_PATH, "utf8");
	}

	return dashboardTemplateCache;
}

async function getLoginTemplate() {
	if (loginTemplateCache === null) {
		loginTemplateCache = await fs.readFile(LOGIN_TEMPLATE_PATH, "utf8");
	}

	return loginTemplateCache;
}

async function renderLoginPage(errorMessage = "") {
	const template = await getLoginTemplate();
	const errorBlock = errorMessage
		? `<div class="alert-danger rounded-lg px-4 py-3 text-sm mb-4">${escapeHtml(errorMessage)}</div>`
		: "";

	return template.replace("__LOGIN_ERROR_BLOCK__", errorBlock);
}

async function renderDashboardPage(leaderUsername, leaderSecret) {
	const leaderCredentials = serializeForInlineScript({
		username: leaderUsername,
		secret: leaderSecret,
	});

	const template = await getDashboardTemplate();
	return template.replace("__LEADER_CREDENTIALS__", leaderCredentials);
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

		CREATE TABLE IF NOT EXISTS pings (
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
		CREATE INDEX IF NOT EXISTS idx_pings_team_id ON pings(team_id);
		CREATE INDEX IF NOT EXISTS idx_pings_user_id ON pings(user_id);
		CREATE INDEX IF NOT EXISTS idx_pings_received_at ON pings(received_at);
	`);

	await pool.query(`
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS leader_user_id INTEGER;
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS project_description TEXT;
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS ai_features_enabled BOOLEAN NOT NULL DEFAULT TRUE;
		ALTER TABLE teams ADD COLUMN IF NOT EXISTS keystroke_recording_enabled BOOLEAN NOT NULL DEFAULT TRUE;
		ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
		ALTER TABLE pings ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
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

app.get("/", async (req, res) => {
	try {
		const html = await getHomeTemplate();
		res.send(html);
	} catch (error) {
		console.error("Failed to load home page", error);
		res.status(500).send(await renderErrorPage("Server Error", "Unable to load the home page right now."));
	}
});

app.get("/install", (req, res) => {
	const { username, team, token, serverUrl } = req.query;
	if (username && team && token) {
		const autoSetupUrl =
			`chrome-extension://${EXTENSION_ID}/options.html?username=` +
			encodeURIComponent(username) +
			`&team=` +
			encodeURIComponent(team) +
			`&token=` +
			encodeURIComponent(token) +
			`&serverUrl=` +
			encodeURIComponent(serverUrl || `${req.protocol}://${req.get("host")}`);
		res.redirect(autoSetupUrl);
		return;
	}

	res.redirect("https://chromewebstore.google.com/detail/" + EXTENSION_ID);
});

app.get("/teams/new", async (req, res) => {
	try {
		const html = await getTeamNewTemplate();
		res.send(html);
	} catch (error) {
		console.error("Failed to load team creation page", error);
		res.status(500).send(
			await renderErrorPage("Server Error", "Unable to load the team creation page right now."),
		);
	}
});

app.post("/teams/new", async (req, res) => {
	const teamName = String(req.body.team_name || "").trim();
	const leaderUsername = String(req.body.leader_username || "").trim();
	const memberUsernamesText = String(req.body.member_usernames || "");
	const projectDescription = String(req.body.project_description || "").trim();
	const aiFeaturesEnabled = req.body.ai_features_enabled !== "false"; // Checkbox value
	const keystrokeRecordingEnabled = aiFeaturesEnabled; // Same as AI features

	if (!teamName || !leaderUsername) {
		res
			.status(400)
			.send(
				await renderErrorPage("Create Team Failed", "Team name and leader username are required."),
			);
		return;
	}

	// Input validation
	if (teamName.length > 100) {
		res
			.status(400)
			.send(await renderErrorPage("Create Team Failed", "Team name must be 100 characters or less."));
		return;
	}

	if (leaderUsername.length > 100) {
		res
			.status(400)
			.send(
				await renderErrorPage("Create Team Failed", "Leader username must be 100 characters or less."),
			);
		return;
	}

	if (!/^[a-zA-Z0-9_-]+$/.test(teamName)) {
		res
			.status(400)
			.send(
				await renderErrorPage(
					"Create Team Failed",
					"Team name can only contain letters, numbers, hyphens, and underscores.",
				),
			);
		return;
	}

	if (!/^[a-zA-Z0-9_-]+$/.test(leaderUsername)) {
		res
			.status(400)
			.send(
				await renderErrorPage(
					"Create Team Failed",
					"Usernames can only contain letters, numbers, hyphens, and underscores.",
				),
			);
		return;
	}

	const memberUsernames = parseMemberUsernames(memberUsernamesText, leaderUsername);

	// Validate all member usernames
	for (const memberUsername of memberUsernames) {
		if (memberUsername.length > 100) {
			res
				.status(400)
				.send(
					await renderErrorPage(
						"Create Team Failed",
						`Username "${memberUsername}" is too long. Must be 100 characters or less.`,
					),
				);
			return;
		}

		if (!/^[a-zA-Z0-9_-]+$/.test(memberUsername)) {
			res
				.status(400)
				.send(
					await renderErrorPage(
						"Create Team Failed",
						`Username "${memberUsername}" contains invalid characters. Only letters, numbers, hyphens, and underscores allowed.`,
					),
				);
			return;
		}
	}

	if (memberUsernames.length > 50) {
		res
			.status(400)
			.send(
				await renderErrorPage(
					"Create Team Failed",
					"Too many team members. Maximum is 50 members per team.",
				),
			);
		return;
	}

	const client = await pool.connect();

	try {
		await client.query("BEGIN");

		const teamResult = await client.query(
			"INSERT INTO teams(name, project_description, ai_features_enabled, keystroke_recording_enabled) VALUES($1, $2, $3, $4) RETURNING id, name",
			[teamName, projectDescription || null, aiFeaturesEnabled, keystrokeRecordingEnabled],
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

		const allUsers = [leaderResult.rows[0], ...createdMembers];
		const serverUrl = process.env.PUBLIC_SERVER_URL || `${req.protocol}://${req.get("host")}`;

		res.send(await renderTeamSuccessPage(team.name, allUsers, serverUrl));
	} catch (error) {
		await client.query("ROLLBACK");

		if (error.code === "23505") {
			res
				.status(409)
				.send(
					await renderErrorPage(
						"Create Team Failed",
						"That team name or username already exists. Please choose unique names.",
					),
				);
			return;
		}

		console.error("Failed to create team and users", error);
		res.status(500).send(
			await renderErrorPage("Create Team Failed", "Unexpected error while creating the team."),
		);
	} finally {
		try {
			client.release();
		} catch (releaseError) {
			console.error("Failed to release database client", releaseError);
		}
	}
});

app.get("/dashboard/login", async (req, res) => {
	try {
		res.send(await renderLoginPage());
	} catch (error) {
		console.error("Failed to render login page", error);
		res.status(500).send(
			await renderErrorPage("Login Page Error", "Unable to load the login page right now."),
		);
	}
});

app.post("/dashboard/login", async (req, res) => {
	try {
		const username = String(req.body.username || "").trim();
		const token = String(req.body.token || "").trim();

		if (!username || !token) {
			res.status(400).send(await renderLoginPage("Username and token are required."));
			return;
		}

		const result = await pool.query(
			`SELECT id
			 FROM users
			 WHERE username = $1 AND token = $2 AND role = 'leader'`,
			[username, token],
		);

		if (result.rowCount === 0) {
			res.status(401).send(await renderLoginPage("Invalid leader credentials."));
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
		res.status(500).send(await renderLoginPage("Unexpected error during login."));
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
			`SELECT u.id, u.username, u.team_id, t.name AS team_name, t.ai_features_enabled, 
			        t.keystroke_recording_enabled, t.project_description
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
		const onlineUsernames = getOnlineUsernamesForTeam(leader.team_name);

		res.json({
			leader: {
				username: leader.username,
				team_id: leader.team_id,
				team_name: leader.team_name,
			},
			team_settings: {
				ai_features_enabled: Boolean(leader.ai_features_enabled),
				keystroke_recording_enabled: Boolean(leader.keystroke_recording_enabled),
				has_project_description: Boolean(leader.project_description),
			},
			summary: dashboardData.summary,
			users: dashboardData.users,
			daily: dashboardData.daily,
			online_usernames: onlineUsernames,
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

		res.send(await renderDashboardPage(leader.username, leader.token));
	} catch (error) {
		console.error("Failed to render dashboard", error);
		res.status(500).send(
			await renderErrorPage("Dashboard Error", "Unable to load team dashboard right now."),
		);
	}
});

io.on("connection", (socket) => {
	console.log(`Client connected: ${socket.id}`);

	socket.emit("message", "Connected to server");

	registerSocketPresenceFromCredentials(socket, socket.handshake.auth).catch((error) => {
		console.error(`Failed handshake auth registration for ${socket.id}`, error);
	});

	registerSocketPresenceFromCredentials(socket, socket.handshake.query).catch((error) => {
		console.error(`Failed handshake query registration for ${socket.id}`, error);
	});

	socket.on("register_presence", async (payload = {}) => {
		try {
			const metadata = await registerSocketPresenceFromCredentials(socket, payload);
			if (!metadata) {
				socket.emit("presence_status", {
					status: "error",
					error: "Unable to register presence with provided credentials",
				});
				return;
			}

			socket.emit("presence_status", {
				status: "ok",
				username: metadata.username,
				team_name: metadata.teamName,
			});
		} catch (error) {
			console.error(`Failed register_presence for ${socket.id}`, error);
			socket.emit("presence_status", {
				status: "error",
				error: "Unexpected error while registering presence",
			});
		}
	});

	socket.on("request_screenshot", async (payload = {}) => {
		const leaderUsername = String(payload.leaderUsername || "").trim();
		const leaderSecret = String(payload.leaderSecret || "").trim();
		const team = String(payload.team || "").trim();
		const targetUsername = String(payload.targetUsername || "").trim();

		if (!leaderUsername || !leaderSecret || !team || !targetUsername) {
			socket.emit("screenshot_status", {
				status: "error",
				error: "Missing leader credentials, team, or target username",
				targetUsername,
			});
			return;
		}

		try {
			const leaderCheck = await pool.query(
				`SELECT u.id
				 FROM users u
				 JOIN teams t ON t.id = u.team_id
				 WHERE u.username = $1
				   AND u.token = $2
				   AND u.role = 'leader'
				   AND t.name = $3`,
				[leaderUsername, leaderSecret, team],
			);

			if (leaderCheck.rowCount === 0) {
				socket.emit("screenshot_status", {
					status: "error",
					error: "Invalid leader credentials for screenshot request",
					targetUsername,
				});
				return;
			}

			const onlineSocketIds = getOnlineSocketIdsForUser(team, targetUsername);
			if (onlineSocketIds.length === 0) {
				socket.emit("screenshot_status", {
					status: "offline",
					targetUsername,
					error: "Target user is offline",
				});
				return;
			}

			for (const targetSocketId of onlineSocketIds) {
				io.to(targetSocketId).emit("getScreenshot", {
					type: "getScreenshot",
					team,
					targetUsername,
					requestedBy: leaderUsername,
					timestamp: Date.now(),
				});
			}

			socket.emit("screenshot_status", {
				status: "requested",
				targetUsername,
			});
		} catch (error) {
			console.error(`Failed screenshot request from ${socket.id}`, error);
			socket.emit("screenshot_status", {
				status: "error",
				targetUsername,
				error: "Unable to request screenshot right now",
			});
		}
	});

	socket.on("remind_client", async (payload = {}) => {
		const leaderUsername = String(payload.leaderUsername || "").trim();
		const leaderSecret = String(payload.leaderSecret || "").trim();
		const team = String(payload.team || "").trim();
		const targetUsername = String(payload.targetUsername || "").trim();

		if (!leaderUsername || !leaderSecret || !team || !targetUsername) {
			socket.emit("remind_status", {
				status: "error",
				error: "Missing leader credentials, team, or target username",
				targetUsername,
			});
			return;
		}

		try {
			const leaderCheck = await pool.query(
				`SELECT u.id
				 FROM users u
				 JOIN teams t ON t.id = u.team_id
				 WHERE u.username = $1
				   AND u.token = $2
				   AND u.role = 'leader'
				   AND t.name = $3`,
				[leaderUsername, leaderSecret, team],
			);

			if (leaderCheck.rowCount === 0) {
				socket.emit("remind_status", {
					status: "error",
					error: "Invalid leader credentials for reminder",
					targetUsername,
				});
				return;
			}

			const onlineSocketIds = getOnlineSocketIdsForUser(team, targetUsername);
			if (onlineSocketIds.length === 0) {
				socket.emit("remind_status", {
					status: "offline",
					targetUsername,
					error: "Target user is offline",
				});
				return;
			}

			for (const targetSocketId of onlineSocketIds) {
				io.to(targetSocketId).emit("remindClient", {
					type: "remindClient",
					team,
					message: "Your team leader wants you to stay on task",
					timestamp: Date.now(),
				});
			}

			socket.emit("remind_confirmed", {
				status: "confirmed",
				targetUsername,
			});
		} catch (error) {
			console.error("Remind client error", error);
			socket.emit("remind_status", {
				status: "error",
				error: "Unable to send reminder",
				targetUsername,
			});
		}
	});

	socket.on("getUserTabs", async (payload = {}) => {
		const leaderUsername = String(payload.leaderUsername || "").trim();
		const leaderSecret = String(payload.leaderSecret || "").trim();
		const team = String(payload.team || "").trim();
		const targetUsername = String(payload.targetUsername || "").trim();

		if (!leaderUsername || !leaderSecret || !team || !targetUsername) {
			socket.emit("getUserTabs_response", {
				status: "error",
				error: "Missing leader credentials, team, or target username",
				targetUsername,
			});
			return;
		}

		try {
			const leaderCheck = await pool.query(
				`SELECT u.id
				 FROM users u
				 JOIN teams t ON t.id = u.team_id
				 WHERE u.username = $1
				   AND u.token = $2
				   AND u.role = 'leader'
				   AND t.name = $3`,
				[leaderUsername, leaderSecret, team],
			);

			if (leaderCheck.rowCount === 0) {
				socket.emit("getUserTabs_response", {
					status: "error",
					error: "Invalid leader credentials",
					targetUsername,
				});
				return;
			}

			const onlineSocketIds = getOnlineSocketIdsForUser(team, targetUsername);
			if (onlineSocketIds.length === 0) {
				socket.emit("getUserTabs_response", {
					status: "error",
					targetUsername,
					error: "Target user is offline",
					tabs: [],
				});
				return;
			}

			// Send request to the first available socket for this user
			const targetSocketId = onlineSocketIds[0];
			const requestId = `${socket.id}_${Date.now()}_${Math.random()}`;
			
			console.log(`[getUserTabs] Creating request ${requestId} for ${targetUsername} from ${leaderUsername}`);
			
			// Store the pending request
			pendingTabRequests.set(requestId, {
				dashboardSocketId: socket.id,
				targetUsername,
				createdAt: Date.now(),
			});
			
			// Set up timeout
			const responseTimeout = setTimeout(() => {
				const pending = pendingTabRequests.get(requestId);
				if (!pending) return;
				
				pendingTabRequests.delete(requestId);
				console.log(`[getUserTabs] Request ${requestId} timed out`);
				
				socket.emit("getUserTabs_response", {
					status: "error",
					error: "Request timeout - no response from client",
					targetUsername,
					tabs: [],
				});
			}, 5000);
			
			// Store timeout so we can clear it later
			pendingTabRequests.get(requestId).timeout = responseTimeout;

			// Send request to the client
			console.log(`[getUserTabs] Sending request to extension socket ${targetSocketId}`);
			io.to(targetSocketId).emit("getUserTabs_request", {
				team,
				requestId,
				targetUsername,
			});
		} catch (error) {
			console.error("Get user tabs error", error);
			socket.emit("getUserTabs_response", {
				status: "error",
				error: "Unable to fetch tabs",
				targetUsername,
				tabs: [],
			});
		}
	});

	// Handle userTabs_response from extension
	socket.on("userTabs_response", (payload) => {
		const requestId = payload.requestId;
		console.log(`[userTabs_response] Received response for request ${requestId}`);
		console.log("=== INCOMING userTabs JSON ===");
		console.log(JSON.stringify(payload, null, 2));
		console.log("==============================");
		
		if (!requestId) {
			console.warn("[userTabs_response] No requestId in payload");
			return;
		}
		
		const pending = pendingTabRequests.get(requestId);
		if (!pending) {
			console.warn(`[userTabs_response] No pending request found for ${requestId}`);
			return;
		}
		
		// Clear timeout and remove from pending
		clearTimeout(pending.timeout);
		pendingTabRequests.delete(requestId);
		
		console.log(`[userTabs_response] Forwarding response to dashboard socket ${pending.dashboardSocketId}`);
		
		// Send response to the dashboard socket
		io.to(pending.dashboardSocketId).emit("getUserTabs_response", {
			status: "success",
			targetUsername: pending.targetUsername,
			tabs: payload.userTabs || payload.tabs || [],
		});
	});

	socket.on("message", (payload) => {
		if (payload && typeof payload === "object") {
			registerSocketPresenceFromCredentials(socket, payload).catch((error) => {
				console.error(`Failed message-based presence registration for ${socket.id}`, error);
			});
		}

		console.log(`Message from ${socket.id}:`, payload);

		if (payload && typeof payload === "object" && payload.type === "screenshot" && payload.url) {
			io.emit("screenshot_response", payload);
		}

		io.emit("message", payload);
	});

	socket.on("ping", async (payload = {}) => {
		const username = String(payload.username ?? payload.clientUsername ?? "").trim();
		const team = String(payload.team ?? payload.clientTeam ?? "").trim();
		const token = String(payload.token ?? payload.clientToken ?? "").trim();
		const charactersAdded = toInteger(payload.charactersAdded ?? payload.clientCharactersAdded);
		const charactersRemoved = toInteger(payload.charactersRemoved ?? payload.clientCharactersRemoved);
		const charactersModified = toInteger(payload.charactersModified ?? payload.clientCharactersModified);
		const service = String(payload.service ?? "").trim();
		const documentName = String(payload.document_name ?? payload.documentName ?? "").trim();

		if (!username || !team || !token || !service) {
			console.warn(`Invalid ping from ${socket.id}: missing username, team, token, or service`);
			return;
		}

		// Input validation
		if (username.length > 100 || team.length > 100 || service.length > 200) {
			console.warn(`Invalid ping from ${socket.id}: field too long`);
			return;
		}

		if (documentName.length > 500) {
			console.warn(`Invalid ping from ${socket.id}: document name too long`);
			return;
		}

		// Validate character counts are reasonable (prevent abuse)
		if (
			charactersAdded < 0 ||
			charactersRemoved < 0 ||
			charactersModified < 0 ||
			charactersAdded > 1000000 ||
			charactersRemoved > 1000000 ||
			charactersModified > 1000000
		) {
			console.warn(`Invalid ping from ${socket.id}: character counts out of range`);
			return;
		}

		if (service === "google_docs" && !documentName) {
			console.warn(
				`Invalid ping from ${socket.id}: service is google_docs but document_name is missing`,
			);
			return;
		}

		try {
			const authRow = await authenticateSocketIdentity(username, team, token);

			if (!authRow) {
				console.warn(`Rejected ping from ${socket.id}: invalid username/token/team combination`);
				return;
			}

			const previous = socketPresenceById.get(socket.id);
			const nextKey = buildUserPresenceKey(authRow.team_name, authRow.username);
			const metadata = setSocketPresence(
				socket.id,
				authRow.team_name,
				authRow.username,
				authRow.token,
				authRow.team_id,
				Date.now(),
			);

			if (!previous || previous.key !== nextKey) {
				emitPresenceUpdated(metadata, true);
			}

			await pool.query(
				`INSERT INTO pings(
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

			io.emit("ping_saved", {
				team_id: authRow.team_id,
				received_at: new Date().toISOString(),
			});

			const noCharacterChanges =
				charactersAdded === 0 &&
				charactersRemoved === 0 &&
				charactersModified === 0;

			if (noCharacterChanges) {
				console.log(`ping received from ${username}`);
				return;
			}

			console.log("Ping received:", {
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
			console.error(`Failed to process ping from ${socket.id}`, error);
		}
	});

	socket.on("start_keystroke_monitoring", async (payload = {}) => {
		const leaderUsername = String(payload.leaderUsername || "").trim();
		const leaderSecret = String(payload.leaderSecret || "").trim();
		const team = String(payload.team || "").trim();
		const targetUsername = String(payload.targetUsername || "").trim();

		if (!leaderUsername || !leaderSecret || !team || !targetUsername) {
			return;
		}

		try {
			const leaderCheck = await pool.query(
				`SELECT u.id, t.ai_features_enabled, t.keystroke_recording_enabled, t.project_description
				 FROM users u
				 JOIN teams t ON t.id = u.team_id
				 WHERE u.username = $1
				   AND u.token = $2
				   AND u.role = 'leader'
				   AND t.name = $3`,
				[leaderUsername, leaderSecret, team],
			);

			if (leaderCheck.rowCount === 0) {
				socket.emit("keystroke_monitoring_status", {
					status: "error",
					error: "Invalid leader credentials",
					targetUsername,
				});
				return;
			}

			const teamData = leaderCheck.rows[0];

			if (!teamData.ai_features_enabled || !teamData.keystroke_recording_enabled || !teamData.project_description) {
				socket.emit("keystroke_monitoring_status", {
					status: "disabled",
					targetUsername,
					message: "AI features, keystroke recording, or project description not configured",
				});
				return;
			}

			startKeystrokeMonitoring(team, targetUsername);

			const onlineSocketIds = getOnlineSocketIdsForUser(team, targetUsername);
			for (const targetSocketId of onlineSocketIds) {
				io.to(targetSocketId).emit("enable_keystroke_capture", {
					team,
					targetUsername,
				});
			}

			socket.emit("keystroke_monitoring_status", {
				status: "started",
				targetUsername,
			});
		} catch (error) {
			console.error("Start keystroke monitoring error", error);
			socket.emit("keystroke_monitoring_status", {
				status: "error",
				error: "Unable to start keystroke monitoring",
				targetUsername,
			});
		}
	});

	socket.on("stop_keystroke_monitoring", async (payload = {}) => {
		const team = String(payload.team || "").trim();
		const targetUsername = String(payload.targetUsername || "").trim();

		if (!team || !targetUsername) {
			return;
		}

		stopKeystrokeMonitoring(team, targetUsername);

		const onlineSocketIds = getOnlineSocketIdsForUser(team, targetUsername);
		for (const targetSocketId of onlineSocketIds) {
			io.to(targetSocketId).emit("disable_keystroke_capture", {
				team,
				targetUsername,
			});
		}

		socket.emit("keystroke_monitoring_stopped", {
			status: "stopped",
			targetUsername,
		});
	});

	socket.on("keystroke_data", async (payload = {}) => {
		const username = String(payload.username || "").trim();
		const team = String(payload.team || "").trim();
		const token = String(payload.token || "").trim();
		const keyData = String(payload.keyData || "").trim();

		if (!username || !team || !token || !keyData) {
			return;
		}

		try {
			const authRow = await authenticateSocketIdentity(username, team, token);
			if (!authRow) {
				return;
			}

			const key = getUserKey(team, username);
			
			if (!keystrokeMonitoringActive.get(key)) {
				return; // Not being monitored, ignore
			}

			const keystrokeData = keystrokesByUser.get(key) || { buffer: "", lastUpdate: Date.now() };
			
			// Append keystroke to buffer
			keystrokeData.buffer += keyData;
			keystrokeData.lastUpdate = Date.now();
			
			// Keep buffer to last 2000 characters to avoid memory issues
			if (keystrokeData.buffer.length > 2000) {
				keystrokeData.buffer = keystrokeData.buffer.slice(-2000);
			}
			
			keystrokesByUser.set(key, keystrokeData);

			// Broadcast current typing to dashboard viewers
			io.emit("user_typing_update", {
				team,
				username,
				currentText: keystrokeData.buffer.slice(-200), // Send last 200 chars
				timestamp: Date.now(),
			});
		} catch (error) {
			console.error("Keystroke data error", error);
		}
	});

	socket.on("disconnect", () => {
		const removed = removeSocketPresence(socket.id);
		emitPresenceUpdated(removed, false);
		
		// Clean up any pending tab requests for this socket
		const requestsToCancel = [];
		for (const [requestId, request] of pendingTabRequests.entries()) {
			if (request.dashboardSocketId === socket.id) {
				requestsToCancel.push(requestId);
				if (request.timeout) {
					clearTimeout(request.timeout);
				}
			}
		}
		requestsToCancel.forEach((requestId) => pendingTabRequests.delete(requestId));
		
		console.log(`Client disconnected: ${socket.id}`);
	});
});

const PORT = process.env.PORT || 8001;

// Clean up expired sessions every 5 minutes
setInterval(() => {
	const now = Date.now();
	const expiredSessions = [];
	for (const [sessionId, session] of sessions.entries()) {
		if (session.expiresAt < now) {
			expiredSessions.push(sessionId);
		}
	}
	expiredSessions.forEach((sessionId) => sessions.delete(sessionId));
	if (expiredSessions.length > 0) {
		console.log(`Cleaned up ${expiredSessions.length} expired sessions`);
	}
	
	// Also clean up old pending tab requests (older than 30 seconds)
	const expiredRequests = [];
	for (const [requestId, request] of pendingTabRequests.entries()) {
		if (request.createdAt < now - 30000) {
			expiredRequests.push(requestId);
			if (request.timeout) {
				clearTimeout(request.timeout);
			}
		}
	}
	expiredRequests.forEach((requestId) => pendingTabRequests.delete(requestId));
	if (expiredRequests.length > 0) {
		console.log(`Cleaned up ${expiredRequests.length} expired tab requests`);
	}
}, 5 * 60 * 1000);

// AI evaluation loop - runs every 1 minute
setInterval(async () => {
	const now = Date.now();
	
	for (const [userKey, keystrokeData] of keystrokesByUser.entries()) {
		if (!keystrokeMonitoringActive.get(userKey)) {
			continue; // Not being monitored
		}
		
		const lastEval = aiEvaluationsByUser.get(userKey);
		
		// Only evaluate if there's new content and at least 1 minute since last eval
		if (keystrokeData.buffer.length < 50) {
			continue; // Not enough data yet
		}
		
		if (lastEval && (now - lastEval.lastEvaluated) < 60000) {
			continue; // Evaluated less than 1 minute ago
		}
		
		// Parse team and username from key
		const [team, username] = userKey.split("::");
		
		try {
			// Get project description for this team
			const teamResult = await pool.query(
				`SELECT project_description FROM teams WHERE LOWER(name) = LOWER($1)`,
				[team],
			);
			
			if (teamResult.rowCount === 0 || !teamResult.rows[0].project_description) {
				continue;
			}
			
			const projectDescription = teamResult.rows[0].project_description;
			
			// Get last 500 characters for evaluation
			const recentText = keystrokeData.buffer.slice(-500);
			
			console.log(`Evaluating ${username} in team ${team}...`);
			
			const evaluation = await evaluateTaskWithAI(recentText, projectDescription, username);
			
			aiEvaluationsByUser.set(userKey, {
				evaluation,
				lastEvaluated: now,
			});
			
			// Broadcast evaluation to dashboard
			io.emit("ai_evaluation_update", {
				team,
				username,
				evaluation,
				timestamp: now,
			});
			
			console.log(`AI evaluation for ${username}: ${evaluation}`);
		} catch (error) {
			console.error(`AI evaluation failed for ${userKey}`, error);
		}
	}
}, 60 * 1000); // Every 1 minute

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





