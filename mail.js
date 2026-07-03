// Transactional email via Resend (https://resend.com), using the plain REST API
// (no SDK needed — Node 18+ global fetch). Guarded by RESEND_API_KEY: if it's
// unset, sending is a no-op so registration keeps working before mail is wired.
const KEY = process.env.RESEND_API_KEY || "";
const FROM = process.env.MAIL_FROM || "Dialog <noreply@dialogmsg.xyz>";

export const mailEnabled = () => !!KEY;

async function send(to, subject, html) {
  if (!KEY) { console.warn("[mail] RESEND_API_KEY unset — skipping email to", to); return { skipped: true }; }
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: "Bearer " + KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [to], subject, html })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error("Resend " + res.status + ": " + body.slice(0, 300));
  }
  return res.json();
}

// Minimal branded, dark-themed email shell (inline styles — email clients ignore <style>).
function shell(heading, intro, ctaText, ctaUrl, footer) {
  return `<div style="background:#050b06;padding:32px 0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
  <div style="max-width:480px;margin:0 auto;background:#0b140d;border:1px solid #1c3324;border-radius:16px;overflow:hidden">
    <div style="padding:26px 28px 8px">
      <div style="color:#2ec96b;font-weight:800;font-size:20px;letter-spacing:.5px">Dialog</div>
    </div>
    <div style="padding:8px 28px 24px;color:#d6e6dc">
      <h1 style="font-size:19px;margin:12px 0 6px;color:#fff">${heading}</h1>
      <p style="font-size:14px;line-height:1.5;color:#a9c2b3;margin:0 0 20px">${intro}</p>
      <a href="${ctaUrl}" style="display:inline-block;background:#2ec96b;color:#04180c;text-decoration:none;font-weight:700;font-size:14px;padding:12px 22px;border-radius:10px">${ctaText}</a>
      <p style="font-size:12px;line-height:1.5;color:#6f8a7b;margin:22px 0 0">Or paste this link into your browser:<br><span style="color:#8fb3a0;word-break:break-all">${ctaUrl}</span></p>
      <p style="font-size:12px;color:#6f8a7b;margin:18px 0 0">${footer}</p>
    </div>
  </div>
  <p style="text-align:center;color:#4c6355;font-size:11px;margin:16px 0 0">dialogmsg.xyz</p>
</div>`;
}

export function sendVerifyEmail(to, name, link) {
  return send(
    to,
    "Verify your Dialog account",
    shell(
      "Confirm your email",
      `Hi ${escapeHtml(name)}, confirm this address to secure your Dialog account and enable password recovery.`,
      "Verify email",
      link,
      "This link expires in 24 hours. If you didn't create a Dialog account, you can ignore this email."
    )
  );
}

export function sendWelcomeEmail(to, name) {
  const feat = (title, body) =>
    `<tr><td style="padding:10px 0;border-bottom:1px solid #10241a;">
       <div style="color:#57e08d;font-weight:700;font-size:14px;">${title}</div>
       <div style="color:#a9c2b3;font-size:13px;line-height:1.5;margin-top:2px;">${body}</div>
     </td></tr>`;
  const html = `<div style="background:#050b06;padding:32px 0;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
    <div style="max-width:480px;margin:0 auto;background:#0b140d;border:1px solid #1c3324;border-radius:16px;overflow:hidden">
      <div style="padding:26px 28px 6px"><div style="color:#2ec96b;font-weight:800;font-size:20px">◈ Dialog</div></div>
      <div style="padding:6px 28px 26px;color:#d6e6dc">
        <h1 style="font-size:20px;margin:12px 0 6px;color:#fff">Welcome, ${escapeHtml(name)} 👋</h1>
        <p style="font-size:14px;line-height:1.6;color:#a9c2b3;margin:0 0 16px">
          Your Dialog account is ready. Here's what you can do:
        </p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${feat("💬 Chat", "Direct messages and group chats with reactions, edits, replies, voice notes, GIFs and file sharing.")}
          ${feat("📞 Group calls", "Crystal-clear group voice &amp; video calls — jump in with one tap.")}
          ${feat("🖥 Screen sharing", "Share your screen in a call to present, pair or game together.")}
          ${feat("🧑‍🤝‍🧑 Friends &amp; groups", "Add friends, create groups and invite people with a link.")}
          ${feat("🖥 Everywhere", "Use it in your browser, or install the desktop &amp; Android apps — everything stays in sync.")}
        </table>
        <div style="margin-top:22px">
          <a href="https://dialogmsg.xyz/login" style="display:inline-block;background:#2ec96b;color:#04180c;text-decoration:none;font-weight:700;font-size:14px;padding:12px 24px;border-radius:10px">Open Dialog</a>
        </div>
        <p style="font-size:12px;color:#6f8a7b;margin:22px 0 0">Tip: verify your email (check for our verification message) so you can always recover your account.</p>
      </div>
    </div>
    <p style="text-align:center;color:#4c6355;font-size:11px;margin:16px 0 0">dialogmsg.xyz</p>
  </div>`;
  return send(to, "Welcome to Dialog 🎉", html);
}

export function sendResetEmail(to, name, link) {
  return send(
    to,
    "Reset your Dialog password",
    shell(
      "Reset your password",
      `Hi ${escapeHtml(name)}, we received a request to reset your Dialog password.`,
      "Reset password",
      link,
      "This link expires in 1 hour. If you didn't request this, ignore this email — your password stays unchanged."
    )
  );
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
