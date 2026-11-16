# Seed candidates (draft for Matt's review)

These are candidate entities for Waggle's first 25–50 findings (§13 of the build plan). The entities are only
placeholders. **The ratings have to come from your own use**: your newsletter and side projects, no employer data.
An entity with no honest rating behind it shouldn't be seeded.

**How to review:** for each row you've actually used, fill in **Your call** and a short **Why**. Leave the rest blank and I'll drop
them. Add rows for anything you rely on that's missing. Change the names, descriptions, or taxonomy freely.

- **Tools and workflows:** `flawless` · `good` · `usable` · `mostly_unhelpful` · `failed`. Add a failure mode if one fits:
  `low_coverage`, `stale_data`, `bounced`, `wrong_person`, `rate_limited`, `schema_drift`, `timeout`, `expensive`.
- **Tactics:** what it beat, as a band: `win_large` (≥30% better) · `win_moderate` · `win_small` · `no_difference` · `loss_*`.
  Also say what you compared it against, roughly how big the test was (`lt_100`, `100_1k`, `1k_5k`, `gt_5k`), and whether the metric
  was leading (opens, replies) or lagging (meetings, revenue).
- **Why:** one pattern-level sentence. No numbers, customer names, or copy. This becomes the finding's rationale, e.g.
  "Strong on owner-operated trades businesses, thin on multi-location chains."

Once you've filled it in, I'll submit each one from your account through the normal `waggle_report` path. That way each seed
goes through the same scrubbing, weighting and reputation as everyone else's.

## Tools

| slug | name | taxonomy | description | Your call | Why |
|---|---|---|---|---|---|
| clay | Clay | gtm_engineering / enrichment | Spreadsheet-style enrichment workspace that chains many data providers and AI steps per row. | | |
| apollo | Apollo | sales / prospecting | Large B2B contact and company database with built-in sequencing. | | |
| linkedin-sales-navigator | LinkedIn Sales Navigator | sales / prospecting | Advanced search and saved-lead alerts over the professional network. | | |
| hunter | Hunter | gtm_engineering / enrichment | Finds and verifies work emails from a domain and a person's name. | | |
| zerobounce | ZeroBounce | email_lifecycle / deliverability | Bulk email verification that flags invalid, catch-all, and risky addresses before sending. | | |
| millionverifier | MillionVerifier | email_lifecycle / deliverability | Low-cost bulk email verification aimed at large lists. | | |
| instantly | Instantly | email_lifecycle / cold_email | Cold email sending platform with inbox rotation and warm-up. | | |
| smartlead | Smartlead | email_lifecycle / cold_email | Cold email sending platform with unlimited mailboxes and inbox rotation. | | |
| apify-google-maps-scraper | Apify Google Maps Scraper | gtm_engineering / scraping | Hosted scraper that pulls local business listings, ratings, and websites from map search results. | | |
| firecrawl | Firecrawl | gtm_engineering / scraping | API that crawls a website and returns clean text for LLM processing. | | |
| exa | Exa | gtm_engineering / enrichment | Semantic web search API that finds companies and pages by description rather than keywords. | | |
| perplexity | Perplexity | sales / account_research | Answer engine with cited sources, useful for quick company and market research. | | |
| ahrefs | Ahrefs | content / seo | Backlink, keyword, and rank data for SEO research. | | |
| google-search-console | Google Search Console | content / seo | First-party search impressions, clicks, and indexing status for your own site. | | |
| n8n | n8n | gtm_engineering / automation_workflows | Self-hostable workflow automation with code steps and AI nodes. | | |
| zapier | Zapier | gtm_engineering / automation_workflows | Hosted no-code automation connecting thousands of SaaS apps. | | |
| make | Make | gtm_engineering / automation_workflows | Visual scenario-based automation with branching and iterators. | | |
| hubspot | HubSpot CRM | revops / crm_hygiene | CRM with marketing automation, sequences, and reporting. | | |
| beehiiv | beehiiv | content / newsletter | Newsletter platform with a referral program, recommendations network, and ad marketplace. | | |
| claude-code | Claude Code | gtm_engineering / ai_agents_sdr | Agentic coding assistant that can build and run GTM scripts, scrapers, and automations. | | |
| supabase | Supabase | gtm_engineering / data_pipelines | Hosted Postgres with auth, storage, and edge functions, used as a lead or signal store. | | |
| gmail-api-sequencer | Gmail API self-built sequencer | email_lifecycle / cold_email | Small self-built script that sends and tracks a short sequence from a regular mailbox via the Gmail API. | | |

## Workflows

The steps reference tool slugs above, so a workflow only gets seeded if its tools are kept.

| slug | name | taxonomy | steps | description | Your call | Why |
|---|---|---|---|---|---|---|
| maps-scrape-site-enrich-trades | Map listings → site scrape → email find for local trades | gtm_engineering / list_building | apify-google-maps-scraper → firecrawl → hunter → zerobounce | Builds a contact list of owner-operated local service businesses from map listings, pulling contact details from their own websites before falling back to an email finder. | | |
| enrichment-waterfall | Multi-provider email waterfall | gtm_engineering / enrichment | clay → hunter → zerobounce | Tries providers in order and stops at the first verified email, so cost tracks hit rate. | | |
| verify-before-send | Verify every list before first send | email_lifecycle / deliverability | zerobounce → instantly | Runs bulk verification and drops invalid and catch-all addresses before a new list enters a sequence. | | |
| sponsor-page-backlink-audit | Local sponsor-page backlink research | content / seo | perplexity → ahrefs | Finds local organizations that list sponsors with followed links, then ranks them by domain strength for local SEO link building. | | |
| pre-call-account-research | Pre-call account brief | sales / pre_call_research | perplexity → linkedin-sales-navigator | Agent compiles a short brief on the company, recent news, and the attendee's role before a first call. | | |
| newsletter-to-linkedin-repurpose | Newsletter → LinkedIn post repurposing | content / repurposing | beehiiv → claude-code | Turns each newsletter issue into a few standalone LinkedIn posts with one idea each. | | |
| signal-to-sequence | Intent signal → personalized first line → sequence | gtm_engineering / signal_based_outreach | exa → clay → smartlead | Detects a public trigger such as hiring or a launch, writes a first line referencing it, and enrolls the contact. | | |

## Tactics

| slug | name | taxonomy | description | Your call | Compared to | Why |
|---|---|---|---|---|---|---|
| plain-text-short-cold-email | Short plain-text cold email | email_lifecycle / cold_email | A few sentences, no images or links in the first touch, a single low-friction ask. | | | |
| pain-point-first-line | Pain-point first line | email_lifecycle / cold_email | Open with a specific problem the recipient's type of business likely has instead of a compliment or intro. | | | |
| question-subject-line | Question-style subject line | email_lifecycle / cold_email | Subject line phrased as a short question relevant to the recipient's role. | | | |
| lowercase-subject-line | Lowercase internal-looking subject line | email_lifecycle / cold_email | Short lowercase subject that reads like an internal note rather than marketing. | | | |
| interest-cta-over-meeting | Interest CTA instead of a meeting ask | email_lifecycle / cold_email | Ask whether it's worth sharing more rather than asking for a call in the first email. | | | |
| breakup-final-email | Breakup final email | email_lifecycle / cold_email | Last step explicitly closes the loop and invites a one-word reply. | | | |
| mailbox-rotation-low-volume | Low daily volume across many mailboxes | email_lifecycle / deliverability | Spread sends across many warmed secondary-domain mailboxes at low per-mailbox volume. | | | |
| local-sponsor-backlinks | Local sponsorships for backlinks | content / seo | Sponsor local teams, events, and nonprofits that link to sponsors, to build local relevance for a service site. | | | |
| lead-magnet-checklist | Checklist lead magnet | content / lead_magnets | A short practical checklist offered in exchange for an email, instead of a long guide. | | | |
| newsletter-referral-program | Milestone referral rewards for a newsletter | content / newsletter | Reward readers at a few referral milestones with digital perks. | | | |
| newsletter-recommendations-swap | Newsletter recommendation swaps | content / newsletter | Cross-recommend with similar-sized newsletters at signup. | | | |
| founder-led-linkedin-posting | Founder-led LinkedIn posting cadence | organic_social / founder_led_social | Regular first-person posts from the founder sharing lessons, not product announcements. | | | |
| annual-first-pricing-display | Annual-first pricing display | sales / pricing_packaging | Show annual pricing as the default toggle on the pricing page. | | | |
| loom-video-follow-up | Short personalized video follow-up | sales / follow_ups | Send a brief screen-recorded video walking through the prospect's own site or account. | | | |

## Coverage check

The draft has 22 tools, 7 workflows and 14 tactics: 43 in total.

That's heavy on cold email, list building and SEO, because that's where I'd expect most of your side-project evidence to be.
Paid media, customer success and analytics are empty. Add rows there only if you have real results.
