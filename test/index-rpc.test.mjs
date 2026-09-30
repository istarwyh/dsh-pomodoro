import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";

// Node 半边需要同时兼容 rc.2 的顶层 helper 与 alpha.2 的 provider 方法。
// 包私有 /pomodoro RPC 只承担 config.read 降级：settings 存在时返回三层
// 解析值，缺席或卸载时退回组合 entry。CI 仍保持零依赖。

const mockModuleUrl = (source) => "data:text/javascript," + encodeURIComponent(source);

const schemasteryMock = `
const field = (check, typeName) => ({
  typeName,
  minValue: -Infinity,
  maxValue: Infinity,
  defaultValue: undefined,
  min(n) { this.minValue = n; return this; },
  max(n) { this.maxValue = n; return this; },
  default(v) { this.defaultValue = v; return this; },
  validate(value, path) {
    if (!check(value)) throw new TypeError(path + " expected " + typeName + " but got " + JSON.stringify(value));
    if (value < this.minValue) throw new TypeError(path + " expected number >= " + this.minValue + " but got " + value);
    if (value > this.maxValue) throw new TypeError(path + " expected number <= " + this.maxValue + " but got " + value);
  },
});
export default {
  object(shape) {
    const schema = (value) => {
      if (value === undefined || value === null) value = {};
      if (typeof value !== "object" || Array.isArray(value)) throw new TypeError("expected object");
      const out = {};
      for (const [key, entry] of Object.entries(shape)) {
        const raw = Object.prototype.hasOwnProperty.call(value, key) ? value[key] : entry.defaultValue;
        if (raw === undefined) throw new TypeError("$." + key + " is required");
        entry.validate(raw, "$." + key);
        out[key] = raw;
      }
      return out;
    };
    schema.volatile = () => schema;
    return schema;
  },
  natural: () => field((v) => Number.isSafeInteger(v) && v >= 0, "natural"),
  boolean: () => field((v) => typeof v === "boolean", "boolean"),
};
`;

const legacySettingsMock = `
export const settingsNamespace = (name) => name;
export function installSettingsSection(ctx, ns, schema, entry, hooks) {
  ctx.inject(["settings"], (settingsCtx) => {
    const scope = settingsCtx.settings.register(ns, schema, { base: entry });
    hooks.setSource(() => scope.get());
    settingsCtx.effect(() => () => {
      hooks.setSource(() => entry);
      hooks.onChange();
    });
    hooks.onChange();
    scope.watch(() => hooks.onChange());
  });
}
`;

// alpha.2 不再导出 settingsNamespace / installSettingsSection。插件若恢复具名导入，
// 这里会在测试模块加载阶段复现真实宿主的 SyntaxError。
const alphaSettingsMock = `
export class SettingsProvider {}
`;

const modernSettingsMock = `
export class SettingsForms {}
`;

const dependencyHooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@deepseek-ai/schemastery") {
      return { url: mockModuleUrl(schemasteryMock), shortCircuit: true };
    }
    if (specifier === "@deepseek-ai/dsh-settings") {
      const source = context.parentURL?.includes("settings-api=modern")
        ? modernSettingsMock
        : context.parentURL?.includes("settings-api=alpha")
          ? alphaSettingsMock
          : legacySettingsMock;
      return { url: mockModuleUrl(source), shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const legacyApi = await import("../lib/index.js?settings-api=legacy");
const alphaApi = await import("../lib/index.js?settings-api=alpha");
const modernApi = await import("../lib/index.js?settings-api=modern");
dependencyHooks.deregister();

function createSettingsProvider(Config, initial = {}) {
  let current = Config(initial);
  const watchers = new Set();
  const provider = {
    registrations: [],
    installations: [],
    effect: undefined,
    register(ns, schema, options) {
      provider.registrations.push({ ns, schema, options });
      return {
        get: () => current,
        watch(listener) {
          watchers.add(listener);
          return () => watchers.delete(listener);
        },
      };
    },
    installSection(owner, ns, schema, entry, hooks) {
      provider.installations.push({ owner, ns, schema, entry, hooks });
      const scope = provider.register(ns, schema, { base: entry });
      hooks.setSource(() => scope.get());
      provider.effect(() => () => {
        hooks.setSource(() => entry);
        hooks.onChange();
      });
      hooks.onChange();
      scope.watch(() => hooks.onChange());
    },
    publish(next) {
      current = Config(next);
      for (const watcher of watchers) watcher();
    },
  };
  return provider;
}

function createContext({ provider, fetchRoutes = false } = {}) {
  const captured = { rpc: new Map(), effects: [], injected: [], fetchRoutes: [] };
  const ctx = {
    fiber: { id: "pomodoro" },
    connection: {
      rpc: {
        handle(path, handler, options) {
          captured.rpc.set(path, { handler, options });
        },
      },
      ...(fetchRoutes
        ? {
            fetch: {
              register(route) {
                captured.fetchRoutes.push(route);
                return () => {};
              },
            },
          }
        : {}),
    },
    inject(deps, install) {
      captured.injected.push(deps);
      if (provider !== undefined) {
        const settingsCtx = {
          settings: provider,
          effect(setup) {
            captured.effects.push(setup);
          },
        };
        provider.effect = settingsCtx.effect;
        install(settingsCtx);
      }
    },
    effect(setup) {
      captured.effects.push(setup);
      const dispose = setup();
      return typeof dispose === "function" ? dispose : () => {};
    },
  };
  return { ctx, captured };
}

function createModernSettingsProvider() {
  return {
    configurations: [],
    configure(policy, owner) {
      this.configurations.push({ policy, owner });
      return () => {};
    },
  };
}

function rpcOf(captured) {
  const entry = captured.rpc.get("/pomodoro");
  assert.ok(entry, "/pomodoro RPC 应已注册");
  return entry.handler;
}

for (const [host, api] of [
  ["rc.2 helper API", legacyApi],
  ["alpha.2 provider API", alphaApi],
]) {
  const { apply, Config, SETTINGS_NAMESPACE, inject } = api;

  test(`${host}：模块 inject 只声明 connection`, () => {
    // 降级通道经 connection 服务注册；fetch 路由不需要 webServer 注入
    //（0.1.5 起 rpc.handle 从插件纤维不可用，与插件侧 inject 声明无关）。
    assert.deepEqual(inject, ["connection"]);
  });

  test(`${host}：RPC 注册契约`, () => {
    const { ctx, captured } = createContext();
    apply(ctx, {});
    const entry = captured.rpc.get("/pomodoro");
    assert.ok(entry);
    assert.equal(typeof entry.handler, "function");
    assert.deepEqual(entry.options, { authority: "loopback" });
    assert.deepEqual(captured.injected, [["settings"]]);
  });

  test(`${host}：fetch 路由可用时不再注册 rpc 通道`, async () => {
    // 0.1.2+ 宿主提供 connection.fetch；此时降级通道走 GET /api/pomodoro/config，
    // 老宿主的 /pomodoro RPC 保持不注册。
    const { ctx, captured } = createContext({ fetchRoutes: true });
    apply(ctx, { focusMinutes: 40 });
    assert.equal(captured.rpc.size, 0, "fetch 可用时不应注册 rpc 通道");
    assert.equal(captured.fetchRoutes.length, 1);
    const route = captured.fetchRoutes[0];
    assert.equal(route.path, "/api/pomodoro/config");
    assert.deepEqual(route.methods, ["GET"]);
    const response = await route.fetch();
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { ok: true, value: Config({ focusMinutes: 40 }) });
  });

  test(`${host}：namespace、Config 与组合 entry 作为 base`, () => {
    const provider = createSettingsProvider(Config);
    const { ctx } = createContext({ provider });
    apply(ctx, { focusMinutes: 45 });
    assert.equal(provider.registrations.length, 1);
    assert.equal(provider.registrations[0].ns, SETTINGS_NAMESPACE);
    assert.equal(provider.registrations[0].schema, Config);
    assert.deepEqual(provider.registrations[0].options, { base: Config({ focusMinutes: 45 }) });
    if (host.startsWith("alpha")) {
      assert.equal(provider.installations.length, 1);
      assert.equal(provider.installations[0].owner, ctx);
    } else {
      assert.equal(provider.installations.length, 0);
    }
  });

  test(`${host}：settings 缺席时返回组合 entry`, async () => {
    const { ctx, captured } = createContext();
    apply(ctx, { focusMinutes: 40, autoStartBreaks: false });
    const result = await rpcOf(captured)("config.read", undefined);
    assert.deepEqual(result, {
      ok: true,
      value: Config({ focusMinutes: 40, autoStartBreaks: false }),
    });
  });

  test(`${host}：settings 就绪时返回分层解析值并跟随更新`, async () => {
    const provider = createSettingsProvider(Config, { focusMinutes: 50 });
    const { ctx, captured } = createContext({ provider });
    apply(ctx, { focusMinutes: 40 });
    const rpc = rpcOf(captured);
    assert.equal((await rpc("config.read", {})).value.focusMinutes, 50);
    provider.publish({ focusMinutes: 55, completionSound: true });
    const updated = await rpc("config.read", {});
    assert.equal(updated.value.focusMinutes, 55);
    assert.equal(updated.value.completionSound, true);
  });

  test(`${host}：settings 子 fiber 卸载后回退组合 entry`, async () => {
    const provider = createSettingsProvider(Config, { focusMinutes: 50 });
    const { ctx, captured } = createContext({ provider });
    apply(ctx, { focusMinutes: 35 });
    assert.equal((await rpcOf(captured)("config.read", {})).value.focusMinutes, 50);
    const cleanup = captured.effects[0]();
    cleanup();
    assert.equal((await rpcOf(captured)("config.read", {})).value.focusMinutes, 35);
  });

  test(`${host}：config.read 返回副本`, async () => {
    const { ctx, captured } = createContext();
    apply(ctx, { focusMinutes: 40 });
    const rpc = rpcOf(captured);
    const first = await rpc("config.read", {});
    first.value.focusMinutes = 99;
    assert.equal((await rpc("config.read", {})).value.focusMinutes, 40);
  });

  test(`${host}：未知端点直接抛错`, async () => {
    const { ctx, captured } = createContext();
    apply(ctx, {});
    await assert.rejects(() => rpcOf(captured)("settings.save", {}), /未知端点/);
  });
}

test("0.1.7 forms API：使用 Loader volatile Config 并关闭重复自动表单", async () => {
  const provider = createModernSettingsProvider();
  let current = { focusMinutes: 45, autoStartFocus: true };
  const config = { get: () => current };
  const { ctx, captured } = createContext({ provider, fetchRoutes: true });

  modernApi.apply(ctx, config);
  assert.deepEqual(captured.injected, [["settings"]]);
  assert.equal(captured.effects.length, 2, "配置策略与 fetch route 都应注册为 effect");
  const disposePolicy = captured.effects[0]();
  assert.deepEqual(provider.configurations, [{ policy: { auto: false }, owner: ctx.fiber }]);
  assert.equal(typeof disposePolicy, "function");

  const route = captured.fetchRoutes[0];
  const initial = await route.fetch();
  assert.deepEqual(await initial.json(), {
    ok: true,
    value: modernApi.Config({ focusMinutes: 45, autoStartFocus: true }),
  });
  current = { focusMinutes: 55, completionSound: true };
  const updated = await (await route.fetch()).json();
  assert.equal(updated.value.focusMinutes, 55);
  assert.equal(updated.value.completionSound, true);
});
