-- Seed entities (build plan §13). Canonical records only: no events, so every
-- score starts at "no evidence yet" and ratings arrive through waggle_report
-- like anyone else's. The list is reviewed in seed/candidates.md.
-- Embeddings are left null; search falls back to text matching for these rows.

with seed (type, slug, name, description, fn, sub, steps) as (
  values
  -- tools
  ('tool', 'clay', 'Clay', 'Spreadsheet-style enrichment workspace that chains many data providers and AI steps per row.', 'gtm_engineering', 'enrichment', null::text[]),
  ('tool', 'apollo', 'Apollo', 'Large B2B contact and company database with built-in sequencing.', 'sales', 'prospecting', null),
  ('tool', 'linkedin-sales-navigator', 'LinkedIn Sales Navigator', 'Advanced search and saved-lead alerts over the professional network.', 'sales', 'prospecting', null),
  ('tool', 'hunter', 'Hunter', 'Finds and verifies work emails from a domain and a person''s name.', 'gtm_engineering', 'enrichment', null),
  ('tool', 'zerobounce', 'ZeroBounce', 'Bulk email verification that flags invalid, catch-all, and risky addresses before sending.', 'email_lifecycle', 'deliverability', null),
  ('tool', 'millionverifier', 'MillionVerifier', 'Low-cost bulk email verification aimed at large lists.', 'email_lifecycle', 'deliverability', null),
  ('tool', 'instantly', 'Instantly', 'Cold email sending platform with inbox rotation and warm-up.', 'email_lifecycle', 'cold_email', null),
  ('tool', 'smartlead', 'Smartlead', 'Cold email sending platform with unlimited mailboxes and inbox rotation.', 'email_lifecycle', 'cold_email', null),
  ('tool', 'apify-google-maps-scraper', 'Apify Google Maps Scraper', 'Hosted scraper that pulls local business listings, ratings, and websites from map search results.', 'gtm_engineering', 'scraping', null),
  ('tool', 'firecrawl', 'Firecrawl', 'API that crawls a website and returns clean text for LLM processing.', 'gtm_engineering', 'scraping', null),
  ('tool', 'exa', 'Exa', 'Semantic web search API that finds companies and pages by description rather than keywords.', 'gtm_engineering', 'enrichment', null),
  ('tool', 'perplexity', 'Perplexity', 'Answer engine with cited sources, useful for quick company and market research.', 'sales', 'account_research', null),
  ('tool', 'ahrefs', 'Ahrefs', 'Backlink, keyword, and rank data for SEO research.', 'content', 'seo', null),
  ('tool', 'google-search-console', 'Google Search Console', 'First-party search impressions, clicks, and indexing status for your own site.', 'content', 'seo', null),
  ('tool', 'n8n', 'n8n', 'Self-hostable workflow automation with code steps and AI nodes.', 'gtm_engineering', 'automation_workflows', null),
  ('tool', 'zapier', 'Zapier', 'Hosted no-code automation connecting thousands of SaaS apps.', 'gtm_engineering', 'automation_workflows', null),
  ('tool', 'make', 'Make', 'Visual scenario-based automation with branching and iterators.', 'gtm_engineering', 'automation_workflows', null),
  ('tool', 'hubspot', 'HubSpot CRM', 'CRM with marketing automation, sequences, and reporting.', 'revops', 'crm_hygiene', null),
  ('tool', 'beehiiv', 'beehiiv', 'Newsletter platform with a referral program, recommendations network, and ad marketplace.', 'content', 'newsletter', null),
  ('tool', 'claude-code', 'Claude Code', 'Agentic coding assistant that can build and run GTM scripts, scrapers, and automations.', 'gtm_engineering', 'ai_agents_sdr', null),
  ('tool', 'supabase', 'Supabase', 'Hosted Postgres with auth, storage, and edge functions, used as a lead or signal store.', 'gtm_engineering', 'data_pipelines', null),
  ('tool', 'gmail-api-sequencer', 'Gmail API self-built sequencer', 'Small self-built script that sends and tracks a short sequence from a regular mailbox via the Gmail API.', 'email_lifecycle', 'cold_email', null),
  -- workflows (steps are tool slugs above)
  ('workflow', 'maps-scrape-site-enrich-trades', 'Map listings, site scrape, email find for local trades', 'Builds a contact list of owner-operated local service businesses from map listings, pulling contact details from their own websites before falling back to an email finder.', 'gtm_engineering', 'list_building', array['apify-google-maps-scraper', 'firecrawl', 'hunter', 'zerobounce']),
  ('workflow', 'enrichment-waterfall', 'Multi-provider email waterfall', 'Tries providers in order and stops at the first verified email, so cost tracks hit rate.', 'gtm_engineering', 'enrichment', array['clay', 'hunter', 'zerobounce']),
  ('workflow', 'verify-before-send', 'Verify every list before first send', 'Runs bulk verification and drops invalid and catch-all addresses before a new list enters a sequence.', 'email_lifecycle', 'deliverability', array['zerobounce', 'instantly']),
  ('workflow', 'sponsor-page-backlink-audit', 'Local sponsor-page backlink research', 'Finds local organizations that list sponsors with followed links, then ranks them by domain strength for local SEO link building.', 'content', 'seo', array['perplexity', 'ahrefs']),
  ('workflow', 'pre-call-account-research', 'Pre-call account brief', 'Agent compiles a short brief on the company, recent news, and the attendee''s role before a first call.', 'sales', 'pre_call_research', array['perplexity', 'linkedin-sales-navigator']),
  ('workflow', 'newsletter-to-linkedin-repurpose', 'Newsletter to LinkedIn post repurposing', 'Turns each newsletter issue into a few standalone LinkedIn posts with one idea each.', 'content', 'repurposing', array['beehiiv', 'claude-code']),
  ('workflow', 'signal-to-sequence', 'Intent signal, personalized first line, sequence', 'Detects a public trigger such as hiring or a launch, writes a first line referencing it, and enrolls the contact.', 'gtm_engineering', 'signal_based_outreach', array['exa', 'clay', 'smartlead']),
  -- tactics
  ('tactic', 'plain-text-short-cold-email', 'Short plain-text cold email', 'A few sentences, no images or links in the first touch, a single low-friction ask.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'pain-point-first-line', 'Pain-point first line', 'Open with a specific problem the recipient''s type of business likely has instead of a compliment or intro.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'question-subject-line', 'Question-style subject line', 'Subject line phrased as a short question relevant to the recipient''s role.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'lowercase-subject-line', 'Lowercase internal-looking subject line', 'Short lowercase subject that reads like an internal note rather than marketing.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'interest-cta-over-meeting', 'Interest CTA instead of a meeting ask', 'Ask whether it''s worth sharing more rather than asking for a call in the first email.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'breakup-final-email', 'Breakup final email', 'Last step explicitly closes the loop and invites a one-word reply.', 'email_lifecycle', 'cold_email', null),
  ('tactic', 'mailbox-rotation-low-volume', 'Low daily volume across many mailboxes', 'Spread sends across many warmed secondary-domain mailboxes at low per-mailbox volume.', 'email_lifecycle', 'deliverability', null),
  ('tactic', 'local-sponsor-backlinks', 'Local sponsorships for backlinks', 'Sponsor local teams, events, and nonprofits that link to sponsors, to build local relevance for a service site.', 'content', 'seo', null),
  ('tactic', 'lead-magnet-checklist', 'Checklist lead magnet', 'A short practical checklist offered in exchange for an email, instead of a long guide.', 'content', 'lead_magnets', null),
  ('tactic', 'newsletter-referral-program', 'Milestone referral rewards for a newsletter', 'Reward readers at a few referral milestones with digital perks.', 'content', 'newsletter', null),
  ('tactic', 'newsletter-recommendations-swap', 'Newsletter recommendation swaps', 'Cross-recommend with similar-sized newsletters at signup.', 'content', 'newsletter', null),
  ('tactic', 'founder-led-linkedin-posting', 'Founder-led LinkedIn posting cadence', 'Regular first-person posts from the founder sharing lessons, not product announcements.', 'organic_social', 'founder_led_social', null),
  ('tactic', 'annual-first-pricing-display', 'Annual-first pricing display', 'Show annual pricing as the default toggle on the pricing page.', 'sales', 'pricing_packaging', null),
  ('tactic', 'loom-video-follow-up', 'Short personalized video follow-up', 'Send a brief screen-recorded video walking through the prospect''s own site or account.', 'sales', 'follow_ups', null)
),
inserted as (
  insert into waggle.entities (type, slug, name, description, attributes, status, activated_at)
  select type, slug, name, description,
         case when steps is null then '{}'::jsonb else jsonb_build_object('workflow_steps', to_jsonb(steps)) end,
         'active', now()
  from seed
  on conflict (slug) do nothing
  returning id, slug
)
insert into waggle.entity_taxonomy (entity_id, taxonomy_id, is_primary)
select i.id, waggle.resolve_taxonomy(s.fn, s.sub), true
from inserted i join seed s using (slug);
