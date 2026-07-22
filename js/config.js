// App configuration.
//
// GOOGLE_CLIENT_ID: the OAuth Client ID from your Google Cloud project
// (APIs & Services → Credentials). It is PUBLIC by design — safe to commit.
// Leave '' to hide Google Drive sync until configured; it can also be entered
// per-device in Settings, but committing it here makes every device pick it
// up automatically.
export const GOOGLE_CLIENT_ID = '96994450295-fd1njai4bpv2bq0pq01o6ht3j3t7brgh.apps.googleusercontent.com';

// Built-in TMDB API key so shared users don't need their own TMDB account.
// A key entered in Settings overrides this. Public by choice — TMDB keys are
// free; regenerate on themoviedb.org if ever abused.
export const TMDB_KEY = 'ec82ce16f5edd7bafc017aa73028f44a';
