/**
 * dsh-screenshot-win — host-side simulation of the browser half.
 *
 * There is no browser control in this environment, so this test loads
 * `client/client.js` inside a `node:vm` sandbox with a minimal React runtime and
 * asserts the module's real behaviour:
 *
 *   * the `__ModuleLoader__` id equals the package name;
 *   * the factory imports only `react` (the practices rule forbids loading host
 *     Client packages);
 *   * `apply` registers the composer button and the tool row on the exact slots,
 *     with the `id`/`key`/`children` dialect each slot expects;
 *   * the button opens its menu, calls the right routes with `session_id`, hands
 *     the picture to `conversation.createDrafts` + `inputActions.addAttachments`,
 *     and reports success, rejection, cancellation and listing failures;
 *   * the tool row forwards image attachments to `tool.call.images`.
 *
 * It cannot replace looking at the real GUI: no browser is involved.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ORIGIN = "http://127.0.0.1:19387";
const CODE = readFileSync(new URL("../client/client.js", import.meta.url), "utf8");

/* ------------------------------------------------------------------ React --- */
/** The component currently rendering, for the hook shims below. */
const runtime = { current: null };

function renderInstance(instance) {
  for (const cleanup of instance.pendingCleanups) {
    try {
      cleanup();
    } catch {
      /* a failed cleanup must not hide the assertion under test */
    }
  }
  instance.pendingCleanups = [];
  runtime.current = instance;
  instance.cursor = 0;
  instance.renders += 1;
  const tree = instance.Component(instance.props);
  runtime.current = null;
  const effects = instance.pendingEffects;
  instance.pendingEffects = [];
  for (const effect of effects) {
    const cleanup = effect();
    if (typeof cleanup === "function") instance.pendingCleanups.push(cleanup);
  }
  instance.tree = tree;
  return tree;
}

/** Mount a component with a hook runtime that re-renders on every state change. */
function mount(Component, props) {
  const instance = {
    Component,
    props,
    hooks: [],
    cursor: 0,
    pendingEffects: [],
    pendingCleanups: [],
    renders: 0,
    tree: null,
  };
  renderInstance(instance);
  return instance;
}

const React = {
  createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props ?? {}),
        children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
      },
    };
  },
  useState(initial) {
    const instance = runtime.current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (index >= instance.hooks.length) {
      instance.hooks.push(typeof initial === "function" ? initial() : initial);
    }
    return [
      instance.hooks[index],
      (next) => {
        const value = typeof next === "function" ? next(instance.hooks[index]) : next;
        if (Object.is(value, instance.hooks[index])) return;
        instance.hooks[index] = value;
        renderInstance(instance);
      },
    ];
  },
  useRef(initial) {
    const instance = runtime.current;
    const index = instance.cursor;
    instance.cursor += 1;
    if (index >= instance.hooks.length) instance.hooks.push({ current: initial });
    return instance.hooks[index];
  },
  useEffect(effect) {
    runtime.current.pendingEffects.push(effect);
  },
  useCallback(fn) {
    return fn;
  },
  useMemo(fn) {
    return fn();
  },
};

/* ---------------------------------------------------------------- tree walk -- */
function walk(node, visit) {
  if (node === null || node === undefined || typeof node === "boolean") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node === "object" && node.type !== undefined) {
    visit(node);
    walk(node.props.children, visit);
  }
}

/** First element matching `predicate`, in render order. */
function find(node, predicate) {
  let found = null;
  walk(node, (element) => {
    if (found === null && predicate(element)) found = element;
  });
  return found;
}

/** All element text, so a toast can be asserted by its visible string. */
function textOf(node) {
  const parts = [];
  walk(node, (element) => {
    const children = element.props.children;
    const list = Array.isArray(children) ? children : [children];
    for (const child of list) if (typeof child === "string") parts.push(child);
  });
  return parts.join(" | ");
}

/** A button whose rendered text contains `label` (labels may sit in nested spans). */
const buttonByText = (label) => (element) => element.type === "button" && textOf(element).includes(label);

/** `find`, but a miss fails the current check instead of returning null. */
function must(node, predicate, label) {
  const found = find(node, predicate);
  assert.ok(found !== null, label);
  return found;
}

/**
 * Apply a freshly loaded module against a recording context and return the
 * components it registered. Each check that needs different stubs gets its own
 * module instance, and therefore its own fetch/document.
 */
function applyAndCapture(mod, overrides = {}) {
  const captured = {};
  /** A locale stub that reports Chinese and answers no namespace, like the real
   * service before this plugin's own dictionaries are consulted. */
  /* "locale" in overrides (not ??) so a check can pass an explicit undefined to model
   * a plugin that applies before the locale service exists. */
  const locale = "locale" in overrides ? overrides.locale : {
    register() {},
    bind() {
      return (key) => key;
    },
    getLocale() {
      return { active: "zh", locales: [{ id: "en" }, { id: "zh" }], revision: 1 };
    },
  };
  const ctx = {
    get: overrides.get ?? (() => undefined),
    locale,
    slots: {
      inject(_owner, factory) {
        factory();
      },
      register(definition, component) {
        captured[definition.name] = { definition, component };
      },
    },
  };
  mod.apply(ctx);
  /* The context rides along so a check can provide a service after apply. */
  captured.ctx = ctx;
  return captured;
}

/* ----------------------------------------------------------------- sandbox --- */
function makeSandbox({ capture, windows, calls, navigator: navigatorStub }) {
  const listeners = [];
  const ElementStub = class Element {
    contains() {
      return false;
    }
    closest() {
      return null;
    }
    getBoundingClientRect() {
      return { left: 320, top: 700, right: 348, bottom: 728, width: 28, height: 28 };
    }
  };

  const documentStub = {
    addEventListener(type, handler) {
      listeners.push({ type, handler });
    },
    removeEventListener(type, handler) {
      const index = listeners.findIndex((entry) => entry.type === type && entry.handler === handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };

  const fetchStub = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/capture")) {
      const result = await capture(options === undefined ? undefined : JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => result };
    }
    if (String(url).endsWith("/windows")) {
      const result = await windows();
      return { ok: true, status: 200, json: async () => result };
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    atob,
    File,
    Element: ElementStub,
    fetch: fetchStub,
    document: documentStub,
    navigator: navigatorStub ?? { language: "zh-CN", languages: ["zh-CN", "zh", "en"] },
    location: { origin: ORIGIN },
    window: { innerWidth: 1600, innerHeight: 900, __DSH_BOOT__: { origin: ORIGIN } },
  };
  sandbox.window.window = sandbox.window;
  return sandbox;
}

function loadModule(sandbox) {
  let loaded = null;
  sandbox.window.__ModuleLoader__ = { load: (module) => { loaded = module; } };
  const context = vm.createContext(sandbox);
  vm.runInContext(CODE, context, { filename: "client.js" });
  assert.ok(loaded !== null, "the module never registered itself with __ModuleLoader__");
  return loaded;
}

/* ------------------------------------------------------------------- tests --- */
const results = [];
function check(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(`  ok   ${label}`))
    .catch((error) => {
      results.push(`  FAIL ${label}: ${error.message}`);
      process.exitCode = 1;
    });
}

const PNG_DATA_URL = `data:image/png;base64,${Buffer.from("dsh-screenshot-win-test-bytes").toString("base64")}`;

async function run() {
  const calls = [];
  const draftsMade = [];
  const released = [];
  const sandbox = makeSandbox({
    calls,
    capture: async (body) => ({
      ok: true,
      path: "E:\\GAME\\Kingdom Rush6\\screenshots\\shot-test.png",
      mode: body === undefined ? "region" : body.mode,
      width: 1280,
      height: 720,
      name: "shot-test.png",
      mediaType: "image/png",
      dataUrl: PNG_DATA_URL,
    }),
    windows: async () => ({
      ok: true,
      windows: [
        { hwnd: 525778, title: "DSH screen capture plugin", process: "DeepSeek Harness", pid: 4242, w: 2242, h: 1438 },
        { hwnd: 592556, title: "", process: "Doubao", pid: 11, w: 800, h: 600, minimized: true },
      ],
    }),
  });

  const loaded = loadModule(sandbox);

  await check("module id is the package name", () => {
    assert.equal(loaded.id, "dsh-screenshot-win");
    assert.equal(typeof loaded.factory, "function");
  });

  let hostRequires = [];
  const requireStub = (specifier) => {
    hostRequires.push(specifier);
    if (specifier === "react") return React;
    throw new Error(`the browser half must not require host packages, got "${specifier}"`);
  };
  const mod = loaded.factory(requireStub);

  await check("factory shape", () => {
    assert.equal(mod.name, "dsh-screenshot-win");
    assert.deepEqual(Array.from(mod.inject), ["slots"]);
    assert.equal(typeof mod.apply, "function");
  });

  const registrations = [];
  const registered = [];
  const localeCalls = [];
  const ctx = {
    get(name) {
      if (name === "conversation") {
        return {
          createDrafts(sessionId, files) {
            draftsMade.push({ sessionId, files });
            return files.map((file, index) => ({ id: `draft-${index}`, file }));
          },
          releaseDraftAttachments(drafts) {
            released.push(...drafts);
          },
        };
      }
      return undefined;
    },
    locale: {
      register(namespace, id, dict) {
        localeCalls.push({ namespace, id, keys: Object.keys(dict).length });
      },
      bind() {
        // Returning the key models a namespace the service does not answer for,
        // which must fall back to the bundled dictionary.
        return (key) => key;
      },
      getLocale() {
        return { id: "zh" };
      },
    },
    slots: {
      inject(owner, factory) {
        registrations.push({ owner, factory });
      },
      register(definition, component) {
        registered.push({ definition, component });
      },
    },
  };

  mod.apply(ctx);

  await check("registers both slots exactly once", () => {
    assert.deepEqual(registrations.map((entry) => entry.owner), [
      "conversation.input.left",
      "tool.call.toolview",
    ]);
  });

  for (const entry of registrations) entry.factory();

  await check("both slot factories registered a component", () => {
    assert.equal(registered.length, 2);
    for (const item of registered) assert.equal(typeof item.component, "function");
  });

  await check("composer slot registration uses id (not key) and an order", () => {
    const entry = registered.find((item) => item.definition.name === "conversation.input.left");
    assert.ok(entry !== undefined, "conversation.input.left was not registered");
    assert.equal(entry.definition.id, "dsh-screenshot-win");
    assert.equal(entry.definition.order, 40);
    assert.equal(entry.definition.key, undefined);
    assert.equal(typeof entry.component, "function");
  });

  await check("tool row registration uses the tool name as key and declares the image child", () => {
    const entry = registered.find((item) => item.definition.name === "tool.call.toolview");
    assert.ok(entry !== undefined, "tool.call.toolview was not registered");
    assert.equal(entry.definition.key, "screenshot");
    assert.equal(
      JSON.stringify(entry.definition.children),
      JSON.stringify({ "tool.call.images": { kind: "single", scope: "session" } }),
    );
  });

  const button = registered.find((item) => item.definition.name === "conversation.input.left");
  const row = registered.find((item) => item.definition.name === "tool.call.toolview");

  const added = [];
  const rejectAttachments = { value: false };
  const inputActions = {
    addAttachments(ids) {
      added.push(Array.from(ids));
      return rejectAttachments.value ? false : true;
    },
  };

  const instance = mount(button.component, { inputActions, sessionId: "session-1" });

  await check("locale dictionaries registered for zh and en", () => {
    /* Published on first use, not at apply time — the mount above is what registers them. */
    assert.deepEqual(localeCalls.map((call) => `${call.namespace}:${call.id}`), [
      "dsh-screenshot-win:zh",
      "dsh-screenshot-win:en",
    ]);
    assert.ok(localeCalls[0].keys === localeCalls[1].keys, "the two dictionaries must cover the same keys");
  });

  await check("renders the camera button with a Chinese label", () => {
    const camera = must(
      instance.tree,
      (element) => element.props["aria-label"] === "截图",
      "no button carrying the localized aria-label",
    );
    assert.equal(camera.type, "button");
    assert.equal(typeof camera.props.onClick, "function");
    assert.equal(camera.props.title, "截图：框选区域 / 整屏 / 指定窗口");
  });

  const camera = must(instance.tree, (element) => element.props["aria-label"] === "截图", "no camera button");
  camera.props.onClick();

  await check("opens a menu with the three capture modes", () => {
    must(instance.tree, buttonByText("框选区域"), "no region entry after opening the menu");
    must(instance.tree, buttonByText("整个屏幕"), "no whole-screen entry after opening the menu");
    must(instance.tree, buttonByText("指定某个窗口…"), "no window entry after opening the menu");
  });

  find(instance.tree, buttonByText("框选区域")).props.onClick();
  await new Promise((resolve) => setTimeout(resolve, 20));

  await check("region capture posts mode+session_id to /dsh-screenshot-win/capture", () => {
    const post = calls.find((call) => call.url === `${ORIGIN}/dsh-screenshot-win/capture`);
    assert.ok(post !== undefined, "no capture request was sent");
    assert.equal(post.options.method, "POST");
    assert.equal(post.options.headers["content-type"], "application/json");
    const body = JSON.parse(post.options.body);
    assert.equal(body.mode, "region");
    assert.equal(body.session_id, "session-1");
  });

  await check("hands a real image File to createDrafts and adds the draft", () => {
    assert.equal(draftsMade.length, 1, "createDrafts was not called exactly once");
    assert.equal(draftsMade[0].sessionId, "session-1");
    const file = draftsMade[0].files[0];
    assert.equal(file.type, "image/png");
    assert.equal(file.name, "shot-test.png");
    assert.equal(file.size, Buffer.from("dsh-screenshot-win-test-bytes").length);
    assert.deepEqual(added, [["draft-0"]]);
    assert.equal(released.length, 0, "nothing may be released after a successful insert");
  });

  await check("reports success with size and saved path", () => {
    const text = textOf(instance.tree);
    assert.equal(text.includes("已插入截图"), true, `toast was: ${text}`);
    assert.equal(text.includes("1280×720"), true, `toast was: ${text}`);
    assert.equal(text.includes("screenshots\\shot-test.png"), true, `toast was: ${text}`);
  });

  await check("window submenu loads the window list and captures by hwnd", async () => {
    const cameraAgain = find(instance.tree, (element) => element.props["aria-label"] === "截图");
    cameraAgain.props.onClick();
    find(instance.tree, buttonByText("指定某个窗口…")).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listed = calls.find((call) => call.url === `${ORIGIN}/dsh-screenshot-win/windows`);
    assert.ok(listed !== undefined, "the window list route was not requested");
    const entry = must(instance.tree, buttonByText("DSH screen capture plugin"), "the listed window is not offered as an entry");
    entry.props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const posts = calls.filter((call) => call.url === `${ORIGIN}/dsh-screenshot-win/capture`);
    const body = JSON.parse(posts[posts.length - 1].options.body);
    assert.equal(body.mode, "window");
    assert.equal(body.hwnd, 525778);
    assert.equal(textOf(instance.tree).includes("已插入截图"), true);
  });

  await check("a rejected composer insert keeps the file saved and says so", async () => {
    rejectAttachments.value = true;
    try {
      const before = released.length;
      const cameraThird = must(instance.tree, (element) => element.props["aria-label"] === "截图", "no camera button");
      cameraThird.props.onClick();
      find(instance.tree, buttonByText("整个屏幕")).props.onClick();
      await new Promise((resolve) => setTimeout(resolve, 20));
      const text = textOf(instance.tree);
      assert.equal(text.includes("无法插入到输入框"), true, `toast was: ${text}`);
      assert.equal(text.includes("screenshots\\shot-test.png"), true, `toast was: ${text}`);
      assert.equal(released.length, before + 1, "the rejected draft must be released");
    } finally {
      rejectAttachments.value = false;
    }
  });

  await check("a cancelled capture reports cancellation instead of failure", async () => {
    const cancelledSandbox = makeSandbox({
      calls: [],
      capture: async () => ({ ok: false, cancelled: true }),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const cancelledMod = loadModule(cancelledSandbox).factory(requireStub);
    const parts = applyAndCapture(cancelledMod);
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(view.tree, (element) => element.props["aria-label"] === "截图", "no camera button").props.onClick();
    find(view.tree, buttonByText("框选区域")).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const text = textOf(view.tree);
    assert.equal(text.includes("已取消截图"), true, `toast was: ${text}`);
    assert.equal(text.includes("截图失败"), false, `toast was: ${text}`);
  });

  await check("a failing window list is reported, not thrown", async () => {
    const failingSandbox = makeSandbox({
      calls: [],
      capture: async () => ({ ok: true, dataUrl: PNG_DATA_URL, width: 1, height: 1, path: "p", mediaType: "image/png", name: "n.png" }),
      windows: async () => {
        throw new Error("boom");
      },
    });
    const failingMod = loadModule(failingSandbox).factory(requireStub);
    const parts = applyAndCapture(failingMod);
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(view.tree, (element) => element.props["aria-label"] === "截图", "no camera button").props.onClick();
    find(view.tree, buttonByText("指定某个窗口…")).props.onClick();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const text = textOf(view.tree);
    assert.equal(text.includes("读取窗口列表失败"), true, `toast was: ${text}`);
  });

  await check("tool row forwards the image attachment to tool.call.images", () => {
    const attachment = { attachmentId: "abc", mediaType: "image/png", bytes: 10, width: 4, height: 3, name: "a.png" };
    const dispatched = [];
    const tree = row.component({
      block: { content: [{ type: "text", text: "captured the desktop" }, { type: "image", attachment }] },
      loadImage: () => Promise.resolve("blob:x"),
      renderSlot: (name, props) => {
        dispatched.push({ name, props });
        return { type: "gallery", props: {} };
      },
    });
    assert.equal(dispatched.length, 1);
    assert.equal(dispatched[0].name, "tool.call.images");
    assert.equal(JSON.stringify(dispatched[0].props.images), JSON.stringify([{ attachment }]));
    assert.equal(dispatched[0].props.align, "start");
    assert.equal(textOf(tree).includes("captured the desktop"), true);
  });

  await check("tool row survives a text-only or empty tool result", () => {
    const textOnly = row.component({ block: { content: [{ type: "text", text: "no image here" }] } });
    assert.equal(textOf(textOnly).includes("no image here"), true);
    const empty = row.component({ block: {} });
    assert.ok(empty !== null && empty !== undefined);
    const nothing = row.component({});
    assert.ok(nothing !== null && nothing !== undefined);
  });

  /** A locale service stub carrying the shipped runtime's snapshot shape. */
  const localeService = (active, values = {}) => ({
    register() {},
    bind() {
      return (key) => values[key] ?? key;
    },
    getLocale() {
      return { active, locales: [{ id: "en" }, { id: "zh" }], revision: 1 };
    },
  });

  await check("picks up a locale service provided after apply", () => {
    const lateSandbox = makeSandbox({
      calls: [],
      navigator: { language: "en-US", languages: ["en-US", "en"] },
      capture: async () => ({ ok: false, cancelled: true }),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const lateMod = loadModule(lateSandbox).factory(requireStub);
    const parts = applyAndCapture(lateMod, { locale: undefined });
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    const cameraStub = must(
      view.tree,
      (element) => element.type === "button" && typeof element.props.onClick === "function",
      "no camera button",
    );
    assert.equal(cameraStub.props["aria-label"], "Screenshot", "the English browser must win before any service exists");
    parts.ctx.locale = localeService("zh");
    cameraStub.props.onClick();
    must(
      view.tree,
      (element) => element.props["aria-label"] === "截图",
      "the translator never reached the locale service provided after apply",
    );
  });

  await check("follows an English app rather than forcing Chinese", () => {
    const enSandbox = makeSandbox({
      calls: [],
      capture: async () => ({ ok: false, cancelled: true }),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const enMod = loadModule(enSandbox).factory(requireStub);
    const parts = applyAndCapture(enMod, { locale: localeService("en", { "button.label": "Screenshot" }) });
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(
      view.tree,
      (element) => element.props["aria-label"] === "Screenshot",
      "the active English locale was ignored",
    );
  });

  await check("follows a language switch while the page stays open", () => {
    const switchSandbox = makeSandbox({
      calls: [],
      capture: async () => ({ ok: false, cancelled: true }),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const current = { active: "zh" };
    const switchable = {
      register() {},
      bind() {
        return (key) => key;
      },
      getLocale() {
        return { active: current.active, locales: [{ id: "en" }, { id: "zh" }], revision: 1 };
      },
    };
    const parts = applyAndCapture(loadModule(switchSandbox).factory(requireStub), { locale: switchable });
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(view.tree, (element) => element.props["aria-label"] === "截图", "did not start in Chinese");
    current.active = "en";
    const cameraStub = must(
      view.tree,
      (element) => element.type === "button" && typeof element.props.onClick === "function",
      "no camera button",
    );
    cameraStub.props.onClick();
    must(
      view.tree,
      (element) => element.props["aria-label"] === "Screenshot",
      "did not follow the switch to English",
    );
  });

  await check("a zh-CN browser reads Chinese even with no locale service at all", () => {
    const bareSandbox = makeSandbox({
      calls: [],
      capture: async () => ({ ok: false, cancelled: true }),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const bareMod = loadModule(bareSandbox).factory(requireStub);
    const parts = applyAndCapture(bareMod, { locale: undefined });
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(
      view.tree,
      (element) => element.props["aria-label"] === "截图",
      "the language derived from the browser was ignored",
    );
  });

  await check("requires only react", () => {
    assert.deepEqual(Array.from(new Set(hostRequires)), ["react"]);
  });

  await check("escape closes the open menu", () => {
    const probe = makeSandbox({
      calls: [],
      capture: async () => ({}),
      windows: async () => ({ ok: true, windows: [] }),
    });
    const keydowns = [];
    probe.document.addEventListener = (type, handler) => {
      if (type === "keydown") keydowns.push(handler);
    };
    const probeMod = loadModule(probe).factory(requireStub);
    const parts = applyAndCapture(probeMod);
    const view = mount(parts["conversation.input.left"].component, { inputActions, sessionId: "session-1" });
    must(view.tree, (element) => element.props["aria-label"] === "截图", "no camera button").props.onClick();
    must(view.tree, buttonByText("框选区域"), "the menu did not open");
    assert.ok(keydowns.length > 0, "no keydown listener was installed while the menu was open");
    for (const handler of keydowns) handler({ key: "Escape" });
    assert.equal(find(view.tree, buttonByText("框选区域")), null, "Escape did not close the menu");
  });

  process.stdout.write(`${results.join("\n")}\n`);
  process.stdout.write(process.exitCode === 1 ? "CLIENT-SIM FAIL\n" : "CLIENT-SIM PASS\n");
}

run().catch((error) => {
  process.stdout.write(`${results.join("\n")}\n`);
  process.stdout.write(`CLIENT-SIM FAIL: ${error.stack ?? String(error)}\n`);
  process.exitCode = 1;
});
