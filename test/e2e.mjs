/**
 * End-to-end test of the tool's execute path with the real PowerShell capture layer.
 * Run from the package root:  node test/e2e.mjs
 *
 * Skips anything interactive (region capture needs the user at the screen).
 */
import { statSync } from "node:fs";

const mod = await import("../lib/index.js");
const failures = [];

const check = (label, condition, detail) => {
  if (condition) console.log(`  ok   ${label}`);
  else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
};

const tools = [];
const fakeCtx = {
  tools: { register: (definition) => { tools.push(definition); return () => {}; } },
  webServer: { register: () => () => {} },
  effect: (fn) => { fn(); return () => {}; },
  get: () => undefined, // no attachment service in this harness
};
mod.apply({ get: () => undefined, inject: (_deps, callback) => callback(fakeCtx) }, mod.Config({}));
const tool = tools[0];

const exec = {
  callId: "e2e",
  name: "screenshot",
  arguments: {},
  signal: undefined,
  agent: { session: { header: { cwd: "E:\\GAME\\Kingdom Rush6" } } },
};

console.log("list_windows");
try {
  await tool.execute({ list_windows: true }, exec);
  check("list_windows reports through an error message", false, "no error thrown");
} catch (error) {
  const message = String(error?.message ?? error);
  const hasTable = /hwnd/i.test(message) && message.includes("title");
  check("list_windows reports through an error message", hasTable, message.slice(0, 300));
  console.log(message.split("\n").slice(0, 8).map((line) => `       | ${line}`).join("\n"));
}

console.log("screen capture");
const screen = await tool.execute({ mode: "screen", max_width: 640, save_path: "screenshots/e2e-screen.png" }, exec);
check("returns ok", screen.mode === "screen", JSON.stringify(screen));
check("downscaled to the requested width", screen.width === 640, `width=${screen.width}`);
check("saved inside the session workspace", screen.path === "E:\\GAME\\Kingdom Rush6\\screenshots\\e2e-screen.png", screen.path);
try {
  const info = statSync(screen.path);
  check("file exists on disk", info.size === screen.bytes, `disk=${info.size} reported=${screen.bytes}`);
} catch (error) {
  check("file exists on disk", false, String(error));
}
check("no attachment service → note explains the fallback", typeof screen.note === "string" && screen.note.includes(screen.path), screen.note);
const parts = tool.output.render({}, screen);
check("render falls back to text only", parts.length === 1 && parts[0].type === "text");

console.log("window capture");
try {
  const window = await tool.execute({ mode: "window", active: true, max_width: 480 }, exec);
  check("captured the foreground window", window.mode === "window" && window.width > 0, JSON.stringify(window));
  console.log(`       | ${window.path} (${window.width}x${window.height})`);
} catch (error) {
  console.log(`  skip active-window capture — ${String(error?.message ?? error).slice(0, 160)}`);
}

console.log("jpeg + region-script argument compatibility");
const jpeg = await tool.execute({ mode: "screen", format: "jpeg", scale: 0.25, save_path: "screenshots/e2e-screen.jpg" }, exec);
check("jpeg path uses .jpg", jpeg.path.endsWith(".jpg"), jpeg.path);

console.log(failures.length === 0 ? "\nE2E PASS" : `\nE2E FAIL (${failures.length}): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
