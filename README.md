# Local Profiles

Experimental Kettu/Vendetta/Revenge plugin.

Features:
- Local display-name override
- Local avatar override
- Local banner override
- Multiple users
- Remove/reset per user

Nothing is sent to Discord and nothing changes for other people.

## Install
Host `manifest.json` and `index.js` together on a static HTTPS host, then add the folder URL in Kettu → Settings → Plugins → +.

## Use
Open the plugin settings (wrench icon), then:
1. Add / edit local profile
2. Enter Discord user ID
3. Enter optional local name
4. Enter optional avatar URL
5. Enter optional banner URL
6. Reload Kettu

## Notes
This is experimental. Discord's mobile internals change often, so some surfaces may keep the real avatar/banner while others use the override.
