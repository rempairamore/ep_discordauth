# ep_discordauth

A plugin that allows you to authenticate users based on their Discord user ID or their membership in guilds (servers) and roles in those guilds.

## Installation

1. **Install this plugin:**

```bash
cd /opt/etherpad-lite
pnpm add https://github.com/rempairamore/ep_discordauth.git
```

2. **Setup a Discord Application:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications).
   - Create a new Application.
   - Go to **OAuth2** -> **General**.
   - Add a Redirect Redirect: `https://YOUR-ETHERPAD-DOMAIN.COM/discordauth/callback`
   - Copy the **Client ID** and **Client Secret**.

3. **Update settings.json:**
   Add the following configuration to your `settings.json` file (ensure it's at the root level of the JSON object):

```json
"requireAuthentication": true,
"requireAuthorization": true,
"ep_discordauth": {
  "client_id": "YOUR_CLIENT_ID",
  "client_secret": "YOUR_CLIENT_SECRET",
  "callback_url": "https://your-etherpad-domain.com/discordauth/callback",
  "authorizedUsers": {
    "individuals": ["123456789012345678"],
    "guilds": {
      "GUILD_ID": { "roles": ["ROLE_ID"] }
    }
  },
  "admins": {
    "individuals": ["ADMIN_DISCORD_ID"],
    "guilds": {
       "GUILD_ID": { "roles": ["ADMIN_ROLE_ID"] }
    }
  },
  "excluded": {
    "individuals": ["BANNED_USER_ID"],
    "guilds": {
        "GUILD_ID": { "roles": ["BANNED_ROLE_ID"] }
    }
  }
}


Any persons listed in the `individuals` or in one of the `roles` list of one of
the guilds listed under `authorizedUsers` will be able to access pads on etherpad.
Any person listed in the same way under `admins` will have access to /admin.
Anyone in the `excluded` section will have both types of access removed.

To get the discord ids of users, guilds and roles, activate "Developer Mode"
([Settings]->[Advanced]->[Developer mode]) in your discord client. If you right
click a user, guild or role (in the guilds server options) you can copy it's ID
from there.