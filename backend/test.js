const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: {
        origin: "*",
    },
});

app.get("/", (req, res) => {
    res.send("v0.0.2 Seam server");
});

io.on("connection", (socket) => {
    console.log(`Client connected: ${socket.id}`);

    socket.emit("message", "Connected to server");

    socket.on("message", (payload) => {
        console.log(`Message from ${socket.id}:`, payload);
        io.emit("message", payload);
    });

    socket.on("disconnect", () => {
        console.log(`Client disconnected: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 5173;

server.listen(PORT, () => {
    console.log(`Server listening on http://localhost:${PORT}`);
});

