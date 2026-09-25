// ACP probe: spawn devin.exe acp, start a session, launch a background subagent,
// then try a second session/prompt mid-turn WITHOUT session/cancel.
// Usage: node acp-probe.js [mode]   mode = "prompt" | "send_now" | "cancel"
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DEVIN = "C:\\Users\\kevin\\AppData\\Local\\devin\\cli\\bin\\devin.exe";
const WORK = "C:\\Users\\kevin\\devin-subagent-test";
const PROOF = path.join(WORK, "acp-probe-alive.txt");
const MODE = process.argv[2] || "prompt";
const LOG = path.join(__dirname, `acp-probe-${MODE}.log`);
const log = (...a) => {
  const line = `[${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  fs.appendFileSync(LOG, line + "\n");
};

if (fs.existsSync(PROOF)) fs.unlinkSync(PROOF);
fs.writeFileSync(LOG, "");

const child = spawn(DEVIN, ["acp"], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
let nextId = 1;
const pending = new Map();
let sessionId = null;
let sawSubagent = false;
let secondSent = false;

function send(method, params, isNotif = false) {
  const id = isNotif ? undefined : nextId++;
  const msg = isNotif
    ? { jsonrpc: "2.0", method, params }
    : { jsonrpc: "2.0", id, method, params };
  child.stdin.write(JSON.stringify(msg) + "\n");
  log(">>>", JSON.stringify(msg).slice(0, 300));
  if (isNotif) return Promise.resolve();
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}

function describeUpdate(u) {
  const t = u.sessionUpdate;
  const bits = [t];
  if (u._meta) bits.push("meta=" + JSON.stringify(u._meta).slice(0, 200));
  if (u.toolCallId) bits.push("tc=" + u.toolCallId);
  if (u.title) bits.push("title=" + String(u.title).slice(0, 80));
  if (u.status) bits.push("status=" + u.status);
  if (u.content?.text) bits.push("text=" + u.content.text.slice(0, 120).replace(/\n/g, " "));
  if (u.content?.content?.text) bits.push("text=" + u.content.content.text.slice(0, 120).replace(/\n/g, " "));
  return bits.join(" ");
}

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { log("!! unparseable:", line.slice(0, 200)); continue; }

    if (msg.method === "session/update") {
      const u = msg.params?.update || {};
      log("<<< session/update", describeUpdate(u));
      const s = JSON.stringify(u);
      if ((u._meta && u._meta["cognition.ai/subagent_started"]) ||
          (u.sessionUpdate === "tool_call_update" && u._meta?.["cognition.ai/subagent_context"])) {
        if (!sawSubagent) { sawSubagent = true; log("*** SUBAGENT RUNNING (real event)"); }
      }
      maybeSendSecond();
      continue;
    }
    if (msg.method === "session/request_permission") {
      const opts = msg.params?.options || msg.params?.toolCall?.options || [];
      const allow = opts.find(o => /allow/i.test(o.kind || "") || /allow/i.test(o.name || "")) || opts[0];
      log("<<< request_permission ->", JSON.stringify(allow).slice(0, 200));
      child.stdin.write(JSON.stringify({
        jsonrpc: "2.0", id: msg.id,
        result: { outcome: { outcome: "selected", optionId: allow?.optionId } }
      }) + "\n");
      continue;
    }
    if (msg.id !== undefined && msg.method) {
      log("<<< client request", msg.method, "-> auto-empty-result");
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: null }) + "\n");
      continue;
    }
    if (msg.id !== undefined) {
      log("<<< response id=" + msg.id, (msg.error ? "ERR " : "") + JSON.stringify(msg.error || msg.result).slice(0, 400));
      const p = pending.get(msg.id);
      if (p) { pending.delete(msg.id); msg.error ? p.rej(new Error(JSON.stringify(msg.error))) : p.res(msg.result); }
      continue;
    }
    log("<<< notif", msg.method || "?", JSON.stringify(msg).slice(0, 250));
  }
});

async function maybeSendSecond() {
  if (secondSent || !sawSubagent || !sessionId) return;
  secondSent = true;
  log("*** background subagent observed; waiting 8s then trying mode=" + MODE);
  await new Promise(r => setTimeout(r, 8000));
  try {
    if (MODE === "prompt") {
      const r = await send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: pong" }],
      });
      log("*** second prompt completed:", JSON.stringify(r).slice(0, 300));
    } else if (MODE === "send_now") {
      // first try queueing a message, then send_now on it
      const r1 = await send("session/prompt", {
        sessionId,
        prompt: [{ type: "text", text: "Reply with exactly: pong" }],
      }).catch(e => ({ queuedOrErr: String(e) }));
      log("*** raw prompt result:", JSON.stringify(r1).slice(0, 300));
    }
  } catch (e) { log("*** second send failed:", String(e).slice(0, 400)); }
}

(async () => {
  try {
    const init = await send("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "acp-probe", version: "0.0.1" },
    });
    log("init ok:", JSON.stringify(init).slice(0, 800));

    if (init.authMethods?.length) {
      const m = init.authMethods[0].id || init.authMethods[0];
      log("auth required, trying method", m);
      try { await send("authenticate", { methodId: m }); log("auth ok"); }
      catch (e) { log("auth failed (continuing):", String(e).slice(0, 200)); }
    }

    const s = await send("session/new", { cwd: WORK, mcpServers: [] });
    sessionId = s.sessionId;
    log("session:", sessionId, "modes:", JSON.stringify(s.modes || s._meta || "").slice(0, 400));

    const promptP = send("session/prompt", {
      sessionId,
      prompt: [{ type: "text", text:
        `Use the run_subagent tool with is_background=true and profile subagent_general to launch exactly one background subagent. ` +
        `Its task: run "sleep 120", then write the text "alive" to the file acp-probe-alive.txt in the current directory. ` +
        `After the tool call returns, reply with exactly: launched` }],
    });
    promptP.then(r => log("*** first prompt turn ended:", JSON.stringify(r).slice(0, 300)))
           .catch(e => log("*** first prompt failed:", String(e).slice(0, 400)));

    // watch for proof file for up to ~140s; linger 10s after proof to capture prompt resolutions
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (fs.existsSync(PROOF)) {
        log("*** PROOF: subagent completed, wrote file. secondSent:", secondSent);
        clearInterval(timer); setTimeout(() => process.exit(0), 10000);
      } else if (Date.now() - t0 > 140_000) {
        log("*** TIMEOUT: no proof file; subagent likely died or never ran");
        clearInterval(timer); process.exit(2);
      }
    }, 2000);
  } catch (e) { log("FATAL", String(e).slice(0, 500)); process.exit(1); }
})();
