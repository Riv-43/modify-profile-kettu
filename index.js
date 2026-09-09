(() => {
  const { patcher, metro, storage, ui, logger } = vendetta;
  const React = metro.common.React;

  const DEFAULTS = {
    profiles: {}
  };

  function getStore() {
    if (!storage) return DEFAULTS;
    if (!storage.profiles) storage.profiles = {};
    return storage;
  }

  function getOverride(userId) {
    return getStore().profiles?.[String(userId)] || null;
  }

  function setOverride(userId, data) {
    const s = getStore();
    s.profiles[String(userId)] = { ...(s.profiles[String(userId)] || {}), ...data };
  }

  function removeOverride(userId) {
    const s = getStore();
    delete s.profiles[String(userId)];
  }

  function transformUser(user) {
    if (!user || !user.id) return user;
    const ov = getOverride(user.id);
    if (!ov) return user;

    const next = Object.assign({}, user);

    if (ov.username) {
      next.username = ov.username;
      next.globalName = ov.username;
      next.displayName = ov.username;
    }

    if (ov.avatarUrl) {
      next.avatar = null;
      next.avatarDecoration = null;
      next.avatarURL = ov.avatarUrl;
      next.getAvatarURL = () => ov.avatarUrl;
    }

    if (ov.bannerUrl) {
      next.banner = null;
      next.bannerURL = ov.bannerUrl;
      next.getBannerURL = () => ov.bannerUrl;
    }

    return next;
  }

  const unpatches = [];

  function patchLikelyUserStores() {
    const mods = [];

    try {
      mods.push(...(metro.findByPropsAll("getUser", "getUsers") || []));
    } catch {}

    for (const mod of mods) {
      if (!mod) continue;

      if (typeof mod.getUser === "function") {
        unpatches.push(
          patcher.after("getUser", mod, (_args, user) => transformUser(user))
        );
      }

      if (typeof mod.getUsers === "function") {
        unpatches.push(
          patcher.after("getUsers", mod, (_args, users) => {
            if (!users || typeof users !== "object") return users;
            const copy = Array.isArray(users) ? users.slice() : { ...users };
            for (const k in copy) copy[k] = transformUser(copy[k]);
            return copy;
          })
        );
      }
    }
  }

  function patchProfileFetches() {
    const candidates = [];
    try {
      candidates.push(...(metro.findByPropsAll("getUserProfile") || []));
    } catch {}

    for (const mod of candidates) {
      if (!mod || typeof mod.getUserProfile !== "function") continue;

      unpatches.push(
        patcher.after("getUserProfile", mod, (args, profile) => {
          const userId = args?.[0];
          const ov = getOverride(userId);
          if (!ov || !profile || typeof profile !== "object") return profile;

          const next = { ...profile };
          if (ov.bannerUrl) next.banner = ov.bannerUrl;
          if (ov.username && next.user) next.user = transformUser(next.user);
          if (ov.avatarUrl && next.user) next.user = transformUser(next.user);
          return next;
        })
      );
    }
  }

  function promptText(title, placeholder, initialValue = "") {
    return new Promise(resolve => {
      ui.alerts.showInputAlert({
        title,
        placeholder,
        value: initialValue,
        confirmText: "Save",
        cancelText: "Cancel",
        onConfirm: resolve,
        onCancel: () => resolve(null),
      });
    });
  }

  async function addOrEdit() {
    const id = await promptText("Discord user ID", "e.g. 123456789012345678");
    if (!id) return;

    const current = getOverride(id) || {};

    const username = await promptText("Local display name", "Leave blank to keep original", current.username || "");
    if (username === null) return;

    const avatarUrl = await promptText("Avatar URL", "https://...", current.avatarUrl || "");
    if (avatarUrl === null) return;

    const bannerUrl = await promptText("Banner URL", "https://...", current.bannerUrl || "");
    if (bannerUrl === null) return;

    setOverride(id, {
      username: username || "",
      avatarUrl: avatarUrl || "",
      bannerUrl: bannerUrl || ""
    });

    try { ui.toasts.showToast("Local profile saved. Reload Discord."); } catch {}
  }

  async function removeOne() {
    const id = await promptText("Remove local profile", "Discord user ID");
    if (!id) return;
    removeOverride(id);
    try { ui.toasts.showToast("Local profile removed. Reload Discord."); } catch {}
  }

  const settings = {
    render: () => React.createElement(
      React.Fragment,
      null,
      React.createElement(
        ui.components.Button,
        { text: "Add / edit local profile", onPress: addOrEdit }
      ),
      React.createElement(
        ui.components.Button,
        { text: "Remove local profile", onPress: removeOne, style: { marginTop: 12 } }
      )
    )
  };

  return {
    settings,
    onLoad() {
      patchLikelyUserStores();
      patchProfileFetches();
      logger.log("Local Profiles loaded");
    },
    onUnload() {
      for (const unpatch of unpatches.splice(0)) {
        try { unpatch(); } catch {}
      }
    }
  };
})()