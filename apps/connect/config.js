// Public, browser-safe configuration for the connect site. No secrets here:
// the publishable key only identifies the project; RLS and the waggle_api
// role guard the data.
window.WAGGLE_CONFIG = {
  supabaseUrl: "https://wckkmbdfqeqgrispgdbx.supabase.co",
  supabasePublishableKey: "sb_publishable_O5bjew9gqb6965mafS2E7g_l0KlHBCY",
  connectApi: "https://wckkmbdfqeqgrispgdbx.supabase.co/functions/v1/connect-api",
  // Switch to a custom domain (e.g. https://waggle.example.com/mcp) once one fronts the endpoint.
  mcpUrl: "https://wckkmbdfqeqgrispgdbx.supabase.co/functions/v1/mcp",
};
