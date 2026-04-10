import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

type Env = {
  MCP_OBJECT: DurableObjectNamespace;
  GOOGLE_API_KEY?: string;
  GOOGLE_SERVICE_ACCOUNT_JSON?: string;
};

type ServiceAccount = {
  client_email: string;
  private_key: string;
  token_uri?: string;
};

function base64UrlEncode(input: string | ArrayBuffer) {
  const bytes =
    typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);

  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);

  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function signRS256(privateKeyPem: string, data: string) {
  const pem = privateKeyPem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\n/g, "");

  const keyBytes = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes.buffer,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["sign"]
  );

  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(data)
  );

  return base64UrlEncode(signature);
}

async function getServiceAccountAccessToken(saJson: string | ServiceAccount) {
  const sa =
    typeof saJson === "string" ? (JSON.parse(saJson) as ServiceAccount) : saJson;

  if (!sa.client_email || !sa.private_key) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON inválido");
  }

  const now = Math.floor(Date.now() / 1000);

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const claimSet = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/spreadsheets.readonly",
    aud: sa.token_uri || "https://oauth2.googleapis.com/token",
    exp: now + 3600,
    iat: now,
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
  const signingInput = `${encodedHeader}.${encodedClaimSet}`;
  const signature = await signRS256(sa.private_key, signingInput);
  const jwt = `${signingInput}.${signature}`;

  const tokenRes = await fetch(sa.token_uri || "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`Falha ao obter token da service account: ${tokenRes.status} ${text}`);
  }

  const tokenData = (await tokenRes.json()) as { access_token?: string };
  if (!tokenData.access_token) {
    throw new Error("Token de acesso não retornado pelo Google");
  }

  return tokenData.access_token;
}

async function fetchSheetWithServiceAccount(
  saJson: string,
  spreadsheetId: string,
  range: string
) {
  const accessToken = await getServiceAccountAccessToken(saJson);

  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  return res;
}

async function fetchSheetWithApiKey(
  apiKey: string,
  spreadsheetId: string,
  range: string
) {
  const url =
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}` +
    `/values/${encodeURIComponent(range)}?key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url);
  return res;
}

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({
    name: "Google Sheets Reader",
    version: "1.1.0",
  });

  async init() {
    this.server.tool(
      "read_sheet",
      {
        spreadsheetId: z.string().describe("ID da planilha Google Sheets"),
        range: z.string().optional().describe("Intervalo A1, ex: polls!A1:Z20"),
      },
      async ({ spreadsheetId, range }) => {
        const targetRange = range?.trim() || "A:Z";

        let res: Response | null = null;
        let modeUsed = "";
        let errors: string[] = [];

        if (this.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
          try {
            res = await fetchSheetWithServiceAccount(
              this.env.GOOGLE_SERVICE_ACCOUNT_JSON,
              spreadsheetId,
              targetRange
            );

            if (res.ok) {
              modeUsed = "service_account";
            } else {
              errors.push(`service_account: ${res.status} ${await res.text()}`);
              res = null;
            }
          } catch (err) {
            errors.push(
              `service_account: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        if (!res && this.env.GOOGLE_API_KEY) {
          try {
            res = await fetchSheetWithApiKey(
              this.env.GOOGLE_API_KEY,
              spreadsheetId,
              targetRange
            );

            if (res.ok) {
              modeUsed = "api_key";
            } else {
              errors.push(`api_key: ${res.status} ${await res.text()}`);
              res = null;
            }
          } catch (err) {
            errors.push(`api_key: ${err instanceof Error ? err.message : String(err)}`);
          }
        }

        if (!res) {
          return {
            content: [
              {
                type: "text",
                text:
                  "Falha ao ler a planilha.\n\n" +
                  "Tentativas:\n" +
                  errors.map((e) => `- ${e}`).join("\n"),
              },
            ],
          };
        }

        const data = (await res.json()) as {
          range?: string;
          values?: string[][];
        };

        const values = Array.isArray(data.values) ? data.values : [];

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  auth_mode: modeUsed,
                  range: data.range || targetRange,
                  rows: values.length,
                  values,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};
