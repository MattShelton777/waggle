// §4.4 independence: who counts as one voice.

/** Common free/personal mailbox providers. Extend via config as needed. */
export const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "zoho.com",
  "yandex.com",
  "fastmail.com",
  "hey.com",
  "tutanota.com",
  "qq.com",
  "163.com",
]);

export function emailDomain(email: string): string {
  const at = email.lastIndexOf("@");
  return (at >= 0 ? email.slice(at + 1) : email).trim().toLowerCase();
}

export function isPersonalDomain(domain: string): boolean {
  return PERSONAL_EMAIL_DOMAINS.has(domain.toLowerCase());
}

/** Work domains share one voice; personal-domain accounts are each their own. */
export function voiceKey(subscriberId: string, domain: string): string {
  return isPersonalDomain(domain) ? `acct:${subscriberId}` : `domain:${domain.toLowerCase()}`;
}
