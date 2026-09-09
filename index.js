(() => {
  const { metro, storage, ui, logger } = vendetta;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const Forms = ui?.components?.Forms;
  const useProxy = vendetta.storage?.useProxy;
  const unpatches = [];

  function patchMethod(mod, key, handler) {
    if (!mod || typeof mod[key] !== "function") return;
    const original = mod[key];
    mod[key] = function (...args) {
      return handler.call(this, original, args);
    };
    unpatches.push(() => { mod[key] = original; });
  }

  function applyAvatarPatch() {
    const TARGET_ID = String(storage.targetUserId || "");
    const OVERRIDE_URL = String(storage.imageUrl || "");
    if (!TARGET_ID || !OVERRIDE_URL) return;

    const avatarModule = metro.findByProps("getUserAvatarURL");
    if (!avatarModule) return;

    if (typeof avatarModule.getUserAvatarSource === "function") {
      patchMethod(avatarModule, "getUserAvatarSource", function (original, args) {
        const user = args[0];
        if (user?.id === TARGET_ID) {
          const result = original.apply(this, args);
          if (result && typeof result === "object") {
            return { ...result, uri: OVERRIDE_URL };
          }
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

  function applyBannerPatch() {
    const TARGET_ID = String(storage.targetUserId || "");
    const BANNER_URL = String(storage.bannerUrl || "");
    if (!TARGET_ID || !BANNER_URL) return;

    const helperNames = [
      "getUserBannerURL",
      "getUserBannerUrl",
      "getBannerURL",
      "getBannerUrl",
      "getUserBannerSource",
      "getBannerSource"
    ];

    for (const name of helperNames) {
      try {
        const mods = metro.findByPropsAll(name) || [];
        for (const mod of mods) {
          patchMethod(mod, name, function (original, args) {
            const first = args[0];
            const id =
              first?.id ? String(first.id) :
              (typeof first === "string" ? first : null);

            if (id === TARGET_ID) {
              if (name.toLowerCase().includes("source")) {
                const result = original.apply(this, args);
                if (result && typeof result === "object") {
                  return { ...result, uri: BANNER_URL };
                }
                return { uri: BANNER_URL };
              }
              return BANNER_URL;
            }
            return original.apply(this, args);
          });
        }
      } catch {}
    }
  }

  function applyNamePatch() {
    const TARGET_ID = String(storage.targetUserId || "");
    const LOCAL_NAME = String(storage.displayName || "");
    if (!TARGET_ID || !LOCAL_NAME) return;

    for (const name of ["getUserDisplayName", "getDisplayName"]) {
      try {
        const mods = metro.findByPropsAll(name) || [];
        for (const mod of mods) {
          patchMethod(mod, name, function (original, args) {
            const first = args[0];
            const id =
              first?.id ? String(first.id) :
              (typeof first === "string" ? first : null);

            if (id === TARGET_ID) return LOCAL_NAME;
            return original.apply(this, args);
          });
        }
      } catch {}
    }
  }

  function Settings() {
    if (!Forms || !RN?.ScrollView) return null;
    if (typeof useProxy === "function") useProxy(storage);

    const { FormInput, FormRow, FormDivider } = Forms;

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
        value: storage.targetUserId || "",
        onChange: v => { storage.targetUserId = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Local display name" }),
      React.createElement(FormInput, {
        placeholder: "Optional",
        value: storage.displayName || "",
        onChange: v => { storage.displayName = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Avatar URL" }),
      React.createElement(FormInput, {
        placeholder: "Enter image URL",
        value: storage.imageUrl || "",
        onChange: v => { storage.imageUrl = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, { label: "Banner URL" }),
      React.createElement(FormInput, {
        placeholder: "Enter banner URL",
        value: storage.bannerUrl || "",
        onChange: v => { storage.bannerUrl = v; }
      }),

      React.createElement(FormDivider),

      React.createElement(FormRow, {
        label: "Saved automatically",
        subLabel: "Reload Discord after editing to apply the current values."
      })
    );
  }

  return {
    settings: Settings,

    onLoad() {
      applyAvatarPatch();
      applyBannerPatch();
      applyNamePatch();
      try { logger.log("Local Profiles v6 loaded"); } catch {}
    },

    onUnload() {
      while (unpatches.length) {
        try { unpatches.pop()(); } catch {}
      }
    }
  };
})()