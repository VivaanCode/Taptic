# Taptic

> **Stop carrying. Start collaborating.**  
> *Made for [Stanghacks 2026](https://www.stanghacks.com/)*

Taptic is a productivity and collaboration tracking tool designed for schools and corporations to manage group projects effectively. It ensures everyone stays on task and contributes their fair share to the project.

## Features
- **Real-time Heartbeats:** Track character additions, deletions, and modifications to gauge active contribution levels.
- **Team Dashboard:** Team leaders can monitor team members' progress and activity in a comprehensive dashboard.
- **Stay-on-task Reminders:** Leaders can ping members to remind them to stay focused.
- **Activity Monitoring:** Integrates with Chrome to monitor active tabs and ensure focused work.

## Architecture

Taptic is split into two main components:
- **Backend:** A Node.js server powered by Express, Socket.IO for real-time WebSocket communication, and PostgreSQL for data storage.
- **Browser Extension:** A Chrome Manifest V3 extension that tracks activity and communicates with the backend via websockets.

---

## Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) (v16 or higher recommended)
- [PostgreSQL](https://www.postgresql.org/) database

### 1. Running the Backend

The backend server is written in Express.js and handles websockets, authentication, and the team dashboard.

1. Navigate to the backend directory:
   ```bash
   cd backend
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Create a `.env` file in the `backend` directory and configure your database connection:
   ```env
   DATABASE_URL=postgresql://username:password@localhost:5432/taptic_db
   PORT=8001
   ```
4. Start the server:
   ```bash
   npm start
   ```
   *Note: The database tables will be automatically initialized when the server starts.*

### 2. Loading the Extension

The browser extension collects metrics and enforces productivity.

1. Open Google Chrome (or a Chromium-based browser) and navigate to `chrome://extensions/`.
2. Enable **Developer mode** in the top right corner.
3. Click **Load unpacked** in the top left.
4. Select the `extension` folder from this repository.
5. Once loaded, click on the extension's options to configure your user setup. (Team leaders can generate auto-setup links from the dashboard to easily configure their members).

---

## Usage

1. Go to `http://localhost:8001/` (or your deployed server URL) and create a new team.
2. Share the generated auto-setup links with your team members to configure their extensions.
3. Team leaders can log in to the dashboard at `http://localhost:8001/dashboard/login` to monitor progress, request screenshots, view active tabs, and send reminders.
