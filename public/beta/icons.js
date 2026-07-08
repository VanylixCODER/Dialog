/* Dialog beta — fresh open-source SVG icon set (Tabler/Phosphor-style outline,
   1.6 stroke, rounded). Replaces the old Lucide map. window.BIC + applyIcons(). */
(function () {
  const A = 'xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"';
  const s = (b) => `<svg ${A}>${b}</svg>`;
  const BIC = {
    user: s('<circle cx="12" cy="8" r="4"/><path d="M4 20a8 8 0 0 1 16 0"/>'),
    users: s('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/><path d="M16 5.5a3.2 3.2 0 0 1 0 6.2"/><path d="M17 14.4A5.5 5.5 0 0 1 20.5 20"/>'),
    lock: s('<rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/><circle cx="12" cy="15.5" r="1.3"/>'),
    eye: s('<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z"/><circle cx="12" cy="12" r="3"/>'),
    chat: s('<path d="M4 5.5h16a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 20 16.5H9l-4.5 3.5V7A1.5 1.5 0 0 1 6 5.5Z"/><path d="M8.5 10.5h7M8.5 13h4"/>'),
    users2: s('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20a5.5 5.5 0 0 1 11 0"/>'),
    palette: s('<path d="M12 3a9 9 0 1 0 0 18c1 0 1.6-.8 1.6-1.7 0-.5-.2-.8-.5-1.1-.3-.3-.5-.7-.5-1.1a1.7 1.7 0 0 1 1.7-1.7h1.9A4.3 4.3 0 0 0 21 11 8.7 8.7 0 0 0 12 3Z"/><circle cx="7.5" cy="11.5" r="1"/><circle cx="10" cy="7.5" r="1"/><circle cx="14.5" cy="7.5" r="1"/><circle cx="16.8" cy="11" r="1"/>'),
    gear: s('<circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.2M12 19.3v2.2M4.2 7l1.9 1.1M17.9 15.9l1.9 1.1M4.2 17l1.9-1.1M17.9 8.1l1.9-1.1"/>'),
    search: s('<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4-4"/>'),
    back: s('<path d="M15 5l-7 7 7 7"/>'),
    phone: s('<path d="M6.5 4h3l1.5 4-2 1.3a11 11 0 0 0 5.7 5.7l1.3-2 4 1.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 4.5 6.2 2 2 0 0 1 6.5 4Z"/>'),
    phoneOff: s('<path d="M6.5 4h3l1.5 4-2 1.3a11 11 0 0 0 3.4 4.3M20 16.5v3a2 2 0 0 1-2.2 2A16.5 16.5 0 0 1 6 16"/><path d="M3 3l18 18"/>'),
    dots: s('<circle cx="6" cy="12" r="1.4"/><circle cx="12" cy="12" r="1.4"/><circle cx="18" cy="12" r="1.4"/>'),
    clip: s('<path d="M20 11.5l-8 8a5 5 0 0 1-7-7l8.5-8.5a3.2 3.2 0 0 1 4.6 4.6L9 12.5a1.4 1.4 0 0 1-2-2l7-7"/>'),
    send: s('<path d="M4.5 12 20 4.5 15 20l-3.5-6.5L4.5 12Z"/><path d="m11.5 13.5 4-6"/>'),
    plus: s('<path d="M12 5v14M5 12h14"/>'),
    mic: s('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21"/>'),
    video: s('<rect x="3" y="6.5" width="12" height="11" rx="2.5"/><path d="m15 10.5 5.5-3v9L15 13.5"/>'),
    check: s('<path d="M4 12.5 9 17.5 20 6.5"/>'),
    x: s('<path d="M6 6l12 12M18 6 6 18"/>'),
    logout: s('<path d="M9 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h3"/><path d="m16 16 4-4-4-4M20 12H9"/>'),
    smile: s('<circle cx="12" cy="12" r="8.5"/><path d="M8.5 13.5a4 4 0 0 0 7 0"/><circle cx="9" cy="9.5" r=".6"/><circle cx="15" cy="9.5" r=".6"/>'),
    expand: s('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/>'),
    lock2: s('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    screen: s('<rect x="3" y="4.5" width="18" height="12" rx="2"/><path d="M9 20.5h6M12 16.5v4"/><path d="m10 8.5 4 2.5-4 2.5z"/>'),
    screenOff: s('<path d="M3 4.6A2 2 0 0 1 5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-.5 1.3M3.2 6.9v7.6a2 2 0 0 0 2 2H16"/><path d="M9 20.5h6M12 16.5v4"/><path d="M3 3l18 18"/>'),
    headphones: s('<path d="M4 14v-2a8 8 0 0 1 16 0v2"/><rect x="3" y="13.5" width="4" height="6.5" rx="1.6"/><rect x="17" y="13.5" width="4" height="6.5" rx="1.6"/>'),
    headphonesOff: s('<path d="M4 14v-2a8 8 0 0 1 12.5-6.6M20 12v2"/><rect x="17" y="13.5" width="4" height="6.5" rx="1.6"/><path d="M3 13.6A1.6 1.6 0 0 1 4.6 13.5H7v6.5H5.6A1.6 1.6 0 0 1 4 18.4V14"/><path d="M3 3l18 18"/>'),
    micOff: s('<path d="M9 9v-.5a3 3 0 0 1 6 0V11m0 3.5a3 3 0 0 1-4.5 1"/><path d="M5.5 11a6.5 6.5 0 0 0 10 5.4M18.5 11a6.4 6.4 0 0 1-.3 2M12 17.5V21"/><path d="M3 3l18 18"/>'),
    moon: s('<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>'),
  };
  window.BIC = BIC;
  window.applyIcons = function (root) {
    (root || document).querySelectorAll("[data-ic]").forEach((el) => {
      const name = el.getAttribute("data-ic");
      if (BIC[name] && el.dataset.icDone !== "1") { el.innerHTML = BIC[name]; el.dataset.icDone = "1"; }
    });
  };
})();
