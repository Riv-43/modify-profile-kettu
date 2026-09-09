(() => {
  const { metro, storage, ui, logger } = vendetta;
  const React = metro.common.React;
  const ReactNative = metro.common.ReactNative;
  const Forms = ui?.components?.Forms;
  const patches = [];

  function getProfiles() {
    if (!storage.profiles) storage.profiles = {};
    return storage.profiles;
  }

  function getTarget(id) {
    return getProfiles()[String(id)] || null;
  }

  function patchMethod(mod, name, wrapper) {
    if (!mod || typeof mod[name] !== "function") return;
    const original = mod[name];
    mod[name] = function (...args) {
      return wrapper.call(this, original, args);
    };
    patches.push(() => { mod[name] = original; });
  }

  function findUserArg(args) {
    for (const a of args) {
      if (a && typeof a === "object" && a.id) return a;
    }
    return null;
  }

  function findUserId(args) {
    const u = findUserArg(args);
    if (u?.id) return String(u.id);
    for (const a of args) {
      if (typeof a === "string" && /^\d{15,22}$/.test(a)) return a;
    }
    return null;
  }

  function applyPatches() {
    try {
      const avatarModule = metro.findByProps("getUserAvatarURL");
      if (avatarModule) {
        patchMethod(avatarModule, "getUserAvatarURL", function (original, args) {
          const id = findUserId(args);
          const ov = id && getTarget(id);
          if (ov?.avatarUrl) return ov.avatarUrl;
          return original.apply(this, args);
        });

        if (typeof avatarModule.getUserAvatarSource === "function") {
          patchMethod(avatarModule, "getUserAvatarSource", function (original, args) {
            const result = original.apply(this, args);
            const id = findUserId(args);
            const ov = id && getTarget(id);
            if (!ov?.avatarUrl) return result;
            if (result && typeof result === "object") return { ...result, uri: ov.avatarUrl };
            return { uri: ov.avatarUrl };
          });
        }
      }
    } catch (e) {
      try { logger.error("Local Profiles avatar patch failed", e); } catch {}
    }

    try {
      const bannerModules = metro.findByPropsAll("getUserBannerURL") || [];
      for (const mod of bannerModules) {
        patchMethod(mod, "getUserBannerURL", function (original, args) {
          const id = findUserId(args);
          const ov = id && getTarget(id);
          if (ov?.bannerUrl) return ov.bannerUrl;
          return original.apply(this, args);
        });
      }
    } catch (e) {
      try { logger.error("Local Profiles banner patch failed", e); } catch {}
    }

    try {
      for (const fn of ["getUserDisplayName", "getDisplayName"]) {
        const mods = metro.findByPropsAll(fn) || [];
        for (const mod of mods) {
          patchMethod(mod, fn, function (original, args) {
            const result = original.apply(this, args);
            const id = findUserId(args);
            const ov = id && getTarget(id);
            return ov?.displayName || result;
          });
        }
      }
    } catch (e) {
      try { logger.error("Local Profiles name patch failed", e); } catch {}
    }
  }

  function Settings() {
    if (!Forms || !ReactNative?.ScrollView) {
      const View = ReactNative?.View;
      const Text = ReactNative?.Text;
      if (!View || !Text) return null;
      return React.createElement(
        View, null,
        React.createElement(Text, null, "Kettu Forms API unavailable on this build.")
      );
    }

    const { FormInput, FormRow, FormDivider } = Forms;
    const profiles = getProfiles();
    if (!storage.editUserId) storage.editUserId = "";

    const id = String(storage.editUserId || "").trim();
    const current = id ? (profiles[id] || {}) : {};

    const saveField = (key, value) => {
      const targetId = String(storage.editUserId || "").trim();
      if (!targetId) return;
      profiles[targetId] = { ...(profiles[targetId] || {}), [key]: value };
    };

    return React.createElement(
      ReactNative.ScrollView,
      null,
      React.createElement(FormRow, { label: "Discord User ID" }),
      React.createElement(FormInput, {
        placeholder: "123456789012345678",
        value: storage.editUserId || "",
        onChange: v => { storage.editUserId = v; }
      }),
      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Local display name" }),
      React.createElement(FormInput, {
        placeholder: "Optional",
        value: current.displayName || "",
        onChange: v => saveField("displayName", v)
      }),
      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Avatar URL" }),
      React.createElement(FormInput, {
        placeholder: "https://...",
        value: current.avatarUrl || "",
        onChange: v => saveField("avatarUrl", v)
      }),
      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Banner URL" }),
      React.createElement(FormInput, {
        placeholder: "https://...",
        value: current.bannerUrl || "",
        onChange: v => saveField("bannerUrl", v)
      }),
      React.createElement(FormRow, {
        label: "Changes are local only. Reload Discord after editing."
      })
    );
  }

  return {
    settings: Settings,
    onLoad() {
      applyPatches();
      try { logger.log("Local Profiles v3 loaded"); } catch {}
    },
    onUnload() {
      while (patches.length) {
        try { patches.pop()(); } catch {}
      }
    }
  };
})()