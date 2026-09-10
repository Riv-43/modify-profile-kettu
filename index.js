(() => {
  const { metro, ui, logger } = vendetta;
  const storage = vendetta.plugin?.storage;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const Forms = ui?.components?.Forms;
  const unpatches = [];

  function patchMethod(mod, key, handler) {
    if (!mod || typeof mod[key] !== "function") return false;
    const original = mod[key];
    mod[key] = function (...args) {
      return handler.call(this, original, args);
    };
    unpatches.push(() => { mod[key] = original; });
    return true;
  }

  function applyAvatarPatch() {
    const TARGET_ID = String(storage?.targetUserId || "");
    const OVERRIDE_URL = String(storage?.imageUrl || "");
    if (!TARGET_ID || !OVERRIDE_URL) return;

    const avatarModule = metro.findByProps("getUserAvatarURL");
    if (!avatarModule) return;

    if (typeof avatarModule.getUserAvatarSource === "function") {
      patchMethod(avatarModule, "getUserAvatarSource", function (original, args) {
        const user = args[0];
        if (user?.id === TARGET_ID) {
          const result = original.apply(this, args);
          if (result && typeof result === "object") return { ...result, uri: OVERRIDE_URL };
          return { uri: OVERRIDE_URL };
        }
        return original.apply(this, args);
      });
    }

    patchMethod(avatarModule, "getUserAvatarURL", function (original, args) {
      const user = args[0];
      if (user?.id === TARGET_ID) return OVERRIDE_URL;
      return original.apply(this, args);
    });
  }

  // Evidence: Picture Links patches ProfileBanner.default and reads bannerSource.uri.
  // Keep this separate from avatar/storage and never mutate a Discord store or user.
  const bannerPatches = [];
  const tracePatches = [];
  let bannerSeen = new WeakSet();
  let traceSeen = new WeakMap();
  let captureTimer;
  let discoveryTimer;
  let capturing = false;
  let report = null;
  let traceCount = 0;

  function attempt(fn, fallback) {
    try { return fn(); } catch { return fallback; }
  }

  function targetId() { return String(storage?.targetUserId || "").trim(); }
  function bannerUrl() { return String(storage?.bannerUrl || "").trim(); }

  function cdnUserId(uri) {
    if (typeof uri !== "string") return null;
    const match = /^https:\/\/(?:cdn|media)\.discordapp\.(?:com|net)\/(?:banners\/(\d+)\/|guilds\/\d+\/users\/(\d+)\/banners\/)/i.exec(uri);
    return match ? (match[1] || match[2]) : null;
  }

  function ownerOf(props) {
    if (!props || typeof props !== "object") return null;
    const explicit = [props.user?.id, props.userId, props.user_id];
    const ids = explicit.filter(id => typeof id === "string" && /^\d+$/.test(id));
    const fromUri = cdnUserId(props.bannerSource?.uri);
    if (fromUri) ids.push(fromUri);
    // Conflicting evidence must never replace another person's banner.
    return ids.length && ids.every(id => id === ids[0]) ? ids[0] : null;
  }

  // Shape only: no raw IDs, URLs, tokens, bios or user objects in the report.
  function shape(value, depth = 0) {
    if (value == null) return String(value);
    if (typeof value === "string") {
      if (value === targetId() && value) return "<target-id>";
      if (/^\d{15,22}$/.test(value)) return "<other-id>";
      if (/^https?:/.test(value)) {
        const id = cdnUserId(value);
        return id ? (id === targetId() ? "<target-banner-url>" : "<other-banner-url>") : "<url>";
      }
      return "string";
    }
    if (typeof value !== "object") return typeof value;
    if (depth >= 2) return Array.isArray(value) ? "array" : "object";
    if (Array.isArray(value)) return value.slice(0, 5).map(v => shape(v, depth + 1));
    const out = {};
    for (const key of Object.keys(value).slice(0, 30)) {
      const d = Object.getOwnPropertyDescriptor(value, key);
      out[key] = d && "value" in d ? shape(d.value, depth + 1) : "<accessor>";
    }
    return out;
  }

  function event(label, args, result, extra) {
    if (!capturing || !report) return;
    attempt(() => {
      const calls = report.calls;
      if (!calls[label]) {
        if (Object.keys(calls).length >= 40) return;
        calls[label] = { count: 0, samples: [] };
      }
      const item = calls[label];
      item.count++;
      if (item.samples.length < 3) {
        item.samples.push({ args: shape(args), result: shape(result), ...extra });
        // Hermes stacks retain bundle offsets even when function bodies are native code.
        if (!item.stack) item.stack = String(new Error().stack || "").split("\n").slice(1, 11).join("\n");
      }
    });
  }

  function initializedModules() {
    const modules = metro.modules;
    if (!modules || typeof modules !== "object") return [];
    const entries = modules instanceof Map ? [...modules.entries()] : Object.entries(modules);
    return entries.filter(([, m]) => m?.isInitialized && !m.hasError && m.publicModule?.exports);
  }

  function describeModule(id, m) {
    const exp = m.publicModule.exports;
    return {
      id: String(id),
      path: m.__filePath || m.path || m.verboseName || null,
      exports: attempt(() => Object.keys(exp).slice(0, 40), []),
      dependencies: Array.isArray(m.dependencyMap) ? m.dependencyMap.slice(0, 60) : null
    };
  }

  function installProfileBanner(parent, key, label) {
    if (!vendetta.patcher?.before || typeof parent?.[key] !== "function") return;
    const fn = parent[key];
    if (bannerSeen.has(fn)) return;
    const undo = vendetta.patcher.before(key, parent, args => {
      // Patch only the incoming props, before React evaluates ProfileBanner's hooks.
      // A missing/ambiguous owner deliberately leaves the original render untouched.
      attempt(() => {
        const props = args[0];
        const owner = ownerOf(props);
        const replace = !!targetId() && owner === targetId() && !!bannerUrl();
        event(label, args, undefined, { owner: owner ? (owner === targetId() ? "target" : "other") : "unknown", replaced: replace });
        if (replace) args[0] = {
          ...props,
          bannerSource: { ...(props.bannerSource || {}), uri: bannerUrl() }
        };
      });
    });
    bannerSeen.add(fn);
    bannerSeen.add(parent[key]);
    bannerPatches.push(undo);
  }

  function traceFunction(parent, key, label) {
    if (!capturing || traceCount >= 24 || !vendetta.patcher?.after) return;
    const seen = traceSeen.get(parent) || new Set();
    if (seen.has(key) || typeof parent?.[key] !== "function") return;
    // Observational only. Original function (including any hooks) runs once as usual.
    const undo = vendetta.patcher.after(key, parent, (args, result) => {
      event(label, args, result);
      // Undefined means no replacement to spitroast.after.
    });
    seen.add(key);
    traceSeen.set(parent, seen);
    tracePatches.push(undo);
    traceCount++;
  }

  function discoverBanners() {
    // Never force-require unknown Metro factories. Revisit lazy modules during capture.
    for (const [id, m] of initializedModules()) attempt(() => {
      const exp = m.publicModule.exports;
      const path = String(m.__filePath || m.path || m.verboseName || "");
      // Do not instrument Flux stores, their methods, or store hooks in store modules.
      if (/store/i.test(path) || typeof exp.getUser === "function" ||
          typeof exp.getState === "function" || typeof exp.default?.getName === "function") return;
      let related = /banner/i.test(path);
      for (const key of Object.keys(exp).slice(0, 100)) attempt(() => {
        const value = exp[key];
        const name = String(value?.displayName || value?.name || value?.type?.name || value?.render?.name || "");
        const isProfileBanner = name === "ProfileBanner" || (key === "default" && /(?:^|\/)ProfileBanner\.[jt]sx?$/.test(path));
        const label = `${id}:${key}:${name || "anonymous"}`;
        if (isProfileBanner) {
          if (typeof value === "function") installProfileBanner(exp, key, label);
          else if (typeof value?.type === "function") installProfileBanner(value, "type", label + ".type");
          else if (typeof value?.render === "function") installProfileBanner(value, "render", label + ".render");
        }
        const bannerSymbol = /banner/i.test(key + " " + name) || /banner/i.test(path);
        if (bannerSymbol) {
          related = true;
          if (capturing && !isProfileBanner && typeof value === "function") traceFunction(exp, key, label);
        }
      });
      if (capturing && related && report.modules.length < 60 && !report.modules.some(x => x.id === String(id))) {
        report.modules.push(describeModule(id, m));
      }
    });
  }

  function stopCapture() {
    clearTimeout(captureTimer);
    clearInterval(discoveryTimer);
    if (capturing) {
      discoverBanners();
      report.finishedAt = new Date().toISOString();
      capturing = false;
      attempt(() => { storage.bannerDiagnostic = JSON.stringify(report, null, 2); });
    }
    while (tracePatches.length) attempt(() => tracePatches.pop()());
    traceSeen = new WeakMap();
    traceCount = 0;
  }

  function startCapture() {
    stopCapture();
    report = { version: 10, startedAt: new Date().toISOString(), expectedBuild: "305.1 / 88876 (user supplied)", moduleRegistryAvailable: !!metro.modules, bannerPatchCount: bannerPatches.length, modules: [], calls: {} };
    capturing = true;
    discoverBanners();
    discoveryTimer = setInterval(() => attempt(discoverBanners), 1000);
    captureTimer = setTimeout(stopCapture, 60000);
  }

  function copyDiagnostic() {
    stopCapture();
    const text = String(storage?.bannerDiagnostic || "No capture yet. Start capture, open the target profile, then copy here.");
    const clipboard = metro.common.clipboard || attempt(() => metro.findByProps("setString", "getString"));
    if (clipboard?.setString) {
      clipboard.setString(text);
      RN.Alert?.alert("Banner diagnostic", "Report copied. Paste it into the conversation.");
    } else RN.Alert?.alert("Banner diagnostic", text);
  }

  function applyBannerPatch() {
    // Preserve the existing helper route, but measure rather than assume its signature.
    const mod = attempt(() => metro.findByProps("getUserBannerURL"));
    if (mod && vendetta.patcher?.after) {
      bannerPatches.push(vendetta.patcher.after("getUserBannerURL", mod, (args, result) => {
        event("getUserBannerURL", args, result);
        if (targetId() && args[0]?.id === targetId() && bannerUrl()) return bannerUrl();
      }));
    }
    const component = attempt(() => metro.findByName("ProfileBanner", false));
    attempt(() => installProfileBanner(component, "default", "ProfileBanner.default"));
    discoverBanners();
  }

  function applyNamePatch() {
    const TARGET_ID = String(storage?.targetUserId || "");
    const LOCAL_NAME = String(storage?.displayName || "");
    if (!TARGET_ID || !LOCAL_NAME) return;

    for (const name of ["getUserDisplayName", "getDisplayName"]) {
      try {
        const mod = metro.findByProps(name);
        if (!mod) continue;

        patchMethod(mod, name, function (original, args) {
          const first = args[0];
          const id = first?.id ? String(first.id) : (typeof first === "string" ? first : null);
          if (id === TARGET_ID) return LOCAL_NAME;
          return original.apply(this, args);
        });
      } catch {}
    }
  }

  function Settings() {
    if (!storage || !Forms || !RN?.ScrollView) return null;
    const { FormInput, FormRow, FormDivider } = Forms;

    const [userId, setUserId] = React.useState(String(storage.targetUserId || ""));
    const [displayName, setDisplayName] = React.useState(String(storage.displayName || ""));
    const [avatarUrl, setAvatarUrl] = React.useState(String(storage.imageUrl || ""));
    const [bannerUrl, setBannerUrl] = React.useState(String(storage.bannerUrl || ""));

    return React.createElement(
      RN.ScrollView,
      {
        keyboardShouldPersistTaps: "handled",
        keyboardDismissMode: "interactive",
        contentContainerStyle: { paddingBottom: 560 }
      },

      React.createElement(FormRow, { label: "Discord User ID" }),
      React.createElement(FormInput, {
        placeholder: "Enter Target User ID",
        value: userId,
        onChange: v => { setUserId(v); storage.targetUserId = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Local display name" }),
      React.createElement(FormInput, {
        placeholder: "Optional",
        value: displayName,
        onChange: v => { setDisplayName(v); storage.displayName = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Avatar URL" }),
      React.createElement(FormInput, {
        placeholder: "Enter image URL",
        value: avatarUrl,
        onChange: v => { setAvatarUrl(v); storage.imageUrl = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Banner URL" }),
      React.createElement(FormInput, {
        placeholder: "Enter banner URL",
        value: bannerUrl,
        onChange: v => { setBannerUrl(v); storage.bannerUrl = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, {
        label: "Saved automatically — v10",
        subLabel: "Reload after avatar/name edits. Close and reopen profiles after banner edits."
      }),
      React.createElement(FormRow, {
        label: "Start banner capture (60 seconds)",
        subLabel: "Start here, then close settings and open the target profile. No stores are modified.",
        onPress: () => { startCapture(); RN.Alert?.alert("Capture started", "Open the target profile, then return here and copy the report."); }
      }),
      React.createElement(FormRow, {
        label: "Stop and copy banner diagnostic",
        subLabel: "Includes module IDs, call counts and redacted prop shapes.",
        onPress: copyDiagnostic
      })
    );
  }

  return {
    settings: Settings,

    onLoad() {
      if (!storage) return;
      applyAvatarPatch();
      attempt(applyBannerPatch);
      applyNamePatch();
      try { logger.log("Local Profiles v10 loaded"); } catch {}
    },

    onUnload() {
      stopCapture();
      while (bannerPatches.length) attempt(() => bannerPatches.pop()());
      bannerSeen = new WeakSet();
      while (unpatches.length) {
        try { unpatches.pop()(); } catch {}
      }
    }
  };
})()
