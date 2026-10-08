/**
 * dsh-screenshot-win — node half.
 *
 * Two capabilities over one capture engine (the zero-dependency PowerShell scripts
 * in `../scripts`, which use GDI `CopyFromScreen` + `PrintWindow(PW_RENDERFULLCONTENT)`):
 *
 *   1. the model-facing `screenshot` tool, whose result carries a real image block
 *      (committed through the attachment service) so the picture lands in the
 *      conversation, plus a PNG/JPEG saved inside the session workspace;
 *   2. the `/dsh-screenshot-win/*` HTTP routes the browser half calls — the camera
 *      button in the composer tool row captures a region / the screen / a window
 *      and injects the result into the composer as a draft attachment.
 *
 * Windows only, by construction.
 * @module dsh-screenshot-win
 */
import { execFile } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
import z from "@deepseek-ai/schemastery";

const name = "dsh-screenshot-win";
const VERSION = "0.1.0";

/** Nothing is injected unconditionally: tools and webServer are probed separately. */
const inject = [];

const Config = z.object({
  pwsh: z.string().default("pwsh"),
  timeoutMs: z.number().default(300000),
  regionTimeoutSec: z.number().default(180),
  maxWidth: z.number().default(1600),
  format: z.string().default("png"),
  quality: z.number().default(88),
  saveDir: z.string().default("screenshots"),
  tool: z.boolean().default(true),
  routes: z.boolean().default(true),
});

const SCRIPTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts");
const ROUTE_PREFIX = "/dsh-screenshot-win";
const MEDIA_TYPES = { png: "image/png", jpeg: "image/jpeg", jpg: "image/jpeg", webp: "image/webp", gif: "image/gif" };

/** The image value schema, mirrored from the built-in read_image tool. */
const IMAGE_VALUE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    attachmentId: { type: "string", required: true },
    mediaType: { type: "string", required: true },
    bytes: { type: "integer", required: true },
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    name: { type: "string" },
  },
};

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "string", required: true },
    mode: { type: "string", required: true },
    width: { type: "integer", required: true },
    height: { type: "integer", required: true },
    bytes: { type: "integer", required: true },
    note: { type: "string" },
    image: IMAGE_VALUE_SCHEMA,
  },
};

//#region helpers

/** A filename-safe local timestamp: `20260214-093107`. */
function stamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

/** Normalize a requested format to one of the encoders the scripts implement. */
function normalizeFormat(value, fallback) {
  const raw = String(value ?? fallback ?? "png").toLowerCase().replace(/^image\//, "");
  if (raw === "jpg") return "jpeg";
  return MEDIA_TYPES[raw] !== undefined ? raw : "png";
}

/** The file extension for an encoder name. */
function extensionFor(format) {
  return format === "jpeg" ? "jpg" : format;
}

/** The last JSON-looking non-empty stdout line, parsed as the script's envelope. */
function parseJsonLine(stdout) {
  const lines = String(stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{") || !line.endsWith("}")) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep looking upwards */
    }
  }
  return undefined;
}

/**
 * Run one capture script and resolve with its JSON envelope.
 * @param config - validated plugin config.
 * @param script - script file name inside `scripts/`.
 * @param args - already-formatted CLI arguments.
 * @param options - working directory, cancellation and timeout overrides.
 * @returns the parsed envelope; rejects only when the script printed no JSON at all.
 */
function runScript(config, script, args, options = {}) {
  const file = path.join(SCRIPTS_DIR, script);
  const argv = ["-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-File", file, ...args];
  const timeout = options.timeoutMs ?? config.timeoutMs;
  return new Promise((resolve, reject) => {
    execFile(
      config.pwsh || "pwsh",
      argv,
      {
        cwd: options.cwd,
        signal: options.signal,
        timeout,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const envelope = parseJsonLine(stdout);
        if (envelope !== undefined) {
          resolve(envelope);
          return;
        }
        if (error !== null && error !== undefined) {
          const detail = String(stderr ?? "").trim();
          reject(new Error(`dsh-screenshot-win: ${script} failed: ${error.message}${detail === "" ? "" : `\n${detail}`}`));
          return;
        }
        reject(new Error(`dsh-screenshot-win: ${script} printed no JSON envelope (stdout: ${String(stdout).slice(-300)})`));
      },
    );
  });
}

/** The session workspace root for this call, or the server working directory. */
function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd;
  return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
}

/**
 * Build the script arguments for one capture request.
 * Each script declares its own parameter set, so the shared flags are added per mode.
 * @param config - validated plugin config.
 * @param request - normalized capture request (see {@link capture}).
 * @returns `{ script, args, timeoutMs }`.
 */
function buildInvocation(config, request) {
  const args = ["-Out", request.out, "-Format", request.format];
  if (Number.isFinite(request.scale) && request.scale > 0) args.push("-Scale", String(request.scale));
  const maxWidth = Number.isFinite(request.maxWidth) ? request.maxWidth : config.maxWidth;
  let script;
  let timeoutMs = config.timeoutMs;

  if (request.mode === "screen") {
    script = "capture-screen.ps1";
    if (maxWidth > 0) args.push("-MaxWidth", String(maxWidth));
    args.push("-Monitor", String(Number.isInteger(request.monitor) ? request.monitor : -1));
    if ([request.x, request.y, request.width, request.height].every((value) => Number.isInteger(value))) {
      args.push("-X", String(request.x), "-Y", String(request.y), "-Width", String(request.width), "-Height", String(request.height));
    }
    if (Number.isFinite(request.quality)) args.push("-Quality", String(request.quality));
  } else if (request.mode === "window") {
    script = "capture-window.ps1";
    if (maxWidth > 0) args.push("-MaxWidth", String(maxWidth));
    if (Number.isInteger(request.hwnd) && request.hwnd > 0) args.push("-Hwnd", String(request.hwnd));
    if (typeof request.window === "string" && request.window.trim() !== "") args.push("-Title", request.window.trim());
    if (typeof request.process === "string" && request.process.trim() !== "") args.push("-Process", request.process.trim());
    if (request.active === true || (Number.isInteger(request.hwnd) !== true && typeof request.window !== "string" && typeof request.process !== "string")) args.push("-Active");
    if (request.focus === true) args.push("-Focus");
    if (request.screenFallback === true) args.push("-ScreenFallback");
    if (Number.isFinite(request.quality)) args.push("-Quality", String(request.quality));
  } else {
    // capture-region.ps1 takes neither -MaxWidth nor -Quality.
    script = "capture-region.ps1";
    timeoutMs = Math.max(config.timeoutMs, (config.regionTimeoutSec + 60) * 1000);
    args.push("-TimeoutSec", String(Number.isInteger(request.timeoutSec) ? request.timeoutSec : config.regionTimeoutSec));
    if (request.noWindowPick === true) args.push("-NoWindowPick");
  }
  return { script, args, timeoutMs };
}

/**
 * Run one capture and normalize its result.
 * @param config - validated plugin config.
 * @param request - capture request with an absolute `out` path.
 * @param context - `{ cwd, signal }` of the caller.
 * @returns the script envelope plus `{ ok, mode, script }`.
 */
async function capture(config, request, context) {
  const invocation = buildInvocation(config, request);
  const envelope = await runScript(config, invocation.script, invocation.args, {
    cwd: context.cwd,
    signal: context.signal,
    timeoutMs: invocation.timeoutMs,
  });
  if (envelope?.ok !== true) return { ok: false, mode: request.mode, ...envelope };
  return { ok: true, mode: request.mode, script: invocation.script, ...envelope };
}

/** List the pickable top-level windows. */
function listWindows(config, context) {
  return runScript(config, "list-windows.ps1", [], {
    cwd: context.cwd,
    signal: context.signal,
    timeoutMs: Math.min(config.timeoutMs, 60000),
  });
}

/** Human-readable one-line summary of a successful capture. */
function captureSummary(value) {
  const label = value.mode === "window" ? "Window" : value.mode === "screen" ? "Screen" : "Region";
  return `${label} screenshot · ${value.width}×${value.height} · ${value.bytes} bytes → ${value.path}`;
}

//#endregion

//#region tool

const SCREENSHOT_DESCRIPTION = [
  "Capture the user's Windows screen and return the picture itself: the image is attached to the conversation so you can see it, and a file is saved inside the session workspace.",
  "Modes: `region` (default) freezes the screen and lets the user drag a rectangle or click a window; `window` captures one window even when it is covered or off-screen; `screen` captures the whole virtual desktop or one monitor.",
  "Use `list_windows: true` first when you need to pick a window by name — never guess a window title.",
  "The returned image is the ground truth for pixel questions; do not also call read_image on the same path unless the image was pruned from context.",
].join(" ");

/**
 * Build the `screenshot` tool bound to the plugin context (for the attachment store).
 * @param ctx - the context that owns the tool registration.
 * @param config - validated plugin config.
 * @returns the tool definition handed to `ctx.tools.register`.
 */
function buildScreenshotTool(ctx, config) {
  /** The attachment store, probed through the executing agent's scope first. */
  const attachmentStore = (exec) => {
    try {
      return exec?.agent?.ctx?.get?.("attachments") ?? ctx.get?.("attachments") ?? undefined;
    } catch {
      return undefined;
    }
  };

  return defineTool({
    name: "screenshot",
    description: SCREENSHOT_DESCRIPTION,
    parameters: {
      mode: {
        type: "string",
        description: "Capture mode: 'region' (default — the user drags a rectangle or clicks a window), 'window' (one window, selected by `window`/`hwnd`/`process`/`active`), 'screen' (the whole virtual desktop, or one `monitor`).",
      },
      list_windows: {
        type: "boolean",
        description: "When true, list the capturable top-level windows instead of capturing. Use it to discover `window` titles and `hwnd` handles.",
      },
      window: {
        type: "string",
        description: "Window title, matched as a case-insensitive regular expression (mode 'window').",
      },
      hwnd: {
        type: "integer",
        description: "Exact window handle reported by list_windows (mode 'window'). Takes precedence over `window`.",
      },
      process: {
        type: "string",
        description: "Process executable name without '.exe', matched as a case-insensitive regular expression (mode 'window').",
      },
      active: {
        type: "boolean",
        description: "Capture whatever window is currently in the foreground (mode 'window').",
      },
      focus: {
        type: "boolean",
        description: "Restore and raise the target window before capturing (mode 'window'; needed for windows that render nothing while minimized).",
      },
      screen_fallback: {
        type: "boolean",
        description: "Copy from the screen when a window refuses to render off-screen, instead of failing (mode 'window').",
      },
      monitor: {
        type: "integer",
        description: "Monitor index for mode 'screen' (0-based, as reported by list_windows); omit or use -1 for the whole virtual desktop.",
      },
      x: { type: "integer", description: "Left edge in virtual-screen pixels (mode 'screen', together with y/width/height)." },
      y: { type: "integer", description: "Top edge in virtual-screen pixels (mode 'screen', together with x/width/height)." },
      width: { type: "integer", description: "Explicit capture width in physical pixels (mode 'screen')." },
      height: { type: "integer", description: "Explicit capture height in physical pixels (mode 'screen')." },
      scale: { type: "number", description: "Extra scale factor applied after capture, e.g. 0.5 to halve the picture." },
      max_width: { type: "integer", description: `Downscale the result so it is at most this many pixels wide (default ${config.maxWidth}); ignored by the region overlay.` },
      format: { type: "string", description: "Output format: 'png' (default, lossless) or 'jpeg' (much smaller, better for photos)." },
      timeout_sec: { type: "integer", description: `How long the region picker waits for the user before cancelling (default ${config.regionTimeoutSec}).` },
      no_window_pick: { type: "boolean", description: "Disable click-a-window-to-pick in the region overlay so only dragging selects (mode 'region')." },
      save_path: {
        type: "string",
        description: `Where to save the file. A relative path resolves inside the session workspace; the default is '<workspace>/${config.saveDir}/shot-<timestamp>.<format>'.`,
      },
    },
    output: {
      schema: OUTPUT_SCHEMA,
      render: (_args, value) => {
        const parts = [{ type: "text", text: value.note ?? captureSummary(value) }];
        if (value.image !== undefined) parts.push({ type: "image", attachment: value.image });
        return parts;
      },
      presentationMeta: (_args, value) => ({ path: value.path }),
    },
    isConcurrencySafe: () => false,
    presentCall(args) {
      const mode = typeof args.mode === "string" && args.mode !== "" ? args.mode : "region";
      return {
        card: "generic",
        title: args.list_windows === true ? "List capturable windows" : `Screenshot (${mode})`,
        kind: "read",
      };
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const context = { cwd, signal: exec.signal };

      if (args.list_windows === true) {
        const listed = await listWindows(config, context);
        if (listed?.ok !== true) throw new Error(`dsh-screenshot-win: could not list windows: ${listed?.error ?? "unknown error"}`);
        const lines = (listed.windows ?? []).map((entry, index) =>
          `${index + 1}. hwnd=${entry.hwnd} "${entry.title}" [${entry.process}${entry.pid === undefined ? "" : `#${entry.pid}`}] ${entry.w}×${entry.h} @${entry.x},${entry.y}${entry.minimized === true ? " (minimized)" : ""}`,
        );
        throw new Error([
          `dsh-screenshot-win: ${listed.count ?? 0} capturable window(s); virtual screen ${listed.virtualScreen?.w}×${listed.virtualScreen?.h}, ${listed.monitors?.length ?? 0} monitor(s).`,
          ...lines,
          "Capture one with mode='window' plus `hwnd` (preferred) or `window` (title regex).",
        ].join("\n"));
      }

      const mode = typeof args.mode === "string" && args.mode.trim() !== "" ? args.mode.trim().toLowerCase() : "region";
      const format = normalizeFormat(args.format, config.format);
      const requested = typeof args.save_path === "string" && args.save_path.trim() !== "" ? args.save_path.trim() : undefined;
      const out = requested === undefined
        ? path.join(cwd, config.saveDir, `shot-${stamp()}.${extensionFor(format)}`)
        : path.isAbsolute(requested)
          ? requested
          : path.resolve(cwd, requested);
      await mkdir(path.dirname(out), { recursive: true }).catch(() => {});

      const result = await capture(config, {
        mode,
        out,
        format,
        quality: config.quality,
        scale: args.scale,
        maxWidth: args.max_width,
        window: args.window,
        hwnd: args.hwnd,
        process: args.process,
        active: args.active,
        focus: args.focus,
        screenFallback: args.screen_fallback,
        monitor: args.monitor,
        x: args.x,
        y: args.y,
        width: args.width,
        height: args.height,
        timeoutSec: args.timeout_sec,
        noWindowPick: args.no_window_pick,
      }, context);

      if (result.ok !== true) {
        if (result.cancelled === true) {
          const reason = result.reason === "timeout" ? `the user did not respond within ${config.regionTimeoutSec}s` : "the user cancelled";
          throw new Error(`dsh-screenshot-win: capture cancelled — ${reason}. Ask the user before retrying.`);
        }
        throw new Error(`dsh-screenshot-win: capture failed: ${result.error ?? JSON.stringify(result)}`);
      }

      const savedPath = typeof result.path === "string" && result.path !== "" ? result.path : out;
      const data = await readFile(savedPath);
      const mediaType = MEDIA_TYPES[normalizeFormat(result.format ?? format, config.format)] ?? "image/png";
      const value = {
        path: savedPath,
        mode,
        width: Number(result.outW ?? result.w ?? 0),
        height: Number(result.outH ?? result.h ?? 0),
        bytes: data.byteLength,
      };
      const suffix = typeof result.windowTitle === "string" && result.windowTitle !== "" ? ` — window "${result.windowTitle}"` : "";

      const attachments = attachmentStore(exec);
      if (attachments === undefined) {
        value.note = `${captureSummary(value)}${suffix} — no attachment service is mounted, so the picture could not be attached; read "${savedPath}" as an image to see it.`;
        return value;
      }
      const ref = await attachments.saveImage({ data, mediaType, name: path.basename(savedPath) });
      value.image = {
        attachmentId: ref.attachmentId,
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: path.basename(savedPath),
      };
      value.note = `${captureSummary(value)}${suffix}`;
      return value;
    },
  });
}

//#endregion

//#region http routes

/** Read and parse a small JSON request body. */
function readJsonBody(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error instanceof Error ? error.message : String(error)}`));
      }
    });
    req.on("error", reject);
  });
}

/** Write one JSON response. */
function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * The directory a browser-requested capture is saved into: an explicit `dir`, else the
 * workspace of the session whose composer asked for it, else the server working directory.
 * @param ctx - the plugin context, for the agent registry.
 * @param config - validated plugin config.
 * @param body - the parsed request body.
 * @returns an absolute directory path.
 */
function captureDirectory(ctx, config, body) {
  if (typeof body.dir === "string" && body.dir.trim() !== "") return path.resolve(body.dir.trim());
  const sessionId = typeof body.session_id === "string" && body.session_id !== "" ? body.session_id : undefined;
  if (sessionId !== undefined) {
    try {
      const agent = ctx.get("agents").get(sessionId);
      const cwd = agent?.session?.header?.cwd;
      if (typeof cwd === "string" && cwd !== "") return path.join(cwd, config.saveDir);
    } catch {
      /* the fallback below keeps the capture working when the session cannot be resolved */
    }
  }
  const root = typeof body.cwd === "string" && body.cwd.trim() !== "" ? body.cwd.trim() : process.cwd();
  return path.resolve(root, config.saveDir);
}

/**
 * What the browser will be told about this plugin's client half. The client module
 * graph is recomposed whenever a plugin mounts, so this answers "would a page load
 * advertise and serve `./client`?" without needing the GUI open.
 * @param ctx - the plugin context, for the client module service.
 * @returns a small diagnostic object.
 */
function clientStatus(ctx) {
  try {
    const modules = ctx.get("clientModules");
    if (modules === undefined || modules === null) return { mounted: false, reason: "no clientModules service" };
    const bundle = typeof modules.clientPath === "function" ? modules.clientPath(name) : undefined;
    const graph = typeof modules.graph === "function" ? modules.graph() : undefined;
    const entries = graph !== undefined && graph !== null && Array.isArray(graph.entries) ? graph.entries : [];
    const ids = entries.map((entry) => (entry !== null && typeof entry === "object" ? entry.id : entry)).filter((id) => typeof id === "string");
    return {
      mounted: true,
      bundle: typeof bundle === "string" ? bundle : null,
      advertised: typeof bundle === "string" && ids.includes(name),
      entries: ids.length,
      rev: graph !== undefined && graph !== null && typeof graph.rev === "string" ? graph.rev : null,
    };
  } catch (error) {
    return { mounted: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Mount the browser half's capture routes.
 * @param ctx - the plugin context, used to resolve a session's workspace root.
 * @param webServer - the hosted web server service.
 * @param config - validated plugin config.
 * @returns the registered disposer.
 */
function mountRoutes(ctx, webServer, config) {
  return webServer.register({
    kind: "prefix",
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      const raw = typeof req.url === "string" && req.url !== "" ? req.url : `${ROUTE_PREFIX}/`;
      const route = new URL(raw, "http://127.0.0.1").pathname.slice(ROUTE_PREFIX.length) || "/";
      try {
        if (route === "/" || route === "/status" || route === "/ping") {
          sendJson(res, 200, {
            ok: true,
            plugin: name,
            version: VERSION,
            maxWidth: config.maxWidth,
            format: config.format,
            saveDir: config.saveDir,
            client: clientStatus(ctx),
          });
          return;
        }
        if (route === "/windows") {
          sendJson(res, 200, await listWindows(config, {}));
          return;
        }
        if (route === "/capture") {
          if (req.method !== "POST") {
            sendJson(res, 405, { ok: false, error: "use POST" });
            return;
          }
          const body = await readJsonBody(req);
          const format = normalizeFormat(body.format, config.format);
          const dir = captureDirectory(ctx, config, body);
          await mkdir(dir, { recursive: true });
          const out = path.join(dir, `shot-${stamp()}.${extensionFor(format)}`);
          const result = await capture(config, {
            mode: typeof body.mode === "string" && body.mode !== "" ? body.mode.toLowerCase() : "region",
            out,
            format,
            quality: config.quality,
            scale: body.scale,
            maxWidth: Number.isFinite(body.max_width) ? body.max_width : undefined,
            window: body.window,
            hwnd: Number.isInteger(body.hwnd) ? body.hwnd : undefined,
            process: body.process,
            active: body.active,
            focus: body.focus,
            screenFallback: body.screen_fallback,
            monitor: Number.isInteger(body.monitor) ? body.monitor : undefined,
            x: body.x,
            y: body.y,
            width: body.width,
            height: body.height,
            timeoutSec: body.timeout_sec,
            noWindowPick: body.no_window_pick,
          }, { cwd: dir });
          if (result.ok !== true) {
            sendJson(res, 200, { ok: false, cancelled: result.cancelled === true, reason: result.reason, error: result.error });
            return;
          }
          const savedPath = typeof result.path === "string" && result.path !== "" ? result.path : out;
          const data = await readFile(savedPath);
          const mediaType = MEDIA_TYPES[normalizeFormat(result.format ?? format, config.format)] ?? "image/png";
          sendJson(res, 200, {
            ok: true,
            path: savedPath,
            name: path.basename(savedPath),
            mode: result.mode,
            width: Number(result.outW ?? result.w ?? 0),
            height: Number(result.outH ?? result.h ?? 0),
            bytes: data.byteLength,
            mediaType,
            windowTitle: result.windowTitle,
            dataUrl: `data:${mediaType};base64,${data.toString("base64")}`,
          });
          return;
        }
        sendJson(res, 404, { ok: false, error: `unknown route ${route}` });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });
}

//#endregion

/**
 * Mount the plugin: the `screenshot` tool for the model and the capture routes for
 * the browser button, each behind its own service probe.
 * @param ctx - the plugin context.
 * @param config - the validated plugin config.
 */
function apply(ctx, config) {
  if (config.tool !== false) {
    ctx.inject(["tools"], (toolCtx) => {
      toolCtx.tools.register(buildScreenshotTool(toolCtx, config));
    });
  }
  if (config.routes !== false) {
    ctx.inject(["webServer"], (webCtx) => {
      webCtx.effect(() => mountRoutes(webCtx, webCtx.webServer, config), "dsh-screenshot-win: http routes");
    });
  }
}

export { Config, apply, inject, name };
