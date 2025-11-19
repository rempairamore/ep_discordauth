const db = require('ep_etherpad-lite/node/db/DB').db;
const { request } = require('undici');
const fs = require('fs');
const path = require('path');

/**
 * Smartly locates settings.json.
 * Checks CLI args first, then searches current and parent directories.
 * Solves the issue where CWD is /src but settings are in root.
 */
function getSettingsPath() {
    // 1. Check command line arguments (-s or --settings)
    const args = process.argv;
    for (let i = 0; i < args.length; i++) {
        if ((args[i] === '-s' || args[i] === '--settings') && args[i + 1]) {
            return path.resolve(process.cwd(), args[i + 1]);
        }
    }

    // 2. Search in likely locations (current dir, parent, grand-parent)
    const candidates = [
        path.join(process.cwd(), 'settings.json'),
        path.join(process.cwd(), '..', 'settings.json'),
        path.join(process.cwd(), '..', '..', 'settings.json')
    ];

    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }

    // Fallback
    return path.join(process.cwd(), 'settings.json');
}

/**
 * Reads configuration manually to bypass Etherpad's module caching issues in plugins.
 */
function getPluginSettings() {
    const settingsPath = getSettingsPath();
    
    try {
        if (!fs.existsSync(settingsPath)) {
            console.error(`[ep_discordauth] Error: Settings file not found at ${settingsPath}`);
            return null;
        }

        const rawContent = fs.readFileSync(settingsPath, 'utf8');
        // Remove comments (relaxed JSON -> strict JSON)
        const cleanContent = rawContent.replace(/\/\*[\s\S]*?\*\/|([^\\:]|^)\/\/.*$/gm, '$1');
        const settingsObj = JSON.parse(cleanContent);

        if (settingsObj.ep_discordauth) {
            return settingsObj.ep_discordauth;
        } else {
            console.error(`[ep_discordauth] 'ep_discordauth' key missing in ${settingsPath}`);
            return null;
        }
    } catch (error) {
        console.error(`[ep_discordauth] Failed to read/parse settings: ${error.message}`);
        return null;
    }
}

function makesecret(length) {
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let counter = 0;
    while (counter < length) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
        counter += 1;
    }
    return result;
}

exports.expressCreateServer = function(hook, context) {
    
    console.log(`[ep_discordauth] Initializing. Config source: ${getSettingsPath()}`);

    context.app.get("/discordauth/callback", async (req, res) => {
        const config = getPluginSettings();
        
        if (!config || !config.client_id || !config.callback_url) {
            console.error("[ep_discordauth] Missing client_id or callback_url in settings.json");
            return res.status(500).send("Configuration Error: Check server logs.");
        }

        const auth_code = req.query.code;
        const sessionID = req.sessionID;
        const callbackUrl = config.callback_url; 

        db.get(`oauthstate:${req.sessionID}`, async (k, state) => {
            if (req.query.state != state) {
                console.warn("[ep_discordauth] State mismatch, redirecting to logout.");
                return res.redirect("/discordauth/logout");
            }

            if (!auth_code) return res.redirect("/discordauth/login");

            try {
                // 1. Get Token
                const tokenResponse = await request('https://discord.com/api/oauth2/token', {
                    method: 'POST',
                    body: new URLSearchParams({
                        client_id: config.client_id,
                        client_secret: config.client_secret,
                        code: auth_code,
                        grant_type: 'authorization_code',
                        redirect_uri: callbackUrl,
                        scope: 'identify guilds guilds.members.read'
                    }).toString(),
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
                });

                const oauthData = await tokenResponse.body.json();
                if (oauthData.error) {
                    console.error("[ep_discordauth] OAuth Error:", oauthData);
                    return res.status(400).send(`Auth Error: ${oauthData.error_description || oauthData.error}`);
                }

                // 2. Get User
                const userReq = await request('https://discord.com/api/users/@me', {
                    headers: { authorization: `${oauthData.token_type} ${oauthData.access_token}` }
                });
                const userData = await userReq.body.json();

                // 3. Get Guilds (Only if config requires guild checks)
                let guildList = [];
                const needsGuilds = config.authorizedUsers?.guilds || config.admins?.guilds || config.excluded?.guilds;
                
                if (needsGuilds) {
                    const guildReq = await request('https://discord.com/api/users/@me/guilds', {
                        headers: { authorization: `${oauthData.token_type} ${oauthData.access_token}` }
                    });
                    guildList = await guildReq.body.json();
                }

                // Helper: Check Guild Roles
                async function checkGuildRoles(rules, userGuilds) {
                    if (!userGuilds || !rules?.guilds) return false;
                    for (const guild of userGuilds) {
                        const rule = rules.guilds[guild.id];
                        if (rule && rule.roles) {
                            try {
                                const memberReq = await request(`https://discord.com/api/users/@me/guilds/${guild.id}/member`, {
                                    headers: { authorization: `${oauthData.token_type} ${oauthData.access_token}` }
                                });
                                if (memberReq.statusCode !== 200) continue;
                                const memberData = await memberReq.body.json();
                                const authorizedRoles = new Set(rule.roles);
                                if (memberData.roles && memberData.roles.some(r => authorizedRoles.has(r))) return true;
                            } catch (e) { continue; }
                        }
                    }
                    return false;
                }

                let permission = false;
                let admin = false;

                // --- Authorization Logic ---

                // Check Authorized Users
                if (config.authorizedUsers?.individuals?.includes(userData.id)) permission = true;
                if (!permission && await checkGuildRoles(config.authorizedUsers, guildList)) permission = true;

                // Check Admins
                if (config.admins?.individuals?.includes(userData.id)) { permission = true; admin = true; }
                if (!admin && await checkGuildRoles(config.admins, guildList)) { permission = true; admin = true; }

                // Check Exclusions (Bans)
                if (config.excluded?.individuals?.includes(userData.id)) { permission = false; admin = false; }
                if ((permission || admin) && await checkGuildRoles(config.excluded, guildList)) { permission = false; admin = false; }

                // Final Decision
                if (userData.id && (permission || admin)) {
                    console.log(`[ep_discordauth] Login Success: ${userData.username} (Admin: ${admin})`);
                    db.set(`oauth:${sessionID}`, userData);
                    db.set(`oauth_admin:${sessionID}`, admin);
                    res.redirect(req.session.preAuthReqUrl || '/');
                } else {
                    console.warn(`[ep_discordauth] Access Denied: ${userData.username}`);
                    res.status(403).send("Access denied. You are not authorized.");
                }

            } catch (error) {
                console.error("[ep_discordauth] Exception:", error);
                res.status(500).send("Internal Server Error");
            }
        });
    });

    context.app.get("/discordauth/login", async (req, res) => {
        const config = getPluginSettings();
        if (!config || !config.client_id || !config.callback_url) {
            return res.status(500).send("Configuration missing: Check client_id and callback_url in settings.json");
        }

        req.session.state = makesecret(16);
        db.set(`oauthstate:${req.sessionID}`, req.session.state);

        const callbackUrl = config.callback_url;
        const authUrl = `https://discord.com/oauth2/authorize?client_id=${config.client_id}&response_type=code&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=identify+guilds+guilds.members.read&state=${req.session.state}`;

        res.send(`
            <html>
            <head><title>Login</title><style>body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;height:100vh;background:#2c2f33;color:white}.btn{background:#5865F2;color:white;padding:15px 30px;text-decoration:none;border-radius:5px;font-weight:bold;transition:0.2s}.btn:hover{background:#4752c4;transform:scale(1.05)}</style></head>
            <body><a href="${authUrl}" class="btn">Login with Discord</a></body>
            </html>
        `);
    });

    context.app.get("/discordauth/logout", (req, res) => {
        const sessionID = req.sessionID;
        db.set(`oauth:${sessionID}`, undefined);
        db.set(`oauth_admin:${sessionID}`, undefined);
        db.set(`oauthstate:${sessionID}`, undefined);
        req.session.destroy();
        res.redirect("/discordauth/login");
    });
}

exports.authenticate = function(hook, context, cb) {
    db.get(`oauth:${context.req.sessionID}`, (k, user) => {
        if (user) {
            context.req.session.user = context.users[user.username] || user;
            context.req.session.user.displayname = user.username;
            context.req.session.user.displaynameChangeable = true;
            db.get(`oauth_admin:${context.req.sessionID}`, (k, admin) => {
                context.req.session.user.is_admin = admin;
            });
            return cb(true);
        }
        context.req.session.preAuthReqUrl = context.req.url;
        return cb(false);
    });
}

exports.authnFailure = function(hook, context, cb) {
    context.res.redirect('/discordauth/login');
    return cb([true]);
}

exports.preAuthorize = function(hook, context) {
    if (context.req.url.startsWith("/discordauth/")) return true;
}

exports.authorize = function(hook, context, cb) {
    db.get(`oauth:${context.req.sessionID}`, (k, user) => cb(!!user));
}