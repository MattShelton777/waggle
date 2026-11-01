// Newsletter subscriber checks (§7.1). Only active subscribers can connect.
// beehiiv is the platform (publication "The Superproductive Newsletter").

export interface SubscriberLookup {
  active: boolean;
  /** When they subscribed; tenure for probation counts from here. */
  subscribedAt: Date | null;
}

export interface NewsletterProvider {
  lookup(email: string): Promise<SubscriberLookup>;
}

/**
 * beehiiv API v2: GET /publications/{publicationId}/subscriptions/by_email/{email}.
 * Verify the endpoint and response shape against beehiiv's API reference before launch.
 */
export function beehiivProvider(apiKey: string, publicationId: string, fetchImpl: typeof fetch = fetch): NewsletterProvider {
  return {
    async lookup(email) {
      const url = `https://api.beehiiv.com/v2/publications/${encodeURIComponent(publicationId)}/subscriptions/by_email/${encodeURIComponent(email.trim().toLowerCase())}`;
      const res = await fetchImpl(url, { headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" } });
      if (res.status === 404) return { active: false, subscribedAt: null };
      if (!res.ok) throw new Error(`beehiiv lookup failed: ${res.status}`);
      const body = (await res.json()) as { data?: { status?: string; created?: number } };
      const status = body.data?.status;
      return {
        active: status === "active",
        subscribedAt: typeof body.data?.created === "number" ? new Date(body.data.created * 1000) : null,
      };
    },
  };
}
