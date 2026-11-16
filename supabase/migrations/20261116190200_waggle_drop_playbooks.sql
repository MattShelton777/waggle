-- Remove playbooks (unused; the operator asked to drop them on 2026-11-16).
-- Blueprints on tools and workflows replace them. Apply only after the MCP
-- server without waggle_playbooks is deployed.
drop function if exists waggle.api_search_playbooks(extensions.vector, text, int);
drop table if exists waggle.playbook_chunks;
drop table if exists waggle.playbooks;
