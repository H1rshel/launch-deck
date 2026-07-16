import { createClient } from '@supabase/supabase-js'

// Supabase URL and anon key are public browser configuration. Keep the Vite
// env vars as the primary source, but include the production values here so a
// misconfigured release workflow cannot ship a blank app.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://aqoqmrcxjltwtojpgpan.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFxb3FtcmN4amx0d3RvanBncGFuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTY1MTgsImV4cCI6MjA4ODgzMjUxOH0.o-afZOvtCi40Lbre8MD7cQ1s9dAhbiLDcdzXtCeBPZg'

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    detectSessionInUrl: true,
    flowType: 'pkce',
    // Pass-through lock: supabase-js's default navigator.locks-based lock
    // can hang forever on some Android WebViews, freezing every auth call
    // (observed as signInWithOAuth never resolving on the tablet). The app
    // is a single WebView context — there are no multi-tab races the lock
    // would protect against.
    lock: async (_name, _acquireTimeout, fn) => await fn(),
  },
})
