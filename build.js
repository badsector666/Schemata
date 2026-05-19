const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "admin-ui v2.html"), "utf-8");
const workerSrc = fs.readFileSync(path.join(__dirname, "workerv2.js"), "utf-8");

// Just inline the HTML — no placeholder needed in v2
const built = `const ADMIN_HTML = ${JSON.stringify(html)};\n` + workerSrc;

fs.writeFileSync(path.join(__dirname, "dist/worker.js"), built);
