"use strict";

/* Tag-folder sync model under the Bookmarks Toolbar.
 * Each Shiori tag = a folder in the toolbar. A bookmark with N tags appears
 * once per tag folder (duplicates). Untagged bookmarks sit plainly in the toolbar.
 * Any folder starting with "." (incl. trash) is ignored.
 * Browser deletes never touch the server. Real deletes happen in Shiori portal.
 * Moving a bookmark between tag folders retags it on the server.
 */

const TRASH_TITLE = ".Trashed By Shiori Extension";
const SYNC_ALARM = "shiori-sync";
const SYNC_INTERVAL_MIN = 15;
const MAX_LOG = 100;

function isFirefox() {
  return browser.runtime.getURL("/").startsWith("moz");
}

function getToolbarId() {
  return isFirefox() ? "toolbar_____" : "1";
}

function trashParentCandidates() {
  return isFirefox() ? ["toolbar_____", "unfiled_____", "menu______"] : ["1", "2"];
}

let isSyncing = false;
let serverIndex = new Map(); // url -> server bookmark object

function normUrl(u) {
  return (u || "").trim();
}

function blockKey(url, tag) {
  return `${normUrl(url)}|||${tag || ""}`;
}

async function syncLog(msg) {
  const line = `${new Date().toLocaleTimeString()} ${msg}`;
  console.log("[shiori]", line);
  try {
    const { syncLog: log = [] } = await browser.storage.local.get("syncLog");
    log.push({ t: new Date().toISOString(), msg });
    while (log.length > MAX_LOG) log.shift();
    await browser.storage.local.set({ syncLog: log });
  } catch { /* storage full or unavailable */ }
}

async function getExtensionConfig() {
  const { token = "", server = "" } = await browser.storage.local.get();
  if (!token) throw new Error("No active session, please login first");
  if (!server) throw new Error("Server URL is not specified");
  return { token, server };
}

async function getExtensionConfigSafe() {
  const { token = "", server = "" } = await browser.storage.local.get();
  return { token, server };
}

function srvBase(server) {
  const u = new URL(server);
  u.pathname = u.pathname.replace(/\/+$/, "") + "/";
  return u;
}

async function checkServerHealth(server, token) {
  if (!server) throw new Error("Server URL is not specified");
  const healthURL = new URL(`${srvBase(server)}api/v1/system/info`).toString();
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(healthURL, { method: "GET", headers });
  if (!res.ok) throw new Error(`Server health check failed: ${res.status}`);
  return await res.json();
}

function unwrapBookmarks(json) {
  // Supports both new format {bookmarks} and legacy {message:{bookmarks}}.
  if (json.bookmarks) return { bookmarks: json.bookmarks, maxPage: json.maxPage || 1 };
  if (json.message && json.message.bookmarks) {
    return { bookmarks: json.message.bookmarks, maxPage: json.message.maxPage || 1 };
  }
  return { bookmarks: [], maxPage: 1 };
}

async function fetchAllServerBookmarks() {
  const config = await getExtensionConfig();
  const all = [];
  let page = 1;
  let maxPage = 1;
  do {
    const apiURL = new URL(`${srvBase(config.server)}api/bookmarks`);
    apiURL.searchParams.set("page", String(page));
    const res = await fetch(apiURL.toString(), {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.token}`,
        "X-Shiori-Response-Format": "new",
      },
    });
    if (!res.ok) throw new Error(await res.text());
    const { bookmarks, maxPage: mp } = unwrapBookmarks(await res.json());
    all.push(...(bookmarks || []));
    maxPage = mp || 1;
    page += 1;
  } while (page <= maxPage);
  serverIndex = new Map(all.map((b) => [normUrl(b.url), b]));
  return all;
}

async function apiCreateBookmark(url, title, tag) {
  const config = await getExtensionConfig();
  const apiURL = new URL(`${srvBase(config.server)}api/bookmarks`).toString();
  const body = {
    url: normUrl(url),
    title: title || "",
    createArchive: false,
    tags: tag ? [{ name: tag }] : [],
  };
  const res = await fetch(apiURL, {
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
  });
  if (!res.ok) {
    const t = await res.text();
    if (res.status === 500 && /exist/i.test(t)) return null; // duplicate, caller refetches
    throw new Error(t);
  }
  return await res.json();
}

async function apiUpdateBookmarkTags(serverBm, nextTagNames) {
  const config = await getExtensionConfig();
  const apiURL = new URL(`${srvBase(config.server)}api/bookmarks`).toString();
  const body = {
    ...serverBm,
    tags: nextTagNames.map((name) => ({ name })),
  };
  const res = await fetch(apiURL, {
    method: "PUT",
    body: JSON.stringify(body),
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.token}`,
    },
  });
  if (!res.ok) throw new Error(await res.text());
  return await res.json();
}

async function apiAddTag(url, tag) {
  if (!tag) return;
  let bm = serverIndex.get(normUrl(url));
  if (!bm) {
    await fetchAllServerBookmarks();
    bm = serverIndex.get(normUrl(url));
  }
  if (!bm) return;
  const names = (bm.tags || []).map((t) => t.name);
  if (names.includes(tag)) return;
  await apiUpdateBookmarkTags(bm, [...names, tag]);
  await fetchAllServerBookmarks();
}

async function apiRetag(url, oldTag, newTag) {
  let bm = serverIndex.get(normUrl(url));
  if (!bm) {
    await fetchAllServerBookmarks();
    bm = serverIndex.get(normUrl(url));
  }
  if (!bm) return;
  let names = (bm.tags || []).map((t) => t.name);
  if (oldTag) names = names.filter((n) => n !== oldTag);
  if (newTag && !names.includes(newTag)) names.push(newTag);
  await apiUpdateBookmarkTags(bm, names);
  await fetchAllServerBookmarks();
}

/* ---- local tree helpers ---- */

async function findFolderByTitle(title, onlyToolbarParent) {
  const toolbarId = getToolbarId();
  const stack = await browser.bookmarks.getTree();
  while (stack.length) {
    const n = stack.pop();
    if (!n.url && n.title === title) {
      if (!onlyToolbarParent || n.parentId === toolbarId) return n;
    }
    if (n.children) stack.push(...n.children);
  }
  return null;
}

async function getTrashFolder() {
  const existing = await findFolderByTitle(TRASH_TITLE, false);
  if (existing) return existing;
  let lastErr = null;
  for (const parentId of trashParentCandidates()) {
    try {
      const created = await browser.bookmarks.create({ title: TRASH_TITLE, parentId });
      await syncLog(`Trash folder created under ${parentId}`);
      return created;
    } catch (e) {
      lastErr = e;
      await syncLog(`Trash create under ${parentId} failed: ${(e && e.message) || e}, trying next`);
    }
  }
  throw lastErr || new Error("Could not create trash folder anywhere");
}

async function isIgnoredId(parentId) {
  try {
    const [parent] = await browser.bookmarks.get(parentId);
    if (!parent) return true;
    // Only the trash folder is ignored. Tags may start with "." (e.g. ".net").
    return parent.title === TRASH_TITLE;
  } catch {
    return true;
  }
}

/* Tag of a bookmark = immediate parent folder name, unless the parent is the
 * toolbar itself (untagged) or an ignored dot-folder. Returns null for
 * untagged, undefined for ignored. */
async function parentTagName(parentId) {
  if (parentId === getToolbarId()) return null;
  try {
    const [parent] = await browser.bookmarks.get(parentId);
    if (!parent || parent.url) return null;
    const t = parent.title || "";
    if (t === TRASH_TITLE) return undefined; // ignored trash subtree
    return t || null;
  } catch {
    return null;
  }
}

async function getTagFolder(tag) {
  const existing = await findFolderByTitle(tag, true);
  if (existing) return existing;
  try {
    return await browser.bookmarks.create({ title: tag, parentId: getToolbarId() });
  } catch (e) {
    await syncLog(`Tag folder "${tag}" create under toolbar failed, trying unfiled: ${(e && e.message) || e}`);
    const fallback = isFirefox() ? "unfiled_____" : "2";
    return await browser.bookmarks.create({ title: tag, parentId: fallback });
  }
}

function walkBookmarks(nodes, out) {
  for (const n of nodes) {
    if (n.url) {
      out.push(n);
    } else if (n.title === TRASH_TITLE) {
      continue; // skip trash subtree entirely
    }
    if (n.children) walkBookmarks(n.children, out);
  }
  return out;
}

async function listManagedLocal() {
  const tree = await browser.bookmarks.getTree();
  return walkBookmarks(tree, []);
}

/* ---- blocklist (local deletes) ---- */

async function getBlocklist() {
  const { locallyDeleted = [] } = await browser.storage.local.get("locallyDeleted");
  return locallyDeleted;
}

async function addToBlocklist(url, tag) {
  const list = await getBlocklist();
  const k = blockKey(url, tag);
  if (!list.some((e) => blockKey(e.url, e.tag) === k)) {
    list.push({ url: normUrl(url), tag: tag || null, removedAt: new Date().toISOString() });
    await browser.storage.local.set({ locallyDeleted: list });
  }
}

async function removeFromBlocklist(url, tag) {
  const list = await getBlocklist();
  const k = blockKey(url, tag);
  const next = list.filter((e) => blockKey(e.url, e.tag) !== k);
  if (next.length !== list.length) await browser.storage.local.set({ locallyDeleted: next });
}

function isBlocked(list, url, tag) {
  const k = blockKey(url, tag);
  return list.some((e) => blockKey(e.url, e.tag) === k);
}

function isBlockedUrl(list, url) {
  const u = normUrl(url);
  return list.some((e) => normUrl(e.url) === u);
}

/* ---- sync down: Shiori -> browser ---- */

async function syncDown() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  await syncLog("Sync start");
  try {
    const serverBms = await fetchAllServerBookmarks();
    await syncLog(`Fetched ${serverBms.length} bookmarks from server`);
    const blocklist = await getBlocklist();
    const trash = await getTrashFolder();
    const toolbarId = getToolbarId();

    // Desired: one entry per (url, tag). Null tag = plainly in toolbar.
    const desired = new Map(); // blockKey -> {url, title, tag}
    for (const bm of serverBms) {
      if (!bm.url) continue;
      const tags = (bm.tags || []).map((t) => t.name).filter(Boolean);
      if (tags.length === 0) {
        if (!isBlocked(blocklist, bm.url, null)) {
          desired.set(blockKey(bm.url, null), { url: bm.url, title: bm.title || bm.url, tag: null });
        }
      } else {
        for (const tag of tags) {
          if (!isBlocked(blocklist, bm.url, tag)) {
            desired.set(blockKey(bm.url, tag), { url: bm.url, title: bm.title || bm.url, tag });
          }
        }
      }
    }

    const local = await listManagedLocal();
    await syncLog(`Local managed bookmarks: ${local.length}, desired: ${desired.size}`);
    const localByKey = new Map();
    const dupes = [];
    for (const n of local) {
      if (!n.url) continue;
      const tag = await parentTagName(n.parentId);
      if (tag === undefined) continue;
      const k = blockKey(n.url, tag);
      if (!localByKey.has(k)) localByKey.set(k, n);
      else dupes.push(n);
    }
    const trashDupes = async () => {
      let n = 0;
      for (const node of dupes) {
        await browser.bookmarks.move(node.id, { parentId: trash.id }).catch(async () => {
          await browser.bookmarks.remove(node.id).catch(() => {});
        });
        n += 1;
      }
      if (n) await syncLog(`Cleaned ${n} duplicate copies`);
      return n;
    };

    let created = 0;
    let trashed = 0;
    let retitled = 0;
    let uploaded = 0;

    // URLs ever seen on server: distinguishes portal deletes from local-only.
    const { knownUrls = [] } = await browser.storage.local.get("knownUrls");
    const knownBefore = new Set(knownUrls.map(normUrl));

    // Prune blocklist entries whose URL vanished from server (real delete in portal).
    const serverUrls = new Set(serverBms.map((b) => normUrl(b.url)));
    const pruned = blocklist.filter((e) => serverUrls.has(normUrl(e.url)));
    if (pruned.length !== blocklist.length) {
      await browser.storage.local.set({ locallyDeleted: pruned });
      await syncLog(`Unblocked ${blocklist.length - pruned.length} (deleted in portal)`);
    }

    for (const [key, d] of desired) {
      const node = localByKey.get(key);
      if (!node) {
        const parentId = d.tag ? (await getTagFolder(d.tag)).id : toolbarId;
        await browser.bookmarks.create({ url: normUrl(d.url), title: d.title, parentId });
        created += 1;
      } else if ((node.title || "") !== d.title && d.title) {
        await browser.bookmarks.update(node.id, { title: d.title }).catch(() => {});
        retitled += 1;
      }
    }

    for (const [key, node] of localByKey) {
      if (desired.has(key)) continue;
      const tag = await parentTagName(node.parentId);
      if (tag === undefined || isBlocked(pruned, node.url, tag)) continue;
      if (knownBefore.has(normUrl(node.url))) {
        // Was on server before, gone now = real delete in portal -> stash in trash.
        await browser.bookmarks.move(node.id, { parentId: trash.id }).catch(async () => {
          await browser.bookmarks.remove(node.id).catch(() => {});
        });
        trashed += 1;
      } else {
        // Never seen on server = local-only bookmark -> upload it.
        try {
          await apiCreateBookmark(node.url, node.title, tag);
          uploaded += 1;
        } catch (e) {
          await syncLog(`Upload failed for ${node.url}: ${(e && e.message) || e}`);
        }
      }
    }

    // Remember every URL seen on server, for portal-delete detection.
    const knownNow = new Set([...knownBefore, ...serverUrls]);
    await browser.storage.local.set({ knownUrls: [...knownNow].slice(-5000) });

    await browser.storage.local.set({ lastSync: new Date().toISOString(), lastSyncError: "" });
    const deduped = await trashDupes();
    await syncLog(`Sync done: +${created} created, ~${retitled} retitled, ${trashed} trashed, ^${uploaded} uploaded, =${deduped} duplicates cleaned, total ${serverBms.length}`);
    return { created, trashed, retitled, uploaded, deduped, total: serverBms.length };
  } catch (e) {
    const msg = String((e && e.message) || e);
    await syncLog(`Sync FAILED: ${msg}`);
    await browser.storage.local.set({ lastSyncError: msg });
    throw e;
  } finally {
    isSyncing = false;
  }
}

/* Setup on login: stash everything pre-existing into trash, then sync down. */
async function setupSync() {
  if (isSyncing) return { skipped: true };
  isSyncing = true;
  await syncLog("Setup start (login): stashing existing bookmarks into trash");
  try {
    const trash = await getTrashFolder();
    const tree = await browser.bookmarks.getTree();
    let stashed = 0;
    const stashTop = async (nodes) => {
      for (const n of nodes) {
        if (n.id === trash.id) continue;
        if (!n.url && n.title === TRASH_TITLE) continue;
        if (!n.parentId) continue; // root itself
        // Only move top-most managed nodes; children ride along.
        await browser.bookmarks.move(n.id, { parentId: trash.id }).catch(() => {});
        stashed += 1;
      }
    };
    for (const root of tree) {
      for (const sys of root.children || []) {
        if (sys.id === trash.id) continue;
        if (!sys.url && sys.title === TRASH_TITLE) continue;
        await stashTop(sys.children || []);
      }
    }
    await syncLog(`Setup: stashed ${stashed} items into trash`);
  } finally {
    isSyncing = false;
  }
  return syncDown();
}

/* ---- sync up: browser -> Shiori (no delete propagation) ---- */

async function handleCreated(id, node) {
  if (isSyncing || !node.url) return;
  const tag = await parentTagName(node.parentId);
  if (tag === undefined) return; // trash/ignored
  await removeFromBlocklist(node.url, tag); // re-adding unblocks
  try {
    let bm = serverIndex.get(normUrl(node.url));
    if (!bm) {
      await fetchAllServerBookmarks();
      bm = serverIndex.get(normUrl(node.url));
    }
    if (!bm) {
      await syncLog(`New local bookmark, creating${tag ? ` with tag ${tag}` : " untagged"}: ${node.url}`);
      await apiCreateBookmark(node.url, node.title, tag);
      await fetchAllServerBookmarks();
    } else if (tag) {
      await apiAddTag(node.url, tag);
    }
  } catch (e) {
    await syncLog(`Push create failed for ${node.url}: ${(e && e.message) || e}`);
  }
}

async function handleRemoved(id, removeInfo) {
  if (isSyncing) return;
  const node = removeInfo.node;
  if (!node || !node.url) return;
  const tag = await parentTagName(removeInfo.parentId).catch(() => null);
  if (tag === undefined) return;
  // Local-only delete: remember, do NOT call server DELETE.
  await addToBlocklist(node.url, tag);
  await syncLog(`Local delete, kept on server: ${node.url} [${tag || "untagged"}]`);
}

async function handleMoved(id, moveInfo) {
  if (isSyncing) return;
  let node;
  try {
    [node] = await browser.bookmarks.get(id);
  } catch { return; }
  if (!node || !node.url) return; // folder moves ignored
  const oldTag = await parentTagName(moveInfo.oldParentId).catch(() => null);
  const newTag = await parentTagName(moveInfo.parentId).catch(() => null);
  if (newTag === undefined) {
    if (oldTag !== undefined) {
      await addToBlocklist(node.url, oldTag);
      await syncLog(`Moved to trash/ignored, kept on server: ${node.url}`);
    }
    return;
  }
  if (oldTag === undefined) {
    await removeFromBlocklist(node.url, newTag);
    await syncLog(`Restored from trash: ${node.url}`);
    return;
  }
  if (oldTag === newTag) return;
  await removeFromBlocklist(node.url, newTag);
  try {
    await syncLog(`Retag ${node.url}: ${oldTag || "untagged"} -> ${newTag || "untagged"}`);
    await apiRetag(node.url, oldTag, newTag);
  } catch (e) {
    await syncLog(`Retag failed for ${node.url}: ${(e && e.message) || e}`);
  }
}

async function handleChanged(id, changeInfo) {
  if (isSyncing || !changeInfo.title) return;
  let node;
  try {
    [node] = await browser.bookmarks.get(id);
  } catch { return; }
  if (!node || !node.url) return;
  if (await isIgnoredId(node.parentId)) return;
  try {
    let bm = serverIndex.get(normUrl(node.url));
    if (!bm) {
      await fetchAllServerBookmarks();
      bm = serverIndex.get(normUrl(node.url));
    }
    if (bm && bm.title !== changeInfo.title) {
      const config = await getExtensionConfig();
      const apiURL = new URL(`${srvBase(config.server)}api/bookmarks`).toString();
      const res = await fetch(apiURL, {
        method: "PUT",
        body: JSON.stringify({ ...bm, title: changeInfo.title }),
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.token}` },
      });
      if (!res.ok) throw new Error(await res.text());
      await syncLog(`Renamed on server: ${node.url}`);
    }
  } catch (e) {
    await syncLog(`Push rename failed for ${node.url}: ${(e && e.message) || e}`);
  }
}

async function ensureAlarm() {
  try {
    await browser.alarms.create(SYNC_ALARM, { periodInMinutes: SYNC_INTERVAL_MIN });
  } catch { /* alarms unavailable in some contexts */ }
}

browser.bookmarks.onCreated.addListener(handleCreated);
browser.bookmarks.onRemoved.addListener(handleRemoved);
browser.bookmarks.onMoved.addListener(handleMoved);
browser.bookmarks.onChanged.addListener(handleChanged);

if (browser.alarms && browser.alarms.onAlarm) {
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SYNC_ALARM) syncDown().catch(() => {});
  });
}

browser.runtime.onMessage.addListener((request) => {
  switch (request.type) {
    case "check-config":
      return getExtensionConfigSafe();
    case "check-health":
      return checkServerHealth(request.server, request.token);
    case "sync-now":
      return syncDown();
    case "setup-sync":
      return setupSync();
    case "get-log": {
      return (async () => {
        const { syncLog: log = [] } = await browser.storage.local.get("syncLog");
        return log;
      })();
    }
    case "clear-log":
      return browser.storage.local.set({ syncLog: [] });
    case "get-sync-status": {
      return (async () => {
        const { lastSync = null, locallyDeleted = [], lastSyncError = "" } = await browser.storage.local.get(["lastSync", "locallyDeleted", "lastSyncError"]);
        return { lastSync, intervalMin: SYNC_INTERVAL_MIN, blocked: locallyDeleted.length, lastSyncError };
      })();
    }
    case "blocklist-list":
      return getBlocklist();
    case "blocklist-remove":
      return removeFromBlocklist(request.url, request.tag);
    case "blocklist-clear":
      return browser.storage.local.set({ locallyDeleted: [] });
    case "blocklist-add":
      return addToBlocklist(request.url, request.tag);
    case "open-libraries":
      return (async () => {
        const config = await getExtensionConfig();
        return browser.tabs.create({ active: true, url: config.server });
      })();
    default:
      return Promise.resolve();
  }
});

browser.runtime.onStartup.addListener(async () => { await ensureAlarm(); });
browser.runtime.onInstalled.addListener(async () => { await ensureAlarm(); });
ensureAlarm();
