// ---------- URL Routing ----------
// Scheme: / → default | /{lang}/ → set lang | /{lang}/@{login} → DM | /{lang}/group/{id} → group

function parsePath() {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  const parts = path.split("/").filter(Boolean);
  const knownLangs = ["en", "ru"];
  let lang = null, login = null, groupId = null;
  if (parts.length >= 1 && knownLangs.includes(parts[0])) {
    lang = parts[0];
    if (parts.length >= 2 && parts[1].startsWith("@")) {
      login = parts[1].slice(1);
    } else if (parts.length >= 2 && parts[1] === "group" && parts[2]) {
      groupId = parts[2];
    }
  }
  return { lang, login, groupId };
}

function pushState() {
  const parts = [];
  const curLang = window.getLang ? window.getLang() : "en";
  parts.push(curLang);
  if (activeKey) {
    if (curKind === "dm") {
      const other = activeKey.slice(4).split("~").find((l) => l !== (profile ? profile.login : ""));
      if (other) parts.push("@" + other);
    } else if (curKind === "group") {
      const id = myRoom ? myRoom.slice(5) : "";
      if (id) { parts.push("group"); parts.push(id); }
    }
  }
  const url = "/" + parts.join("/");
  if (url !== location.pathname) history.pushState(null, "", url);
}

function onPopState() {
  const { lang, login, groupId } = parsePath();
  if (lang && window.setLang) window.setLang(lang);
  if (login && window.openDM) {
    const key = "@dm:" + [profile.login, login].sort().join("~");
    const existing = chats.get(key);
    if (existing) openChat(existing);
    else openDM(login);
  } else if (groupId && window.openChat) {
    const key = "@grp:" + groupId;
    const existing = chats.get(key);
    if (existing) openChat(existing);
  }
}
