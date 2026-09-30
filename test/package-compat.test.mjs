import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const clientSource = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
const bundlePatch = await readFile(new URL("../cordis.patch.yml", import.meta.url), "utf8");

test("客户端声明同时覆盖 rc.2 runtime 与 alpha.2 renderer", () => {
  const inject = manifest.dsh?.client?.inject;
  assert.ok(Array.isArray(inject));
  assert.ok(inject.includes("@deepseek-ai/dsh-client-runtime"));
  assert.ok(inject.includes("@deepseek-ai/dsh-client-ui-renderer"));
});

test("设置服务不再是客户端硬依赖，0.1.7 Loader row 与旧 namespace 对齐", () => {
  assert.match(clientSource, /exports\.inject = \["timer", "slots", "locale", "connection"\]/);
  assert.doesNotMatch(clientSource, /exports\.inject = \[[^\]]*"settingsScope"/);
  assert.match(bundlePatch, /- id: dsh-pomodoro\n\s+name: "@xiaohui-wang\/dsh-pomodoro"/);
});

test("客户端模块使用 npm 包名注册，同时保留稳定的内部 namespace", () => {
  const escapedPackageName = manifest.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(clientSource, new RegExp(`window\\.__ModuleLoader__\\.load\\(\\{\\s*[^}]*id: ["']${escapedPackageName}["']`, "s"));
  assert.match(clientSource, /const POMODORO_LOCALE_NS = "dsh-pomodoro"/);
  assert.match(clientSource, /const POMODORO_ROW_CONFIG_KEY = "dsh-pomodoro#dsh-pomodoro"/);
});

test("侧栏底部入口纵向累加，并分别适配展开态与收起态", () => {
  assert.match(clientSource, /:where\(\*:has\(> \.pomo-toggle\), \*:has\(> \* > \.pomo-toggle\)\) \{ flex-direction: column; align-items: stretch; \}/);
  assert.match(clientSource, /className: "pomo-toggle " \+ \(props\.wide \? "pomo-toggle-wide" : "pomo-toggle-rail"\)/);
  assert.match(clientSource, /\.pomo-toggle-wide \{ width: 100%; min-height: 42px;/);
  assert.match(clientSource, /\.pomo-toggle-rail \{ justify-content: center; width: 36px; height: 36px;/);
});

test("peer 只保留直接使用的 Host 公共契约，并覆盖历次适配的 settings 版本", () => {
  assert.deepEqual(manifest.peerDependencies, {
    "@deepseek-ai/cordis": "^4.0.1",
    "@deepseek-ai/dsh-settings": "^0.1.0-rc.7 || ^0.1.1-rc.1 || ^0.1.2-alpha.2 || ^0.1.5-0 || ^0.1.7-0",
  });
  assert.equal(manifest.dependencies["@deepseek-ai/schemastery"], "^3.18.4");
});

test("兼容修复使用 patch 版本发布", () => {
  assert.equal(manifest.version, "0.5.5");
});
