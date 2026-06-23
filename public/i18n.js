// Лёгкая i18n. Английский по умолчанию.
const I18N = {
  en: {
    brand_sub: "Chat · Group video calls · Screen share",
    tab_login: "Sign in", tab_register: "Sign up",
    ph_login: "Username", ph_password: "Password",
    ph_name: "Display name", ph_login_hint: "Username (a–z, 3–24)",
    ph_password_hint: "Password (6+ chars)", ph_password2: "Repeat password",
    ph_room: "Room (e.g. team)", ph_message: "Write a message…",
    btn_login: "Sign in", btn_register: "Create account",
    btn_join_room: "Enter room", btn_logout: "Log out",
    err_login_failed: "Sign in failed", err_register_failed: "Sign up failed",
    err_pass_mismatch: "Passwords don't match",
    welcome_hi: "Hi",
    members_title: "Members", room_sub: "room", alone: "You're alone here",
    recent_rooms: "Recent", favorite_rooms: "Favorites",
    back: "Back", you_suffix: "(you)",
    call_btn: "📹 Call", leave_btn: "✕ Leave",
    sys_joined: "{name} joined", sys_left: "{name} left",
    typing_one: "{name} is typing…", typing_many: "{names} are typing…",
    prev_messages: "— previous messages —",
    toast_started: "started a group call", toast_join: "Join",
    conn_reconnect: "Reconnecting…", conn_offline: "No connection — reconnecting…",
    file_too_big: "File is over 20 MB — too large to send.",
    viewer_join: "\n\nJoin the call without camera and mic (watch and listen only)?",
    err_insecure: "Browser blocked camera/mic.\nOpen the site in a normal Chrome or Firefox (not an embedded preview).",
    err_denied: "Camera/mic access denied.\nClick the 🔒/camera icon in the address bar, allow access and reload.",
    err_notfound: "No camera or microphone found.",
    err_inuse: "Camera/mic is used by another app (close Zoom/Meet/etc and retry).",
    err_media: "Couldn't get camera/mic: ",
    t_emoji: "Emoji", t_attach: "Photo / video / gif", t_send: "Send",
    t_mic: "Microphone", t_cam: "Camera", t_screen: "Share screen",
    t_hangup: "Leave call", t_call: "Group video call", t_window: "Window / fullscreen",
    call_label: "Call", mute_user: "Mute", unmute_user: "Unmute", volume: "Volume",
    fav_add: "Add to favorites", fav_remove: "Remove from favorites",
    mute_room: "Mute room", unmute_room: "Unmute room",
    dms_title: "Direct messages", dm_open: "message", dm_self: "you",
    dm_ping: "{name} messaged you", room_sub_dm: "direct message",
  },
  ru: {
    brand_sub: "Чат · Групповые видеозвонки · Демонстрация экрана",
    tab_login: "Вход", tab_register: "Регистрация",
    ph_login: "Логин", ph_password: "Пароль",
    ph_name: "Отображаемое имя", ph_login_hint: "Логин (латиница, 3–24)",
    ph_password_hint: "Пароль (от 6 символов)", ph_password2: "Повторите пароль",
    ph_room: "Комната (например: team)", ph_message: "Напишите сообщение…",
    btn_login: "Войти", btn_register: "Создать аккаунт",
    btn_join_room: "Войти в комнату", btn_logout: "Выйти из аккаунта",
    err_login_failed: "Ошибка входа", err_register_failed: "Ошибка регистрации",
    err_pass_mismatch: "Пароли не совпадают",
    welcome_hi: "Привет",
    members_title: "Участники", room_sub: "комната", alone: "Пока вы один",
    recent_rooms: "Недавние", favorite_rooms: "Избранные",
    back: "Назад", you_suffix: "(вы)",
    call_btn: "📹 Звонок", leave_btn: "✕ Выйти",
    sys_joined: "{name} вошёл в чат", sys_left: "{name} вышел из чата",
    typing_one: "{name} печатает…", typing_many: "{names} печатают…",
    prev_messages: "— предыдущие сообщения —",
    toast_started: "начал групповой звонок", toast_join: "Войти",
    conn_reconnect: "Переподключение…", conn_offline: "Нет связи — переподключаемся…",
    file_too_big: "Файл больше 20 МБ — слишком тяжёлый для отправки.",
    viewer_join: "\n\nВойти в звонок без камеры и микрофона (только смотреть и слышать других)?",
    err_insecure: "Браузер не даёт доступ к камере/микрофону.\nОткрой сайт в обычном Chrome или Firefox (не во встроенном превью).",
    err_denied: "Доступ к камере/микрофону запрещён.\nНажми на 🔒/значок камеры в адресной строке, разреши доступ и обнови страницу.",
    err_notfound: "Камера или микрофон не найдены.",
    err_inuse: "Камера/микрофон заняты другим приложением (закрой Zoom/Meet/др. и попробуй снова).",
    err_media: "Не удалось получить камеру/микрофон: ",
    t_emoji: "Эмодзи", t_attach: "Фото / видео / гиф", t_send: "Отправить",
    t_mic: "Микрофон", t_cam: "Камера", t_screen: "Демонстрация экрана",
    t_hangup: "Выйти из звонка", t_call: "Групповой видеозвонок", t_window: "Окно / весь экран",
    call_label: "Звонок", mute_user: "Заглушить", unmute_user: "Включить звук", volume: "Громкость",
    fav_add: "В избранное", fav_remove: "Убрать из избранного",
    mute_room: "Заглушить комнату", unmute_room: "Включить уведомления",
    dms_title: "Личные сообщения", dm_open: "написать", dm_self: "вы",
    dm_ping: "{name} написал вам", room_sub_dm: "личные сообщения",
  },
};

let lang = localStorage.getItem("dialog_lang") || "en";

function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) || I18N.en[key] || key;
  if (vars) for (const k in vars) s = s.replaceAll("{" + k + "}", vars[k]);
  return s;
}

function applyI18n(root) {
  root = root || document;
  root.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
  root.querySelectorAll("[data-i18n-ph]").forEach((el) => (el.placeholder = t(el.dataset.i18nPh)));
  root.querySelectorAll("[data-i18n-title]").forEach((el) => (el.title = t(el.dataset.i18nTitle)));
  document.documentElement.lang = lang;
}

function setLang(l) {
  lang = l;
  localStorage.setItem("dialog_lang", l);
  applyI18n();
  window.dispatchEvent(new Event("langchange"));
}

window.t = t;
window.applyI18n = applyI18n;
window.setLang = setLang;
window.getLang = () => lang;
