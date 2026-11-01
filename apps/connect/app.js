// Shared helpers for the connect site: Supabase client, connect-api calls, UI bits.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.118.0";

const cfg = window.WAGGLE_CONFIG;

export const supabase = createClient(cfg.supabaseUrl, cfg.supabasePublishableKey, {
  auth: { flowType: "pkce", detectSessionInUrl: true, persistSession: true },
});

export const config = cfg;

/** Call the connect-api Edge Function, with the user's session token when signed in. */
export async function api(path, { method = "POST", body } = {}) {
  const { data } = await supabase.auth.getSession();
  const headers = { "content-type": "application/json", apikey: cfg.supabasePublishableKey };
  if (data.session) headers.authorization = `Bearer ${data.session.access_token}`;
  const res = await fetch(`${cfg.connectApi}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data: json };
}

/** Send a magic link after confirming the email is an active subscriber. */
export async function sendMagicLink(email, returnTo) {
  const check = await api("/check", { body: { email } });
  if (!check.ok) return { ok: false, message: check.data.message ?? "Couldn't check that email. Try again." };
  if (!check.data.subscribed) return { ok: false, notSubscribed: true, subscribeUrl: check.data.subscribe_url ?? cfg.subscribeUrl };
  const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: returnTo } });
  if (error) return { ok: false, message: error.message };
  return { ok: true };
}

export function $(sel, root = document) {
  return root.querySelector(sel);
}

export function show(el, visible = true) {
  el.hidden = !visible;
}

export async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = label), 1600);
  } catch {
    window.prompt("Copy this:", text);
  }
}

/** Wire a sign-in form: <form> with input[type=email], a status element, and a success callback. */
export function wireSignIn(form, status, returnTo) {
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = form.querySelector("input[type=email]").value.trim();
    const button = form.querySelector("button");
    button.disabled = true;
    status.textContent = "Checking…";
    const r = await sendMagicLink(email, returnTo);
    button.disabled = false;
    if (r.ok) {
      status.innerHTML = `Check <strong>${escapeHtml(email)}</strong> for a sign-in link. Open it in this browser.`;
    } else if (r.notSubscribed) {
      status.innerHTML = `Waggle is for Superproductive subscribers. <a href="${escapeAttr(r.subscribeUrl)}">Subscribe with this email</a>, then come back.`;
    } else {
      status.textContent = r.message;
    }
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

function escapeAttr(s) {
  return /^https?:\/\//.test(s) ? escapeHtml(s) : "#";
}

export const POLICY_TEXT = {
  auto_low_risk: {
    label: "Recommended: auto-share low-risk findings",
    help: "Tool and workflow ratings and readouts on existing findings go in automatically. New findings and your first result on a tactic wait for your OK by email.",
  },
  ask_always: {
    label: "Ask me every time",
    help: "Nothing is shared until you approve it from a batched email.",
  },
  auto_all: {
    label: "Auto-share everything",
    help: "Everything your agent reports goes in automatically. Privacy checks still apply.",
  },
};

/** Render the contribution-policy radio group into a container. */
export function renderPolicy(container, current = "auto_low_risk") {
  container.innerHTML = Object.entries(POLICY_TEXT)
    .map(
      ([value, t]) => `
      <label class="option">
        <input type="radio" name="policy" value="${value}" ${value === current ? "checked" : ""} />
        <span><strong>${t.label}</strong><small>${t.help}</small></span>
      </label>`,
    )
    .join("");
  return () => container.querySelector("input[name=policy]:checked")?.value ?? "auto_low_risk";
}
