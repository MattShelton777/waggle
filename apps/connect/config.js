// Public, browser-safe configuration for the connect site. No secrets here:
// the publishable key only identifies the project; RLS and the waggle_api
// role guard the data.
window.WAGGLE_CONFIG = {
  supabaseUrl: "https://wckkmbdfqeqgrispgdbx.supabase.co",
  supabasePublishableKey: "sb_publishable_O5bjew9gqb6965mafS2E7g_l0KlHBCY",
  connectApi: "https://wckkmbdfqeqgrispgdbx.supabase.co/functions/v1/connect-api",
  // Switch to https://waggle.superproductive.co/mcp once the custom domain is live.
  mcpUrl: "https://wckkmbdfqeqgrispgdbx.supabase.co/functions/v1/mcp",
  subscribeUrl: "https://superproductive.co",
};
