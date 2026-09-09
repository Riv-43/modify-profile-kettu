(() => {
  const { patcher, metro, storage, logger } = vendetta;
  const React = metro.common.React;
  const RN = metro.common.ReactNative;
  const { View, Text, Pressable, Alert, ScrollView } = RN;

  function store() {
    if (!storage.profiles) storage.profiles = {};
    return storage.profiles;
  }

  function getOverride(id) {
    return store()[String(id)] || null;
  }

  function saveOverride(id, data) {
    store()[String(id)] = { ...(store()[String(id)] || {}), ...data };
  }

  function removeOverride(id) {
    delete store()[String(id)];
  }

  function transformUser(user) {
    if (!user || !user.id) return user;
    const ov = getOverride(user.id);
    if (!ov) return user;

    const u = { ...user };

    if (ov.username) {
      u.username = ov.username;
      u.globalName = ov.username;
      u.displayName = ov.username;
    }

    if (ov.avatarUrl) {
      u.avatarURL = ov.avatarUrl;
      u.getAvatarURL = () => ov.avatarUrl;
    }

    if (ov.bannerUrl) {
      u.bannerURL = ov.bannerUrl;
      u.getBannerURL = () => ov.bannerUrl;
    }

    return u;
  }

  const unpatches = [];

  function safeAfter(method, mod, cb) {
    try {
      if (mod && typeof mod[method] === "function") {
        unpatches.push(patcher.after(method, mod, cb));
      }
    } catch {}
  }

  function patchStores() {
    try {
      for (const mod of metro.findByPropsAll("getUser", "getUsers") || []) {
        safeAfter("getUser", mod, (_args, ret) => transformUser(ret));
        safeAfter("getUsers", mod, (_args, ret) => {
          if (!ret || typeof ret !== "object") return ret;
          if (Array.isArray(ret)) return ret.map(transformUser);
          const copy = { ...ret };
          for (const k of Object.keys(copy)) copy[k] = transformUser(copy[k]);
          return copy;
        });
      }
    } catch {}

    try {
      for (const mod of metro.findByPropsAll("getUserProfile") || []) {
        safeAfter("getUserProfile", mod, (args, ret) => {
          const id = String(args?.[0] ?? "");
          const ov = getOverride(id);
          if (!ov || !ret || typeof ret !== "object") return ret;

          const p = { ...ret };
          if (p.user) p.user = transformUser(p.user);

          // Discord profile objects have used several banner fields over time.
          if (ov.bannerUrl) {
            p.banner = ov.bannerUrl;
            p.bannerURL = ov.bannerUrl;
            p.bannerUrl = ov.bannerUrl;
          }
          return p;
        });
      }
    } catch {}
  }

  function prompt(title, message, value, cb) {
    Alert.prompt(
      title,
      message,
      [
        { text: "Cancel", style: "cancel" },
        { text: "OK", onPress: text => cb(text ?? "") }
      ],
      "plain-text",
      value || ""
    );
  }

  function editProfile() {
    prompt("Local Profiles", "Discord user ID", "", id => {
      id = String(id).trim();
      if (!id) return;

      const old = getOverride(id) || {};
      prompt("Display name", "Leave blank to keep the real name.", old.username || "", username => {
        prompt("Avatar URL", "Direct https:// image URL. Leave blank to keep original.", old.avatarUrl || "", avatarUrl => {
          prompt("Banner URL", "Direct https:// image URL. Leave blank to keep original.", old.bannerUrl || "", bannerUrl => {
            saveOverride(id, {
              username: username.trim(),
              avatarUrl: avatarUrl.trim(),
              bannerUrl: bannerUrl.trim()
            });
            Alert.alert("Saved", "Reload Discord/Kettu to apply the local profile.");
          });
        });
      });
    });
  }

  function deleteProfile() {
    prompt("Remove local profile", "Discord user ID", "", id => {
      id = String(id).trim();
      if (!id) return;
      removeOverride(id);
      Alert.alert("Removed", "Reload Discord/Kettu to restore the real profile.");
    });
  }

  function ProfileList() {
    const profiles = store();
    const ids = Object.keys(profiles);

    return React.createElement(
      ScrollView,
      { contentContainerStyle: { padding: 16, gap: 12 } },

      React.createElement(
        Pressable,
        {
          onPress: editProfile,
          style: {
            paddingVertical: 14,
            paddingHorizontal: 16,
            borderRadius: 12,
            backgroundColor: "#5865F2"
          }
        },
        React.createElement(Text, { style: { color: "white", fontSize: 16, fontWeight: "600" } }, "Add / edit local profile")
      ),

      React.createElement(
        Pressable,
        {
          onPress: deleteProfile,
          style: {
            paddingVertical: 14,
            paddingHorizontal: 16,
            borderRadius: 12,
            backgroundColor: "#4E5058"
          }
        },
        React.createElement(Text, { style: { color: "white", fontSize: 16, fontWeight: "600" } }, "Remove local profile")
      ),

      React.createElement(
        Text,
        { style: { color: "#B5BAC1", marginTop: 8, fontSize: 14 } },
        ids.length ? `Saved profiles: ${ids.length}` : "No local profiles saved yet."
      ),

      ...ids.map(id => {
        const p = profiles[id];
        const label = p.username || id;
        return React.createElement(
          View,
          {
            key: id,
            style: {
              padding: 12,
              borderRadius: 10,
              backgroundColor: "#2B2D31"
            }
          },
          React.createElement(Text, { style: { color: "white", fontSize: 15, fontWeight: "600" } }, label),
          React.createElement(Text, { style: { color: "#B5BAC1", marginTop: 4, fontSize: 12 } }, id)
        );
      })
    );
  }

  return {
    settings: ProfileList,

    onLoad() {
      patchStores();
      try { logger.log("Local Profiles v2 loaded"); } catch {}
    },

    onUnload() {
      for (const unpatch of unpatches.splice(0)) {
        try { unpatch(); } catch {}
      }
    }
  };
})()