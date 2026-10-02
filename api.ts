import { Hono } from "hono";
import type { Session } from "./tools/auth.ts";
import { prisma } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";
import { readdir } from "node:fs/promises";
import notify from "./tools/notify.ts";

const SPOTIFY_CLIENT_ID =
  process.env.SPOTIFY_CLIENT_ID || "a42e0beff7d048fb9b6643bfbaac4581";
// Must exactly match a Redirect URI in the Spotify app settings.
const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI || "https://api.msouthwick.com/spotify";
const SPOTIFY_TOKEN_FILE = "./spotify-token.json";

type SpotifyAuth = { refresh_token: string; user_id: string };
type SpotifyTokens = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
};

const pendingSpotifyStates = new Set<string>();
let spotifyAccess: { token: string; expiresAt: number } | null = null;

async function readSpotifyAuth(): Promise<SpotifyAuth | null> {
  const file = Bun.file(SPOTIFY_TOKEN_FILE);
  return (await file.exists()) ? await file.json() : null;
}

async function spotifyTokenRequest(
  params: Record<string, string>,
): Promise<SpotifyTokens> {
  if (!process.env.SPOTIFY_CLIENT_SECRET) {
    throw new Error("SPOTIFY_CLIENT_SECRET is not set in the server environment");
  }
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization:
        "Basic " +
        btoa(`${SPOTIFY_CLIENT_ID}:${process.env.SPOTIFY_CLIENT_SECRET}`),
    },
    body: new URLSearchParams(params),
  });
  if (!res.ok) {
    throw new Error(
      `Spotify token request failed (${res.status}): ${await res.text()}`,
    );
  }
  return (await res.json()) as SpotifyTokens;
}

function cacheSpotifyAccess(tokens: SpotifyTokens): string {
  // Refresh a minute early so callers never get a token about to expire.
  spotifyAccess = {
    token: tokens.access_token,
    expiresAt: Date.now() + (tokens.expires_in - 60) * 1000,
  };
  return tokens.access_token;
}

export function publicRoutes(app: Hono): void {
  app.get("/hello", (c) => c.json({ message: "Hello World" }));

  app.post("/infer-address", async (c) => {
    const { input } = await c.req.json();
    if (!input || typeof input !== "string") {
      return c.json({ error: "input string is required" }, 400);
    }

    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma2:2b",
        stream: false,
        format: "json",
        prompt: `Extract the address information and infer any unknowns from the following text and return a JSON object with exactly these keys: "address", "city", "country". If a field cannot be determined, use null. Return only valid JSON, no explanation. Also fix capitalization of city and state\n\nText: ${input}`,
      }),
    });

    if (!ollamaRes.ok) {
      return c.json({ error: "Ollama request failed" }, 502);
    }

    const ollamaData = (await ollamaRes.json()) as { response: string };
    try {
      const parsed = JSON.parse(ollamaData.response);
      return c.json(parsed);
    } catch {
      return c.json(
        { error: "Failed to parse model response", raw: ollamaData.response },
        500,
      );
    }
  });

  app.get("/any/:encodedText", async (c) => {
    const encodedText = c.req.param("encodedText");
    const decodedText = decodeURIComponent(encodedText);
    const ollamaRes = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gemma2:2b",
        stream: false,
        prompt: decodedText,
      }),
    });
    if (!ollamaRes.ok) {
      return c.json({ error: "Ollama request failed" }, 502);
    }
    const ollamaData = (await ollamaRes.json()) as { response: string };
    return c.json(ollamaData.response.trim());
  });

  app.post("/file-upload", async (c) => {
    const result = await handleFileUpload(c);
    console.log("File upload result:", result);
    return "error" in result ? c.json(result, 400) : c.json(result, 201);
  });

  app.post("/json", async (c) => {
    const data = await c.req.json();
    console.log("Received JSON:", data);
    return c.json({ received: data });
  });

  app.post("/submit-level", async (c) => {
    try {
      const { level_code, user } = await c.req.json();
      if (typeof level_code !== "string" || !level_code.trim()) {
        return c.json({ error: "level_code string is required" }, 400);
      }
      const result = await prisma.spinnylines_level_submissions.create({
        data: { level_code, user: typeof user === "string" ? user : null },
      });
      let msg = `${user || "Someone"} submitted a level on spinny lines`;
      notify(msg);
      return c.json(result, 201);
    } catch (e) {
      console.error("submit-level failed:", e);
      return c.json({ error: "Failed to submit level" }, 400);
    }
  });

  app.get("/submit-level", async (c) => {
    const data = await prisma.spinnylines_level_submissions.findMany({
      orderBy: { createdAt: "desc" },
    });
    return c.json(data);
  });

  app.get("/static-directory", async (c) => {
    try {
      const files = await readdir(
        "/home/matthias/Documents/WEBSITE/site/static",
      );
      return c.json(files);
    } catch (e) {
      console.error("static-directory failed:", e);
      return c.json({ error: "Could not read static directory" }, 500);
    }
  });

  // Visit /spotify to log in with Spotify; Spotify then redirects back here with ?code=
  app.get("/spotify", async (c) => {
    const error = c.req.query("error");
    if (error) return c.text(`Spotify login failed: ${error}`, 400);

    const code = c.req.query("code");
    if (!code) {
      const state = crypto.randomUUID();
      pendingSpotifyStates.add(state);
      setTimeout(() => pendingSpotifyStates.delete(state), 10 * 60 * 1000);
      const params = new URLSearchParams({
        client_id: SPOTIFY_CLIENT_ID,
        response_type: "code",
        redirect_uri: SPOTIFY_REDIRECT_URI,
        scope: "playlist-read-private playlist-read-collaborative user-library-read",
        state,
      });
      return c.redirect(`https://accounts.spotify.com/authorize?${params}`);
    }

    if (!pendingSpotifyStates.delete(c.req.query("state") || "")) {
      return c.text("Login expired or invalid, visit /spotify again", 400);
    }

    try {
      const tokens = await spotifyTokenRequest({
        grant_type: "authorization_code",
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      });
      const meRes = await fetch("https://api.spotify.com/v1/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (!meRes.ok) {
        throw new Error(`Spotify /me failed (${meRes.status}): ${await meRes.text()}`);
      }
      const me = (await meRes.json()) as { id: string; display_name?: string };

      // Only the first account to link can relink, so visitors can't swap in their own account.
      const existing = await readSpotifyAuth();
      if (existing && existing.user_id !== me.id) {
        return c.text(
          `Already linked to Spotify user ${existing.user_id}. Delete ${SPOTIFY_TOKEN_FILE} on the server to link a different account.`,
          403,
        );
      }

      await Bun.write(
        SPOTIFY_TOKEN_FILE,
        JSON.stringify({ refresh_token: tokens.refresh_token, user_id: me.id }),
      );
      cacheSpotifyAccess(tokens);
      return c.text(`Spotify linked to ${me.display_name || me.id}`);
    } catch (e) {
      console.error("spotify callback failed:", e);
      return c.text("Spotify login failed, check the server logs", 500);
    }
  });

  // Returns a user access token as plain text, refreshing it when it expires.
  app.get("/spotify/token", async (c) => {
    try {
      if (spotifyAccess && Date.now() < spotifyAccess.expiresAt) {
        return c.text(spotifyAccess.token);
      }
      const auth = await readSpotifyAuth();
      if (!auth) return c.text("Spotify not linked, visit /spotify", 503);

      const tokens = await spotifyTokenRequest({
        grant_type: "refresh_token",
        refresh_token: auth.refresh_token,
      });
      // Spotify sometimes rotates the refresh token; keep the newest one.
      if (tokens.refresh_token) {
        await Bun.write(
          SPOTIFY_TOKEN_FILE,
          JSON.stringify({ ...auth, refresh_token: tokens.refresh_token }),
        );
      }
      return c.text(cacheSpotifyAccess(tokens));
    } catch (e) {
      console.error("spotify token refresh failed:", e);
      return c.text("Could not get Spotify token", 500);
    }
  });
}

export function privateRoutes(app: Hono): void {
  app.get("/user", (c) => {
    const session = (c as any).get("session") as Session;
    return c.json(
      session.cas_data || session.google_data || session.microsoft_data || {},
    );
  });

  // exposePrismaCRUD("api", app);
}

export function onLogin(session: Session): void {
  console.log(
    "User logged in:",
    session.cas_data || session.google_data || session.microsoft_data,
  );
}

/* session.google_data

{
  iss: 'https://accounts.google.com',
  azp: '...',
  aud: '...',
  sub: '103589682456946370010',
  email: 'southwickmatthias@gmail.com',
  email_verified: true,
  name: 'Matthias Southwick',
  picture: 'https://lh3.googleusercontent.com/...',
  given_name: 'Matthias',
  family_name: 'Southwick',
  iat: 1723081204,
  exp: 1723084804,
}

*/
/* session.microsoft_data: {
  '@odata.context': 'https://graph.microsoft.com/v1.0/$metadata#users/$entity',
  userPrincipalName: 'Southwickmatthias@gmail.com',
  id: '4a1639e4ad5f1ca5',
  displayName: 'Matthias Southwick',
  surname: 'Southwick',
  givenName: 'Matthias',
  preferredLanguage: 'en-US',
  mail: null,
  mobilePhone: null,
  jobTitle: null,
  officeLocation: null,
  businessPhones: []
}

*/
