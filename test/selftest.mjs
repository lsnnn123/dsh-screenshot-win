/**
 * Self-test: load the node half with a fake plugin context and validate what it registers.
 *
 * `defineTool` compiles both schema specs eagerly (parameterSchemaSpecToJsonSchema /
 * valueSchemaSpecToJsonSchema), so a successful apply() already proves the authored specs
 * are legal. What is left to check is the compiled result and the runtime surface.
 *
 *   node test/selftest.mjs
 */
import { assertSupportedJsonSchema, validateJsonSchemaValue } from "@deepseek-ai/dsh-tools";

const mod = await import("../lib/index.js");
const failures = [];

const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL ${label}${detail === undefined ? "" : ` — ${detail}`}`);
  }
};

console.log("module surface");
check("name", mod.name === "dsh-screenshot-win", String(mod.name));
check("apply is a function", typeof mod.apply === "function");
check("inject is an array", Array.isArray(mod.inject));
check("Config is present", mod.Config !== undefined);

const config = mod.Config !== undefined && typeof mod.Config === "function" ? mod.Config({}) : {};
console.log("resolved config:", JSON.stringify(config));
check("default saveDir", config.saveDir === "screenshots", String(config.saveDir));
check("default maxWidth", config.maxWidth === 1600, String(config.maxWidth));

const tools = [];
const routes = [];
const fakeServer = {
  register(route) {
    routes.push(route);
    return () => {};
  },
};
const fakeCtx = {
  tools: {
    register(definition) {
      tools.push(definition);
      return () => {};
    },
  },
  webServer: fakeServer,
  effect(fn) {
    fn();
    return () => {};
  },
  get() {
    return undefined;
  },
};

mod.apply({ get: (key) => (key === "webServer" ? fakeServer : undefined), inject: (_deps, callback) => callback(fakeCtx) }, config);

console.log("registrations");
check("one tool registered", tools.length === 1, `got ${tools.length}`);
check("one route registered", routes.length === 1, `got ${routes.length}`);
check("route kind is prefix", routes[0]?.kind === "prefix", JSON.stringify(routes[0]?.kind));
check("route path", routes[0]?.path === "/dsh-screenshot-win", JSON.stringify(routes[0]?.path));

const tool = tools[0];
if (tool !== undefined) {
  check("tool name", tool.name === "screenshot", String(tool.name));
  check("description is prose", typeof tool.description === "string" && tool.description.length > 80);
  check("execute is a function", typeof tool.execute === "function");
  check("render is a function", typeof tool.output?.render === "function");
  check("serialized (never concurrency-safe)", tool.isConcurrencySafe({}) === false);
  check("presentCall(view)", tool.presentCall({ mode: "region" })?.card === "generic");

  console.log("compiled schemas");
  check("parameters are a compiled object root", tool.parameters?.type === "object" && typeof tool.parameters.properties === "object");
  const parameterNames = Object.keys(tool.parameters.properties ?? {});
  console.log(`  parameters (${parameterNames.length}): ${parameterNames.join(", ")}`);
  check("no stray parameters", parameterNames.every((name) => /^[a-z_]+$/.test(name)), parameterNames.join(","));
  // Every parameter is deliberately optional: `screenshot()` with no arguments is the
  // one-call path (interactive region capture into the workspace).
  check("no parameter is required", (tool.parameters.required ?? []).length === 0, JSON.stringify(tool.parameters.required));
  check("save_path stays optional", !(tool.parameters.required ?? []).includes("save_path"));

  try {
    assertSupportedJsonSchema(tool.parameters);
    check("parameters pass the raw-schema boundary", true);
  } catch (error) {
    check("parameters pass the raw-schema boundary", false, String(error));
  }
  try {
    assertSupportedJsonSchema(tool.output.schema);
    check("output passes the raw-schema boundary", true);
  } catch (error) {
    check("output passes the raw-schema boundary", false, String(error));
  }

  console.log("argument validation");
  const good = validateJsonSchemaValue(tool.parameters, { mode: "region", hwnd: 1234 }, "args");
  check("valid arguments accepted", good.length === 0, JSON.stringify(good));
  const badType = validateJsonSchemaValue(tool.parameters, { hwnd: "not-a-number" }, "args");
  check("wrong type rejected", badType.length > 0, JSON.stringify(badType));
  const unknown = validateJsonSchemaValue(tool.parameters, { nonsense: 1 }, "args");
  console.log(`  unknown property violations: ${JSON.stringify(unknown)}`);

  console.log("output value validation");
  const value = { path: "E:\\x\\shot.png", mode: "region", width: 800, height: 600, bytes: 1234 };
  const okValue = validateJsonSchemaValue(tool.output.schema, value, "value");
  check("a real capture value validates", okValue.length === 0, JSON.stringify(okValue));
  const withImage = { ...value, image: { attachmentId: "a".repeat(64), mediaType: "image/png", bytes: 1234, width: 800, height: 600, name: "shot.png" } };
  check("an attached-image value validates", validateJsonSchemaValue(tool.output.schema, withImage, "value").length === 0);
  check("a partial value is rejected", validateJsonSchemaValue(tool.output.schema, { path: "x" }, "value").length > 0);

  console.log("render");
  const parts = tool.output.render({}, withImage);
  check("render emits text + image", Array.isArray(parts) && parts.length === 2 && parts[0].type === "text" && parts[1].type === "image" && parts[1].attachment === withImage.image, JSON.stringify(parts).slice(0, 160));
  const noImage = tool.output.render({}, value);
  check("render emits text only without an image", noImage.length === 1 && noImage[0].type === "text");
}

console.log(failures.length === 0 ? "\nSELFTEST PASS" : `\nSELFTEST FAIL (${failures.length}): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
