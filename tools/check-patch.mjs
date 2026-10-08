/**
 * Pre-flight check for the `desktop` profile: prove that dsh-plugin-manager sees
 * dsh-screenshot-win as an installed, enabled, removable bundle, and that the loader
 * composes exactly one `dsh-screenshot-win` row from the bundle's own patch layer.
 *
 * Usage: node tools/check-patch.mjs [profileDirName]
 */
import path from "node:path";

const DSH_INSTALL = "C:/Users/lsnnn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh";
const DSH_HOME = "C:/Users/lsnnn/.dsh";
const profileName = process.argv[2] ?? "desktop";
const profileDir = path.join(DSH_HOME, "profiles", profileName);
const load = (spec) => import(new URL(`node_modules/@deepseek-ai/${spec}`, `file:///${DSH_INSTALL}/`).href);

const appBoot = await load("dsh-app-boot/lib/index.js");
const { bundleManifest } = await load("dsh-plugin-manager/lib/types/operations.js");

let failures = 0;
const check = (ok, label, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail === "" ? "" : ` — ${detail}`}`);
  if (!ok) failures += 1;
};

/* ---- what dsh-plugin-manager's listBundles() reads to list the plugin ---- */
const profileManifest = appBoot.readProfileManifest("dsh", profileDir);
const dependencies = Object.keys(profileManifest.dependencies ?? {});
const bundles = profileManifest.dsh?.profile?.bundles ?? [];
check(dependencies.includes("dsh-screenshot-win"), "the profile manifest depends on dsh-screenshot-win (installed → removable)");
check(bundles.includes("dsh-screenshot-win"), "the profile selects the bundle (enabled)");

const info = bundleManifest("dsh-screenshot-win", profileDir, DSH_INSTALL);
check(info !== undefined, "the bundle resolves from the profile and declares dsh.bundle.patch");
check(info?.dsh?.bundle?.patch === "./cordis.patch.yml", "the declared patch path", String(info?.dsh?.bundle?.patch));
check(typeof info?.dsh?.client?.platform === "string", "the package declares its client half", String(info?.dsh?.client?.platform));
check(info?.version !== undefined, "the package carries a version", String(info?.version));

/* ---- the layers the loader composes at boot, and the row they produce ---- */
const patches = appBoot.readProfilePatches(
  "dsh",
  {
    home: DSH_HOME,
    dir: profileDir,
    patchPath: path.join(profileDir, "cordis.patch.yml"),
    installAnchor: DSH_INSTALL,
    overlays: [],
    telemetryDisabledEnv: undefined,
  },
  undefined,
);
const inserts = patches.filter(
  (patch) => Array.isArray(patch?.insert) && patch.insert.some((entry) => entry.id === "dsh-screenshot-win"),
);
check(inserts.length === 1, "exactly one layer inserts the plugin row", `found ${inserts.length}`);

const homePatch = appBoot.loadOptionalPatches("dsh", path.join(DSH_HOME, "cordis.patch.yml")) ?? [];
check(homePatch.length === 0, "the home patch layer is empty", JSON.stringify(homePatch));

const rows = appBoot.composeEntries(patches);
const matches = rows.filter((row) => row.id === "dsh-screenshot-win");
check(matches.length === 1, "the composed row list carries the plugin exactly once", `${rows.length} rows total`);
check(matches[0]?.name === "dsh-screenshot-win", "the row names the package", JSON.stringify(matches[0]));

const tail = rows.slice(-3).map((row) => `${row.id} <- ${row.name ?? "(no name)"}`);
console.log(`composed rows: ${rows.length}\n  ${tail.join("\n  ")}`);
console.log(failures === 0 ? "PATCH CHECK PASS" : `PATCH CHECK FAIL (${failures})`);
process.exitCode = failures === 0 ? 0 : 2;
