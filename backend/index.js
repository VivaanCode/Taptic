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
		`SELECT u.id, u.username, u.team_id, t.name AS team_name
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

app.get("/dashboard", async (req, res) => {
	try {
		const leader = await getAuthenticatedLeader(req);
		if (!leader) {
			res.redirect("/dashboard/login");
			return;
		}

		const summaryResult = await pool.query(
			`SELECT
				COUNT(*)::INT AS total_heartbeats,
				COALESCE(SUM(characters_added + characters_removed + characters_modified), 0)::INT AS total_character_changes,
				COUNT(DISTINCT service)::INT AS services_used,
				MAX(received_at) AS last_heartbeat_at
			 FROM heartbeats
			 WHERE team_id = $1`,
			[leader.team_id],
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
			[leader.team_id],
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
			[leader.team_id],
		);

		const summary = summaryResult.rows[0];
		const users = usersResult.rows;
		const daily = dailyResult.rows;

	const totalMembers = users.length;
	const userRows = users
		.map(
			(user) => `<tr>
          <td>${escapeHtml(user.username)}</td>
          <td>${escapeHtml(user.role)}</td>
          <td>${escapeHtml(user.heartbeat_count)}</td>
          <td>${escapeHtml(user.characters_added)}</td>
          <td>${escapeHtml(user.characters_removed)}</td>
          <td>${escapeHtml(user.characters_modified)}</td>
          <td><strong>${escapeHtml(user.total_activity)}</strong></td>
        </tr>`,
		)
		.join("");

	const chartLabels = JSON.stringify(daily.map((row) => row.day));
	const chartTeamActivity = JSON.stringify(daily.map((row) => row.total_activity));
	const userLabels = JSON.stringify(users.map((row) => row.username));
	const userTotals = JSON.stringify(users.map((row) => row.total_activity));

	const dashboardHtml = `
    <div class="panel">
      <h1>Team Dashboard</h1>
      <p>Welcome, <strong>${escapeHtml(leader.username)}</strong> (team: <strong>${escapeHtml(leader.team_name)}</strong>)</p>
      <p><a href="/dashboard/logout">Logout</a></p>
    </div>

    <div class="panel cards">
      <div class="card">
        <span class="muted">Team Members</span>
        <strong>${escapeHtml(totalMembers)}</strong>
      </div>
      <div class="card">
        <span class="muted">Total Heartbeats</span>
        <strong>${escapeHtml(summary.total_heartbeats || 0)}</strong>
      </div>
      <div class="card">
        <span class="muted">Total Character Activity</span>
        <strong>${escapeHtml(summary.total_character_changes || 0)}</strong>
      </div>
      <div class="card">
        <span class="muted">Services Used</span>
        <strong>${escapeHtml(summary.services_used || 0)}</strong>
      </div>
    </div>

    <div class="panel">
      <h2>Daily Team Activity (Last 14 Days)</h2>
      <canvas id="teamActivityChart" height="120"></canvas>
    </div>

    <div class="panel">
      <h2>User Contribution Comparison</h2>
      <canvas id="userContributionChart" height="120"></canvas>
    </div>

    <div class="panel">
      <h2>User Metrics</h2>
      <table>
        <thead>
          <tr>
            <th>Username</th>
            <th>Role</th>
            <th>Heartbeats</th>
            <th>Added</th>
            <th>Removed</th>
            <th>Modified</th>
            <th>Total Activity</th>
          </tr>
        </thead>
        <tbody>${userRows || "<tr><td colspan=\"7\">No users found</td></tr>"}</tbody>
      </table>
      <p class="muted">Last heartbeat: ${escapeHtml(summary.last_heartbeat_at || "No heartbeat data yet")}</p>
    </div>

    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script>
      const teamActivityCtx = document.getElementById("teamActivityChart").getContext("2d");
      const userContributionCtx = document.getElementById("userContributionChart").getContext("2d");

      new Chart(teamActivityCtx, {
        type: "line",
        data: {
          labels: ${chartLabels},
          datasets: [{
            label: "Total Character Activity",
            data: ${chartTeamActivity},
            borderColor: "#1f6feb",
            backgroundColor: "rgba(31, 111, 235, 0.2)",
            tension: 0.25,
            fill: true
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: true } }
        }
      });

      new Chart(userContributionCtx, {
        type: "bar",
        data: {
          labels: ${userLabels},
          datasets: [{
            label: "Total Activity Per User",
            data: ${userTotals},
            backgroundColor: "rgba(15, 118, 110, 0.7)",
            borderColor: "#0f766e",
            borderWidth: 1
          }]
        },
        options: {
          responsive: true,
          plugins: { legend: { display: true } }
        }
      });
    </script>
  `;

		res.send(renderPage("Team Dashboard", dashboardHtml));
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

