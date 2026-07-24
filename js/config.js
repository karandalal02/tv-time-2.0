// App configuration (client-side, public).
//
// Google sign-in is now handled by the backend (/api/auth/*), which reads the
// Google client ID + secret from Vercel environment variables — so no Google
// config lives here anymore.
//
// TMDB_KEY: built-in TMDB API key so shared users don't need their own TMDB
// account. A key entered in Settings overrides this. Public by choice — TMDB
// keys are free; regenerate on themoviedb.org if ever abused.
export const TMDB_KEY = 'ec82ce16f5edd7bafc017aa73028f44a';
