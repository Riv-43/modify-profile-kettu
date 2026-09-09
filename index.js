(() => {
  const { metro, storage, ui, logger } = vendetta;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const Forms = ui?.components?.Forms;
  const unpatches = [];

  function readProfiles() {
    try {
      const raw = storage.localProfilesJSON;
      if (!raw) return {};
      const value = JSON.parse(raw);
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function writeProfiles(value) {
    storage.localProfilesJSON = JSON.stringify(value);
  }

  function getOverride(id) {
    return id ? readProfiles()[String(id)] || null : null;
  }

  function findId(args) {
    for (const arg of args) {
      if (arg && typeof arg === "object" && arg.id) return String(arg.id);
    }
    for (const arg of args) {
      if (typeof arg === "string" && /^\d{15,22}$/.test(arg)) return arg;
    }
    return null;
  }

  function replaceMethod(mod, key, fn) {
    if (!mod || typeof mod[key] !== "function") return;
    const original = mod[key];
    mod[key] = function (...args) {
      return fn.call(this, original, args);
    };
    unpatches.push(() => { mod[key] = original; });
  }

  function applyAvatarPatch() {
    const avatarModule = metro.findByProps("getUserAvatarURL");
    if (!avatarModule) return;

    if (typeof avatarModule.getUserAvatarSource === "function") {
      replaceMethod(avatarModule, "getUserAvatarSource", function (original, args) {
        const result = original.apply(this, args);
        const ov = getOverride(findId(args));
        if (!ov?.avatarUrl) return result;
        return result && typeof result === "object"
          ? { ...result, uri: ov.avatarUrl }
          : { uri: ov.avatarUrl };
      });
    }

    replaceMethod(avatarModule, "getUserAvatarURL", function (original, args) {
      const ov = getOverride(findId(args));
      return ov?.avatarUrl || original.apply(this, args);
    });
  }

  function applyBannerPatches() {
    const names = [
      "getUserBannerURL",
      "getUserBannerUrl",
      "getBannerURL",
      "getBannerUrl",
      "getUserBannerSource"
    ];

    for (const name of names) {
      try {
        const mods = metro.findByPropsAll(name) || [];
        for (const mod of mods) {
          replaceMethod(mod, name, function (original, args) {
            const result = original.apply(this, args);
            const ov = getOverride(findId(args));
            if (!ov?.bannerUrl) return result;

            if (name.toLowerCase().includes("source")) {
              return result && typeof result === "object"
                ? { ...result, uri: ov.bannerUrl }
                : { uri: ov.bannerUrl };
            }
            return ov.bannerUrl;
          });
        }
      } catch {}
    }
  }

  function applyNamePatches() {
    for (const name of ["getUserDisplayName", "getDisplayName"]) {
      try {
        const mods = metro.findByPropsAll(name) || [];
        for (const mod of mods) {
          replaceMethod(mod, name, function (original, args) {
            const result = original.apply(this, args);
            const ov = getOverride(findId(args));
            return ov?.displayName || result;
          });
        }
      } catch {}
    }
  }

  function Settings() {
    if (!Forms || !RN?.ScrollView) return null;
    const { FormInput, FormRow, FormDivider } = Forms;

    const [userId, setUserId] = React.useState(String(storage.lastLocalProfileId || ""));
    const [displayName, setDisplayName] = React.useState("");
    const [avatarUrl, setAvatarUrl] = React.useState("");
    const [bannerUrl, setBannerUrl] = React.useState("");
    const [status, setStatus] = React.useState("");

    const load = idValue => {
      const id = String(idValue || "").trim();
      if (!/^\d{15,22}$/.test(id)) return;
      const p = readProfiles()[id];
      if (!p) return;
      setDisplayName(p.displayName || "");
      setAvatarUrl(p.avatarUrl || "");
      setBannerUrl(p.bannerUrl || "");
      setStatus("Saved profile loaded.");
    };

    React.useEffect(() => {
      if (userId) load(userId);
    }, []);

    const save = () => {
      const id = String(userId || "").trim();
      if (!/^\d{15,22}$/.test(id)) {
        setStatus("Invalid Discord user ID.");
        return;
      }

      const all = readProfiles();
      all[id] = {
        displayName: String(displayName || "").trim(),
        avatarUrl: String(avatarUrl || "").trim(),
        bannerUrl: String(bannerUrl || "").trim()
      };

      writeProfiles(all);
      storage.lastLocalProfileId = id;
      setStatus("Saved permanently. Reload Discord to apply.");
    };

    const remove = () => {
      const id = String(userId || "").trim();
      const all = readProfiles();
      delete all[id];
      writeProfiles(all);
      setDisplayName("");
      setAvatarUrl("");
      setBannerUrl("");
      setStatus("Override removed.");
    };

    return React.createElement(
      RN.ScrollView,
      {
        keyboardShouldPersistTaps: "handled",
        keyboardDismissMode: "interactive",
        contentContainerStyle: { paddingBottom: 520 }
      },

      React.createElement(FormRow, { label: "Discord User ID" }),
      React.createElement(FormInput, {
        placeholder: "123456789012345678",
        value: userId,
        onChange: v => {
          setUserId(v);
          const clean = String(v || "").trim();
          if (/^\d{15,22}$/.test(clean)) load(clean);
        }
      }),

      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Local display name" }),
      React.createElement(FormInput, {
        placeholder: "Optional",
        value: displayName,
        onChange: setDisplayName
      }),

      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Avatar URL" }),
      React.createElement(FormInput, {
        placeholder: "https://...",
        value: avatarUrl,
        onChange: setAvatarUrl
      }),

      React.createElement(FormDivider),
      React.createElement(FormRow, { label: "Banner URL" }),
      React.createElement(FormInput, {
        placeholder: "https://...",
        value: bannerUrl,
        onChange: setBannerUrl
      }),

      React.createElement(FormDivider),
      React.createElement(FormRow, {
        label: "Save / Apply",
        subLabel: "Persist this local profile",
        onPress: save
      }),

      React.createElement(FormRow, {
        label: "Remove saved override",
        onPress: remove
      }),

      status ? React.createElement(FormRow, { label: status }) : null
    );
  }

  return {
    settings: Settings,
    onLoad() {
      applyAvatarPatch();
      applyBannerPatches();
      applyNamePatches();
      try { logger.log("Local Profiles v5 loaded"); } catch {}
    },
    onUnload() {
      while (unpatches.length) {
        try { unpatches.pop()(); } catch {}
      }
    }
  };
})()