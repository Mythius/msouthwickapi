import { Hono } from "hono";
import type { Session } from "./tools/auth.ts";
// import { exposePrismaCRUD } from "./tools/prisma.ts";
import { handleFileUpload } from "./tools/fileUpload.ts";

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

    const ollamaData = await ollamaRes.json() as { response: string };
    try {
      const parsed = JSON.parse(ollamaData.response);
      return c.json(parsed);
    } catch {
      return c.json({ error: "Failed to parse model response", raw: ollamaData.response }, 500);
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
        format: "text",
        prompt: decodedText
      })
    })
    if(!ollamaRes.ok) {
      return c.json({ error: "Ollama request failed" }, 502);
    }
    const ollamaData = await ollamaRes.json() as { response: string };
    return c.json(ollamaData);
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
