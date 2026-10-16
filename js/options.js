// Define async function
async function getExtensionConfig() {
    var items = await browser.storage.local.get();

    return {
        server: items.server || "",
        token: items.token || "",
        username: items.username || "",
        password: items.password || "",
        remember: items.remember || false,
    };
}

async function saveExtensionConfig(cfg) {
    return browser.storage.local.set(cfg);
}

async function logout(server, token) {
    // Make sure token is exists
    if (token === "") return Promise.resolve();

    // Validate input
    if (server === "") {
        throw new Error("Server must not empty");
    }

    // Create logout url
    var logoutURL = "";
    try {
        logoutURL = new URL(server);
        if (logoutURL.pathname.slice(-1) == "/") {
            logoutURL.pathname = logoutURL.pathname + "api/logout";
        } else {
            logoutURL.pathname = logoutURL.pathname + "/api/logout";
        }
    } catch(err) {
        throw new Error(`${server} is not a valid url`);
    }

    // Send logout request
    var response = await fetch(logoutURL, {
        method: "post",
        headers: {
            "Authorization": `Bearer ${token}`,
        }
    });

    if (!response.ok) {
        var err = await response.text();
        throw new Error(err);
    }

    return Promise.resolve();
}

async function login(server, username, password, remember) {
    // Validate input
    if (server === "") {
        throw new Error("Server must not empty");
    }

    if (username === "") {
        throw new Error("Username must not empty");
    }

    if (password === "") {
        throw new Error("Password must not empty");
    }

    if (typeof remember !== 'boolean') {
        remember = false;
    }

    // Create login URL
    var loginURL = "";
    var loginPath = "api/v1/auth/login";
    try {
        loginURL = new URL(server);
        if (loginURL.pathname.slice(-1) == "/") {
            loginURL.pathname = loginURL.pathname + loginPath;
        } else {
            loginURL.pathname = loginURL.pathname + "/" + loginPath;
        }
    } catch(err) {
        throw new Error(`${server} is not a valid url`);
    }

    // Send login request
    var response = await fetch(loginURL, {
        method: "post",
        body: JSON.stringify({
            username: username,
            password: password,
            remember_me: remember,
        }),
        headers: {
            "Content-Type": "application/json",
        }
    });

    if (!response.ok) {
        var err = await response.text();
        throw new Error(err);
    }

    var jsonResp = await response.json(),
        token = jsonResp.message.token;

    return token;
}

// Define function for UI handler
var errorMessage = document.getElementById("error-message"),
    txtSession = document.getElementById("txt-session"),
    inputServer = document.getElementById("input-server"),
    inputUsername = document.getElementById("input-username"),
    inputPassword = document.getElementById("input-password"),
    inputRemember = document.getElementById("input-remember"),
    btnLogin = document.getElementById("btn-login"),
    loadingSign = document.getElementById("loading-sign"),
    config = {};

function showLoading() {
    btnLogin.style.display = "none";
    loadingSign.style.display = "block";
}

function hideLoading() {
    btnLogin.style.display = "block";
    loadingSign.style.display = "none";
}

function showError(msg) {
    errorMessage.style.display = "block";
    errorMessage.textContent = msg;
}

function hideError() {
    errorMessage.style.display = "none";
}

getExtensionConfig()
    .then(cfg => {
        config = cfg;

        if (cfg.token === "") txtSession.textContent = "No active session";
        else txtSession.textContent = `Logged in.`;

        inputServer.value = cfg.server;
        inputUsername.value = cfg.username;
        inputPassword.value = cfg.password;
        inputRemember.checked = cfg.remember;
    })
    .catch(err => showError(err));

// Register event listener
async function btnLoginClick() {
    // Get input value
    var server = inputServer.value,
        username = inputUsername.value,
        password = inputPassword.value;
        remember = inputRemember.checked;

    // Make sure to log out first
    await logout(server, config.token);

    // Login using input value
    var token = await login(server, username, password, remember);

    // Save input value and token to config
    config.server = server;
    config.token = token;
    config.username = username;
    config.password = password;
    config.remember = remember;
    await saveExtensionConfig(config);
    txtSession.textContent = `Logged in.`;

    return Promise.resolve();
}

btnLogin.addEventListener("click", () => {
    hideError();
    showLoading();

    btnLoginClick()
        .then(async () => {
            // Login doubles as the setup event: stash + full sync down.
            await browser.runtime.sendMessage({ type: "setup-sync" });
        })
        .catch(err => showError(err.message || String(err)))
        .finally(() => {
            hideLoading();
            refreshSyncStatus().catch(() => {});
            refreshBlocklist().catch(() => {});
            refreshLog().catch(() => {});
        });
});

// Sync status + blocklist (locally hidden) management
var txtSync = document.getElementById("txt-sync"),
    btnSyncNow = document.getElementById("btn-sync-now"),
    blocklistEl = document.getElementById("blocklist"),
    inputBlockUrl = document.getElementById("input-block-url"),
    inputBlockTag = document.getElementById("input-block-tag"),
    btnBlockAdd = document.getElementById("btn-block-add"),
    btnBlockClear = document.getElementById("btn-block-clear");

async function refreshSyncStatus() {
    try {
        const st = await browser.runtime.sendMessage({ type: "get-sync-status" });
        const when = st.lastSync ? new Date(st.lastSync).toLocaleString() : "never";
        txtSync.textContent = `Last sync: ${when}. Every ${st.intervalMin} min. ${st.blocked} locally hidden.`;
    } catch (err) {
        txtSync.textContent = `Sync status unavailable: ${err.message || err}`;
    }
}

async function refreshBlocklist() {
    const list = await browser.runtime.sendMessage({ type: "blocklist-list" });
    blocklistEl.innerHTML = "";
    if (!list.length) {
        blocklistEl.textContent = "Nothing hidden.";
        return;
    }
    list.forEach((entry) => {
        const row = document.createElement("div");
        const label = document.createElement("span");
        label.textContent = `${entry.url} [${entry.tag || "untagged"}] `;
        const btn = document.createElement("a");
        btn.className = "button";
        btn.textContent = "Unhide";
        btn.addEventListener("click", async () => {
            await browser.runtime.sendMessage({ type: "blocklist-remove", url: entry.url, tag: entry.tag });
            await refreshBlocklist();
            await refreshSyncStatus();
        });
        row.appendChild(label);
        row.appendChild(btn);
        blocklistEl.appendChild(row);
    });
}

if (btnSyncNow) {
    btnSyncNow.addEventListener("click", async () => {
        hideError();
        txtSync.textContent = "Syncing...";
        try {
            await browser.runtime.sendMessage({ type: "sync-now" });
        } catch (err) {
            showError(err.message || String(err));
        }
        await refreshSyncStatus();
        await refreshLog();
    });
}

if (btnBlockAdd) {
    btnBlockAdd.addEventListener("click", async () => {
        const url = (inputBlockUrl.value || "").trim();
        const tag = (inputBlockTag.value || "").trim() || null;
        if (!url) {
            showError("URL must not be empty");
            return;
        }
        await browser.runtime.sendMessage({ type: "blocklist-add", url, tag });
        inputBlockUrl.value = "";
        inputBlockTag.value = "";
        await refreshBlocklist();
        await refreshSyncStatus();
    });
}

if (btnBlockClear) {
    btnBlockClear.addEventListener("click", async () => {
        await browser.runtime.sendMessage({ type: "blocklist-clear" });
        await refreshBlocklist();
        await refreshSyncStatus();
    });
}

refreshSyncStatus().catch(() => {});
refreshBlocklist().catch(() => {});

// Sync log view
var syncLogEl = document.getElementById("sync-log"),
    btnLogRefresh = document.getElementById("btn-log-refresh"),
    btnLogClear = document.getElementById("btn-log-clear");

async function refreshLog() {
    const log = await browser.runtime.sendMessage({ type: "get-log" });
    syncLogEl.innerHTML = "";
    if (!log.length) {
        syncLogEl.textContent = "Log empty.";
        return;
    }
    log.slice().reverse().forEach((entry) => {
        const row = document.createElement("div");
        row.textContent = `${new Date(entry.t).toLocaleString()} ${entry.msg}`;
        syncLogEl.appendChild(row);
    });
}

if (btnLogRefresh) {
    btnLogRefresh.addEventListener("click", () => refreshLog().catch(err => showError(err.message || String(err))));
}

if (btnLogClear) {
    btnLogClear.addEventListener("click", async () => {
        await browser.runtime.sendMessage({ type: "clear-log" });
        await refreshLog();
    });
}

refreshLog().catch(() => {});
