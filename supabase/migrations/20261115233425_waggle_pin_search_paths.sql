-- Pin search_path on the remaining non-definer functions (Supabase security advisor 0011).
alter function waggle.forbid_mutation() set search_path = waggle, pg_temp;
alter function waggle.check_summary_citations() set search_path = waggle, pg_temp;
alter function waggle.canonical_entity_id(uuid) set search_path = waggle, pg_temp;
