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
    report = { version: 12, startedAt: new Date().toISOString(), expectedBuild: "305.1 / 88876 (user supplied)", moduleRegistryAvailable: !!metro.modules, bannerPatchCount: bannerPatches.length, modules: [], calls: {} };
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

  // Source: nexp id's Song Spotlight patches these exact profile components.
  // Render our own local text, without cloning a class instance or changing a store.
  const bioPatches = [];
  const bioTargets = [];
  const bioStats = { calls: 0, replacements: 0 };

  function bioOwner(props) {
    const candidates = [props?.userId, props?.user?.id, props?.displayProfile?.userId];
    const ids = candidates.filter(id => typeof id === "string" && /^\d+$/.test(id));
    return ids.length && ids.every(id => id === ids[0]) ? ids[0] : null;
  }

  function LocalBio({ text, style }) {
    return React.createElement(RN.View, {
      style: [style, { padding: 16, borderRadius: 12, backgroundColor: "#232428" }]
    },
      React.createElement(RN.Text, {
        style: { color: "#b5bac1", fontSize: 12, fontWeight: "700", marginBottom: 8 }
      }, "À PROPOS DE MOI"),
      React.createElement(RN.Text, {
        selectable: true,
        style: { color: "#f2f3f5", fontSize: 14, lineHeight: 20 }
      }, text)
    );
  }

  function applyBioPatch() {
    if (!vendetta.patcher?.after) return;
    for (const name of ["UserProfileBio", "UserProfileAboutMeCard"]) attempt(() => {
      const mod = metro.findByName(name, false);
      let parent = mod;
      let key = "default";
      if (typeof mod?.default !== "function") {
        if (typeof mod?.default?.type === "function") { parent = mod.default; key = "type"; }
        else if (typeof mod?.default?.render === "function") { parent = mod.default; key = "render"; }
        else return;
      }
      const undo = vendetta.patcher.after(key, parent, (args, result) => {
        // The original component has already run its hooks exactly once.
        // Returning undefined leaves its normal output entirely unchanged.
        bioStats.calls++;
        const owner = attempt(() => bioOwner(args[0]));
        const replace = !!storage?.bioEnabled && !!targetId() && owner === targetId();
        event(name, args, result, { replaced: replace });
        if (!replace) return;
        bioStats.replacements++;
        const text = String(storage.bioText ?? "");
        // Explicitly enabled + empty text hides the bio. Disabling restores Discord's bio.
        if (!text) return null;
        return React.createElement(LocalBio, { text, style: args[0]?.style });
      });
      bioPatches.push(undo);
      bioTargets.push(name);
    });
  }

  // Proven read selectors: CustomRPC reads PresenceStore.getStatus(userId)
  // and getActivities(userId).find(activity => activity.type === 4).
  // Never patch UserStore, dispatch presence events, or mutate store state.
  const presenceLabels = { "": "Originale", online: "En ligne", idle: "Inactif", dnd: "Ne pas déranger", offline: "Hors ligne" };
  const statusPatches = [];
  const statusStats = { found: [], calls: {}, replacements: {}, unsupportedActivities: 0 };
  let activitiesCache = new WeakMap();
  let activitiesConfig = "";
  const emptyActivitiesKey = {};

  function configuredPresence() {
    const value = String(storage?.localPresence || "");
    return Object.prototype.hasOwnProperty.call(presenceLabels, value) ? value : "";
  }

  function localActivity() {
    const text = String(storage?.customStatusText ?? "");
    const emojiText = String(storage?.customStatusEmoji ?? "").trim();
    if (!text && !emojiText) return null;
    const activity = { id: "custom", name: "Custom Status", type: 4, state: text, label: text, flags: 0 };
    if (emojiText) activity.emoji = { name: emojiText };
    return activity;
  }

  function overrideActivities(original) {
    if (original != null && !Array.isArray(original)) {
      statusStats.unsupportedActivities++;
      return original;
    }
    const config = JSON.stringify([targetId(), storage.customStatusText ?? "", storage.customStatusEmoji ?? ""]);
    if (config !== activitiesConfig) {
      activitiesCache = new WeakMap();
      activitiesConfig = config;
    }
    const input = original || [];
    const key = original || emptyActivitiesKey;
    const cached = activitiesCache.get(key);
    // Detect in-place array edits too; preserve activity objects for games/Spotify.
    if (cached && cached.input.length === input.length && cached.input.every((v, i) => v === input[i])) return cached.output;
    const custom = localActivity();
    const output = [];
    let inserted = false;
    for (const activity of input) {
      if (activity?.type === 4) {
        if (custom && !inserted) { output.push(custom); inserted = true; }
      } else output.push(activity);
    }
    if (custom && !inserted) output.push(custom);
    activitiesCache.set(key, { input: input.slice(), output });
    return output;
  }

  function applyStatusPatches() {
    if (!vendetta.patcher?.after || typeof metro.findByStoreName !== "function") return;
    const presenceStore = metro.findByStoreName("PresenceStore");
    for (const method of ["getStatus", "getActivities"]) attempt(() => {
      if (typeof presenceStore?.[method] !== "function") return;
      statusStats.calls[method] = 0;
      statusStats.replacements[method] = 0;
      const undo = vendetta.patcher.after(method, presenceStore, (args, result) => {
        // All other users receive the exact original reference/value.
        if (!targetId() || args[0] !== targetId()) return;
        statusStats.calls[method]++;
        const enabled = method === "getStatus" ? !!configuredPresence() : !!storage.customStatusEnabled;
        event(`PresenceStore.${method}`, args, result, { overrideEnabled: enabled });
        if (!enabled) return;
        const next = method === "getStatus" ? configuredPresence() : overrideActivities(result);
        if (next !== result) statusStats.replacements[method]++;
        return next;
      });
      statusPatches.push(undo);
      statusStats.found.push(method);
    });
  }

  function Settings() {
    if (!storage || !Forms || !RN?.ScrollView) return null;
    const { FormInput, FormRow, FormDivider } = Forms;

    const [userId, setUserId] = React.useState(String(storage.targetUserId || ""));
    const [displayName, setDisplayName] = React.useState(String(storage.displayName || ""));
    const [avatarUrl, setAvatarUrl] = React.useState(String(storage.imageUrl || ""));
    const [bannerUrl, setBannerUrl] = React.useState(String(storage.bannerUrl || ""));
    const [bioText, setBioText] = React.useState(String(storage.bioText ?? ""));
    const [bioEnabled, setBioEnabled] = React.useState(!!storage.bioEnabled);
    const [presence, setPresence] = React.useState(configuredPresence());
    const [statusEnabled, setStatusEnabled] = React.useState(!!storage.customStatusEnabled);
    const [statusText, setStatusText] = React.useState(String(storage.customStatusText ?? ""));
    const [statusEmoji, setStatusEmoji] = React.useState(String(storage.customStatusEmoji ?? ""));

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
        label: bioEnabled ? "Bio locale : activée" : "Bio locale : désactivée",
        subLabel: "Toucher pour activer/désactiver. Visible uniquement sur cet appareil.",
        onPress: () => { const next = !bioEnabled; setBioEnabled(next); storage.bioEnabled = next; }
      }),
      React.createElement(FormInput, {
        placeholder: "Écris la bio locale ici…",
        value: bioText,
        multiline: true,
        numberOfLines: 5,
        onChange: v => { setBioText(v); storage.bioText = v; }
      }),
      React.createElement(FormRow, {
        label: "Bio enregistrée automatiquement",
        subLabel: "Ferme puis rouvre le profil. Une bio vide et activée masque la bio originale. Texte simple, sans mise en forme Markdown."
      }),
      React.createElement(FormRow, {
        label: "État de la bio",
        subLabel: "Toucher pour vérifier si le composant est trouvé et appelé.",
        onPress: () => RN.Alert?.alert("Diagnostic bio", bioTargets.length
          ? `${bioTargets.join(", ")}\nAppels : ${bioStats.calls}\nRemplacements : ${bioStats.replacements}`
          : "Aucun des composants connus n’a été trouvé dans cette version de Discord.")
      }),
      React.createElement(FormDivider),
      React.createElement(FormRow, {
        label: `Présence locale : ${presenceLabels[presence]}`,
        subLabel: "Toucher pour passer à : originale → en ligne → inactif → ne pas déranger → hors ligne.",
        onPress: () => {
          const values = ["", "online", "idle", "dnd", "offline"];
          const next = values[(values.indexOf(configuredPresence()) + 1) % values.length];
          storage.localPresence = next;
          setPresence(next);
        }
      }),
      React.createElement(FormRow, {
        label: statusEnabled ? "Statut personnalisé local : activé" : "Statut personnalisé local : désactivé",
        subLabel: "Toucher pour activer/désactiver le texte et l’emoji ci-dessous.",
        onPress: () => { const next = !storage.customStatusEnabled; storage.customStatusEnabled = next; setStatusEnabled(next); }
      }),
      React.createElement(FormInput, {
        placeholder: "Texte du statut personnalisé",
        value: statusText,
        onChange: v => { setStatusText(v); storage.customStatusText = v; }
      }),
      React.createElement(FormInput, {
        placeholder: "Emoji du clavier, par exemple 💙",
        value: statusEmoji,
        onChange: v => { setStatusEmoji(v); storage.customStatusEmoji = v; }
      }),
      React.createElement(FormRow, {
        label: "Présence et statut enregistrés automatiquement",
        subLabel: "Rouvre le profil pour actualiser. Originale/désactivé rétablit l’affichage réel. Un statut activé avec deux champs vides masque le statut personnalisé."
      }),
      React.createElement(FormRow, {
        label: "État du statut et de la présence",
        subLabel: "Si rien ne change, ouvre le profil puis touche ici et envoie une capture.",
        onPress: () => RN.Alert?.alert("Diagnostic statut / présence", statusStats.found.length
          ? statusStats.found.map(name => `${name} : ${statusStats.calls[name]} appels ciblés, ${statusStats.replacements[name]} remplacements`).join("\n") + `\nFormats d’activités non reconnus : ${statusStats.unsupportedActivities}`
          : "PresenceStore ou ses méthodes de lecture n’ont pas été trouvés dans cette version de Discord.")
      }),
      React.createElement(FormDivider),
      React.createElement(FormRow, {
        label: "Saved automatically — v12",
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
      attempt(applyBioPatch);
      attempt(applyStatusPatches);
      applyNamePatch();
      try { logger.log("Local Profiles v12 loaded"); } catch {}
    },

    onUnload() {
      stopCapture();
      while (statusPatches.length) attempt(() => statusPatches.pop()());
      statusStats.found.length = 0;
      activitiesCache = new WeakMap();
      activitiesConfig = "";
      while (bioPatches.length) attempt(() => bioPatches.pop()());
      bioTargets.length = 0;
      while (bannerPatches.length) attempt(() => bannerPatches.pop()());
      bannerSeen = new WeakSet();
      while (unpatches.length) {
        try { unpatches.pop()(); } catch {}
      }
    }
  };
})()
