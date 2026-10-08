// Minimal read-only Electron ASAR reader for inspecting the DSH app shell.
// Usage:
//   node asar.mjs list <innerPathPrefix>            -> list file paths under a prefix
//   node asar.mjs cat <innerPath>                   -> print one file to stdout
//   node asar.mjs grep <regex> [innerPathPrefix]    -> search file contents, print hits
import fs from "node:fs";

const ASAR =
  process.env.DSH_ASAR ??
  "C:\\Users\\lsnnn\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";

function loadIndex() {
  const fd = fs.openSync(ASAR, "r");
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  const headerSize = head.readUInt32LE(12);
  const json = Buffer.alloc(headerSize);
  fs.readSync(fd, json, 0, headerSize, 16);
  const index = JSON.parse(json.toString("utf8").replace(/\0+$/, ""));
  const base = 16 + headerSize;
  return { fd, index, base };
}

function* walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (value.files) yield* walk(value, path, out);
    else out.push([path, value]);
  }
}

function allFiles(index) {
  const out = [];
  for (const [, entry] of walk(index, "", out)) void entry;
  return out;
}

function cat(fd, base, entry) {
  const size = Number(entry.size);
  const offset = base + Number(entry.offset);
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, offset);
  return buf;
}

const [cmd, arg, arg2] = process.argv.slice(2);
const { fd, index, base } = loadIndex();
const files = allFiles(index);

if (cmd === "list") {
  const prefix = arg ?? "";
  for (const [path, entry] of files) {
    if (path.startsWith(prefix)) console.log(`${entry.size}\t${path}`);
  }
} else if (cmd === "cat") {
  const hit = files.find(([path]) => path === arg);
  if (!hit) {
    console.error(`not found: ${arg}`);
    process.exit(2);
  }
  process.stdout.write(cat(fd, base, hit[1]));
} else if (cmd === "grep") {
  const re = new RegExp(arg, "g");
  const prefix = arg2 ?? "";
  for (const [path, entry] of files) {
    if (prefix && !path.startsWith(prefix)) continue;
    if (Number(entry.size) > 8 * 1024 * 1024) continue;
    const text = cat(fd, base, entry).toString("utf8");
    if (!re.test(text)) continue;
    re.lastIndex = 0;
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (re.test(line)) {
        re.lastIndex = 0;
        console.log(`${path}:${i + 1}: ${line.trim().slice(0, 240)}`);
      }
    });
  }
} else {
  console.error("usage: asar.mjs list|cat|grep ...");
  process.exit(1);
}
