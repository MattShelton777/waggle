// Public, browser-safe configuration for the connect site. No secrets here:
// the publishable key only identifies the project; RLS and the waggle_api
// role guard the data.
window.WAGGLE_CONFIG = {
  supabaseUrl: "https://yoagtdkpsomjzauoxvxb.supabase.co",
  supabasePublishableKey: "sb_publishable_r6EQNHWo1pNXALeo29kjiQ_qm4ohjms",
  connectApi: "https://yoagtdkpsomjzauoxvxb.supabase.co/functions/v1/connect-api",
  // Switch to https://waggle.superproductive.co/mcp once the custom domain is live.
  mcpUrl: "https://yoagtdkpsomjzauoxvxb.supabase.co/functions/v1/mcp",
  subscribeUrl: "https://superproductive.co",
};
