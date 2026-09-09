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

  function applyBannerPatch() {
    const TARGET_ID = String(storage?.targetUserId || "");
    const BANNER_URL = String(storage?.bannerUrl || "");
    if (!TARGET_ID || !BANNER_URL) return;

    // This exact lookup mirrors an existing Vendetta Custom Banner plugin.
    let bannerModule = null;
    try {
      bannerModule = metro.findByProps("default", "getUserBannerURL");
    } catch {}

    // Fallback for builds where default isn't on the same module.
    if (!bannerModule) {
      try { bannerModule = metro.findByProps("getUserBannerURL"); } catch {}
    }

    if (!bannerModule || typeof bannerModule.getUserBannerURL !== "function") {
      try { logger.error("Local Profiles v9: getUserBannerURL module not found"); } catch {}
      return;
    }

    patchMethod(bannerModule, "getUserBannerURL", function (original, args) {
      const user = args[0];

      // Exact signature used by Discord's banner helper: first arg is user.
      if (user?.id === TARGET_ID) {
        return BANNER_URL;
      }

      return original.apply(this, args);
    });

    try { logger.log("Local Profiles v9: banner helper patched"); } catch {}
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
        label: "Saved automatically",
        subLabel: "v9 uses Discord's exact getUserBannerURL helper. Reload Discord after editing."
      })
    );
  }

  return {
    settings: Settings,

    onLoad() {
      if (!storage) return;
      applyAvatarPatch();
      applyBannerPatch();
      applyNamePatch();
      try { logger.log("Local Profiles v9 loaded"); } catch {}
    },

    onUnload() {
      while (unpatches.length) {
        try { unpatches.pop()(); } catch {}
      }
    }
  };
})()