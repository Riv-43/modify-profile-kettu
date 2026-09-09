(() => {
  const { metro, storage, ui, logger } = vendetta;
  const React = metro.common.React;
  const ReactNative = metro.common.ReactNative;
  const Forms = ui?.components?.Forms;
  const patches = [];

  function profiles() {
    return storage.profiles && typeof storage.profiles === "object"
      ? storage.profiles
      : {};
  }

  function getTarget(id) {
    if (!id) return null;
    return profiles()[String(id)] || null;
  }

  function patchMethod(mod, name, wrapper) {
    if (!mod || typeof mod[name] !== "function") return;
    const original = mod[name];

    mod[name] = function (...args) {
      return wrapper.call(this, original, args);
    };

    patches.push(() => {
      mod[name] = original;
    });
  }

  function findUserId(args) {
    for (const a of args) {
      if (a && typeof a === "object" && a.id) return String(a.id);
    }

    for (const a of args) {
      if (typeof a === "string" && /^\d{15,22}$/.test(a)) return a;
    }

    return null;
  }

  function applyPatches() {
    // Avatar: same general approach used by working avatar override plugins.
    try {
      const avatarModule = metro.findByProps("getUserAvatarURL");

      if (avatarModule) {
        patchMethod(avatarModule, "getUserAvatarURL", function (original, args) {
          const id = findUserId(args);
          const p = getTarget(id);

          if (p?.avatarUrl) return p.avatarUrl;
          return original.apply(this, args);
        });

        if (typeof avatarModule.getUserAvatarSource === "function") {
          patchMethod(avatarModule, "getUserAvatarSource", function (original, args) {
            const result = original.apply(this, args);
            const id = findUserId(args);
            const p = getTarget(id);

            if (!p?.avatarUrl) return result;

            if (result && typeof result === "object") {
              return { ...result, uri: p.avatarUrl };
            }

            return { uri: p.avatarUrl };
          });
        }
      }
    } catch (e) {
      try { logger.error("Local Profiles: avatar patch failed", e); } catch {}
    }

    // Banner: only patch a dedicated URL helper if this Discord build exposes it.
    try {
      const bannerModules = metro.findByPropsAll("getUserBannerURL") || [];

      for (const mod of bannerModules) {
        patchMethod(mod, "getUserBannerURL", function (original, args) {
          const id = findUserId(args);
          const p = getTarget(id);

          if (p?.bannerUrl) return p.bannerUrl;
          return original.apply(this, args);
        });
      }
    } catch (e) {
      try { logger.error("Local Profiles: banner patch failed", e); } catch {}
    }

    // Name: patch display-name helper functions only. Never patch UserStore.
    try {
      for (const method of ["getUserDisplayName", "getDisplayName"]) {
        const modules = metro.findByPropsAll(method) || [];

        for (const mod of modules) {
          patchMethod(mod, method, function (original, args) {
            const result = original.apply(this, args);
            const id = findUserId(args);
            const p = getTarget(id);

            return p?.displayName || result;
          });
        }
      }
    } catch (e) {
      try { logger.error("Local Profiles: name patch failed", e); } catch {}
    }
  }

  function Settings() {
    if (!Forms || !ReactNative?.ScrollView) return null;

    const { FormInput, FormRow, FormDivider } = Forms;

    const initialId = String(storage.lastUserId || "");
    const initial = getTarget(initialId) || {};

    const [userId, setUserId] = React.useState(initialId);
    const [displayName, setDisplayName] = React.useState(initial.displayName || "");
    const [avatarUrl, setAvatarUrl] = React.useState(initial.avatarUrl || "");
    const [bannerUrl, setBannerUrl] = React.useState(initial.bannerUrl || "");
    const [status, setStatus] = React.useState("");

    React.useEffect(() => {
      const clean = String(userId || "").trim();

      if (!/^\d{15,22}$/.test(clean)) return;

      const saved = getTarget(clean);

      if (saved) {
        setDisplayName(saved.displayName || "");
        setAvatarUrl(saved.avatarUrl || "");
        setBannerUrl(saved.bannerUrl || "");
        setStatus("Loaded saved profile.");
      }
    }, [userId]);

    const save = () => {
      const id = String(userId || "").trim();

      if (!/^\d{15,22}$/.test(id)) {
        setStatus("Enter a valid Discord user ID first.");
        return;
      }

      // IMPORTANT: replace the entire top-level object so Kettu's persistent
      // plugin storage detects the write reliably.
      storage.profiles = {
        ...profiles(),
        [id]: {
          displayName: String(displayName || "").trim(),
          avatarUrl: String(avatarUrl || "").trim(),
          bannerUrl: String(bannerUrl || "").trim()
        }
      };

      storage.lastUserId = id;
      setStatus("Saved. Reload Discord to apply.");
    };

    const remove = () => {
      const id = String(userId || "").trim();
      if (!id) return;

      const next = { ...profiles() };
      delete next[id];

      storage.profiles = next;
      setDisplayName("");
      setAvatarUrl("");
      setBannerUrl("");
      setStatus("Removed. Reload Discord to restore the original profile.");
    };

    return React.createElement(
      ReactNative.ScrollView,
      {
        keyboardShouldPersistTaps: "handled",
        keyboardDismissMode: "interactive",
        contentContainerStyle: {
          paddingBottom: 420
        }
      },

      React.createElement(FormRow, { label: "Discord User ID" }),
      React.createElement(FormInput, {
        placeholder: "123456789012345678",
        value: userId,
        onChange: setUserId
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
        subLabel: "Stores this profile locally",
        onPress: save
      }),

      React.createElement(FormRow, {
        label: "Remove saved override",
        subLabel: "Restore the real profile after reload",
        onPress: remove
      }),

      status
        ? React.createElement(FormRow, { label: status })
        : null
    );
  }

  return {
    settings: Settings,

    onLoad() {
      if (!storage.profiles || typeof storage.profiles !== "object") {
        storage.profiles = {};
      }

      applyPatches();

      try { logger.log("Local Profiles v4 loaded"); } catch {}
    },

    onUnload() {
      while (patches.length) {
        try { patches.pop()(); } catch {}
      }
    }
  };
})()