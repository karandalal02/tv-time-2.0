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

// OMDB_KEY: built-in OMDb API key, used only to fetch an IMDb rating for the
// detail page. Same public-by-choice reasoning as TMDB_KEY — free tier,
// non-commercial use only (matches this app), regenerate at omdbapi.com if
// ever abused.
export const OMDB_KEY = '6d28344d';
